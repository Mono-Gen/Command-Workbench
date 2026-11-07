// Where the command list lives and how it is read and written safely.
// The file system is injected so failure paths (locked file, full disk) can be tested.
const crypto = require('node:crypto');
const path = require('node:path');
const { validateStore, emptyStore } = require('../core/command-store');

const DEFAULT_FILE_NAME = 'workbench-commands.json';
const MAX_FILE_BYTES = 5 * 1024 * 1024;
// Windows can briefly refuse to replace a file while antivirus or a sync client holds it.
const RETRYABLE_REPLACE_ERRORS = ['EPERM', 'EBUSY'];

// Decides the folder for the data file. There is deliberately no fallback to another folder:
// a silent change of location would make the user's commands "disappear".
// - portable build: the folder that holds the portable executable (the exe itself runs from a
//   temporary extraction folder, so its own path is useless here);
// - unpacked packaged build: the folder of the executable;
// - development run: a project-local folder.
function resolveDataDir({ env, isPackaged, exeDir, devDir }) {
  const portableDir = env.PORTABLE_EXECUTABLE_DIR;
  if (typeof portableDir === 'string' && portableDir !== '') {
    // Environment variables are mutable input; require an absolute path.
    if (!path.isAbsolute(portableDir)) {
      return { ok: false, code: 'portable_dir_not_absolute' };
    }
    return { ok: true, dir: portableDir, source: 'portable' };
  }
  if (isPackaged) {
    return { ok: true, dir: exeDir, source: 'unpacked' };
  }
  return { ok: true, dir: devDir, source: 'development' };
}

function createCommandStore({
  fs,
  dir,
  fileName = DEFAULT_FILE_NAME,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  maxAttempts = 5,
  retryDelayMs = 50,
}) {
  const filePath = path.join(dir, fileName);
  // Saving is refused until the existing file has been loaded once: saving first would
  // overwrite a file we never looked at (it might be a broken or newer-version file).
  let loaded = false;
  // When the existing file could not be read as valid data, saving would destroy it.
  let blocked = false;
  // Loads and saves share one queue, so a save can never run in the middle of a load.
  let queue = Promise.resolve();

  function enqueue(task) {
    const run = queue.then(task);
    queue = run.catch(() => {});
    return run;
  }

  async function findLeftoverTemps() {
    try {
      const names = await fs.readdir(dir);
      return names.filter((name) => name.startsWith(`${fileName}.`) && name.endsWith('.tmp'));
    } catch {
      // A missing or unreadable folder is reported by the read below, not here.
      return [];
    }
  }

  async function loadOnce() {
    const leftoverTemps = await findLeftoverTemps();
    loaded = true;
    const fail = (status, extra = {}) => {
      blocked = true;
      return { status, leftoverTemps, ...extra };
    };

    let stats;
    try {
      stats = await fs.stat(filePath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        blocked = false;
        return { status: 'missing', data: emptyStore(), leftoverTemps };
      }
      return fail('read_error', { code: 'read_failed', errno: error.code });
    }
    if (stats.size > MAX_FILE_BYTES) {
      return fail('too_large', { code: 'file_too_large' });
    }

    let text;
    try {
      text = await fs.readFile(filePath, 'utf8');
    } catch (error) {
      return fail('read_error', { code: 'read_failed', errno: error.code });
    }
    // Notepad may add a BOM; JSON.parse rejects it.
    if (text.charCodeAt(0) === 0xfeff) {
      text = text.slice(1);
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return fail('corrupt', { code: 'invalid_json' });
    }

    const result = validateStore(parsed);
    if (!result.ok) {
      const unsupported = result.errors.some((e) => e.code === 'unsupported_schema_version');
      return fail(unsupported ? 'unsupported' : 'invalid', { errors: result.errors });
    }
    blocked = false;
    return { status: 'ok', data: result.data, leftoverTemps };
  }

  async function removeQuietly(target) {
    try {
      await fs.unlink(target);
    } catch {
      // Best effort: the temp file may already be gone, and leftovers are reported on load.
    }
  }

  async function replaceWithRetry(from, to) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await fs.rename(from, to);
        return null;
      } catch (error) {
        const retryable = RETRYABLE_REPLACE_ERRORS.includes(error.code) && attempt < maxAttempts;
        if (!retryable) {
          return error;
        }
        await sleep(retryDelayMs * attempt);
      }
    }
  }

  async function writeOnce(data) {
    const text = `${JSON.stringify(data, null, 2)}\n`;
    if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) {
      return { ok: false, code: 'file_too_large' };
    }

    // Same folder as the target so the final rename never crosses a volume. The random name
    // avoids colliding with a leftover temp file (which may be the user's only recovery copy).
    const tempPath = path.join(dir, `${fileName}.${crypto.randomBytes(4).toString('hex')}.tmp`);

    let handle = null;
    try {
      // 'wx' fails if the name exists, so any file we create here is certainly ours.
      handle = await fs.open(tempPath, 'wx');
      await handle.writeFile(text, 'utf8');
      // Flush to disk before the replace so a crash cannot leave a half-written target.
      await handle.sync();
      await handle.close();
      handle = null;
    } catch (error) {
      if (handle) {
        try { await handle.close(); } catch { /* the original error is the one to report */ }
        // Only delete a temp file we actually created.
        await removeQuietly(tempPath);
      }
      return { ok: false, code: 'write_failed', errno: error.code };
    }

    const replaceError = await replaceWithRetry(tempPath, filePath);
    if (replaceError) {
      await removeQuietly(tempPath);
      return { ok: false, code: 'replace_failed', errno: replaceError.code };
    }
    return { ok: true };
  }

  function load() {
    return enqueue(loadOnce);
  }

  function save(data) {
    const validation = validateStore(data);
    if (!validation.ok) {
      return Promise.resolve({ ok: false, code: 'invalid_data', errors: validation.errors });
    }
    // The state checks run inside the queue, after any load already requested.
    return enqueue(async () => {
      if (!loaded) {
        return { ok: false, code: 'not_loaded' };
      }
      if (blocked) {
        return { ok: false, code: 'blocked_by_unreadable_file' };
      }
      return writeOnce(validation.data);
    });
  }

  return { load, save, filePath };
}

module.exports = { DEFAULT_FILE_NAME, MAX_FILE_BYTES, resolveDataDir, createCommandStore };
