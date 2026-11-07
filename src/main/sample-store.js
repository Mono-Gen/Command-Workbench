// Where the virtual device's sample definitions come from.
//
// Samples are plain JSON files in a `samples/` folder next to the program, so a user can open
// them, copy them and add their own. When that folder does not exist the bundled copies are used
// (the program also works as a single file, and during development). The two are never mixed: an
// existing folder is what the user wants to see, even if it is empty.
//
// The page is not trusted. It never passes a path: it passes an id, and an id is accepted only if
// the folder scan that happens now contains it. Only plain files directly inside the folder count
// (no links, no sub-folders), with a strict name, a size limit and a count limit.
// The file system is injected so every path can be tested without a disk.
const path = require('node:path');

// At most 64 characters in all, including ".json".
const NAME_PATTERN = /^(?=.{1,64}$)[A-Za-z0-9][A-Za-z0-9._-]*\.json$/;
const MAX_SAMPLE_BYTES = 1024 * 1024;
const MAX_SAMPLES = 30;
const MAX_NAME_LENGTH = 100;

const isSampleId = (value) => typeof value === 'string' && NAME_PATTERN.test(value);

function createSampleStore({ fs, folderDir, builtinDir }) {
  const errorCode = (error) => (error && typeof error.code === 'string' ? error.code : 'read_failed');
  const sameFile = (a, b) => {
    // A file system without stable ids reports 0: then only the type and the size checks remain.
    const x = Number(a.ino);
    const y = Number(b.ino);
    return !(x > 0 && y > 0) || (x === y && Number(a.dev) === Number(b.dev));
  };

  // The folder next to the program if it is a real folder; the bundled one only when there is no
  // such folder. A folder that exists but cannot be inspected is an error, not a reason to switch.
  async function chooseSource() {
    if (typeof folderDir !== 'string') return { source: 'builtin', dir: builtinDir };
    try {
      const info = await fs.lstat(folderDir);
      return info.isDirectory() ? { source: 'folder', dir: folderDir, info } : { source: 'builtin', dir: builtinDir };
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return { source: 'builtin', dir: builtinDir };
      return { source: 'folder', dir: folderDir, error: errorCode(error) };
    }
  }

  // The bundled samples are part of the program (read-only, inside the packaged archive, where an
  // opened handle cannot be compared with the path): the size seen by lstat is what counts.
  async function readBundled(file, info) {
    if (info.size > MAX_SAMPLE_BYTES) return { ok: false, reason: 'too_large' };
    try {
      return { ok: true, text: await fs.readFile(file, 'utf8') };
    } catch (error) {
      return { ok: false, reason: errorCode(error) };
    }
  }

  // Opens a file ONCE, checks the opened file (not the path again) and reads at most the limit
  // plus one byte, so a file swapped after the scan can neither be followed nor exceed the limit.
  async function readChecked(file, expected) {
    let handle;
    try {
      handle = await fs.open(file, 'r');
      const info = await handle.stat();
      if (!info.isFile() || !sameFile(info, expected)) return { ok: false, reason: 'changed' };
      if (info.size > MAX_SAMPLE_BYTES) return { ok: false, reason: 'too_large' };
      const buffer = Buffer.alloc(MAX_SAMPLE_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > MAX_SAMPLE_BYTES) return { ok: false, reason: 'too_large' };
      return { ok: true, text: buffer.subarray(0, length).toString('utf8') };
    } catch (error) {
      return { ok: false, reason: errorCode(error) };
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }

  // The directory must be the same one before and after it was read.
  async function listNames(source) {
    let names;
    try {
      names = await fs.readdir(source.dir);
      if (source.source === 'folder') {
        const after = await fs.lstat(source.dir);
        if (!after.isDirectory() || !sameFile(after, source.info)) return { ok: false, code: 'changed' };
      }
    } catch (error) {
      return { ok: false, code: errorCode(error) };
    }
    const candidates = names.filter((n) => NAME_PATTERN.test(n)).sort();
    return { ok: true, names: candidates.slice(0, MAX_SAMPLES), omitted: Math.max(0, candidates.length - MAX_SAMPLES) };
  }

  async function readEntry(source, entry) {
    const dir = source.dir;
    const file = path.join(dir, entry);
    let info;
    try {
      info = await fs.lstat(file);
    } catch (error) {
      return { id: entry, name: entry, ok: false, reason: errorCode(error) };
    }
    if (!info.isFile()) return null; // links, folders and the like are not samples at all
    const read = source.source === 'folder' ? await readChecked(file, info) : await readBundled(file, info);
    if (!read.ok) return { id: entry, name: entry, ok: false, reason: read.reason };
    let name = null;
    try {
      const text = read.text;
      const parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
      if (parsed !== null && typeof parsed === 'object' && typeof parsed.name === 'string' && parsed.name.length > 0) {
        name = parsed.name.slice(0, MAX_NAME_LENGTH);
      }
    } catch {
      return { id: entry, name: entry, ok: false, reason: 'invalid_json' };
    }
    // The full check happens when the sample is loaded; here the file only has to be usable as a list entry.
    if (name === null) return { id: entry, name: entry, ok: false, reason: 'no_name' };
    return { id: entry, name, ok: true };
  }

  async function list() {
    const source = await chooseSource();
    if (source.error) return { ok: false, source: source.source, dir: source.dir, code: source.error, items: [], omitted: 0 };
    const found = await listNames(source);
    if (!found.ok) return { ok: false, source: source.source, dir: source.dir, code: found.code, items: [], omitted: 0 };
    const items = [];
    for (const entry of found.names) {
      const item = await readEntry(source, entry);
      if (item !== null) items.push(item);
    }
    return { ok: true, source: source.source, dir: source.dir, items, omitted: found.omitted };
  }

  // Text of one sample, by id. The id must be a name in the folder right now; only that file is
  // read (not the whole folder), so asking again and again stays cheap.
  async function read(id) {
    if (!isSampleId(id)) return { ok: false, code: 'unknown_sample' };
    const source = await chooseSource();
    if (source.error) return { ok: false, code: source.error };
    const found = await listNames(source);
    if (!found.ok) return { ok: false, code: found.code };
    if (!found.names.includes(id)) return { ok: false, code: 'unknown_sample' };
    const file = path.join(source.dir, id);
    let info;
    try {
      info = await fs.lstat(file);
    } catch (error) {
      return { ok: false, code: 'sample_unreadable', reason: errorCode(error) };
    }
    if (!info.isFile()) return { ok: false, code: 'unknown_sample' };
    const result = source.source === 'folder' ? await readChecked(file, info) : await readBundled(file, info);
    if (!result.ok) return { ok: false, code: 'sample_unreadable', reason: result.reason };
    return { ok: true, text: result.text, fileName: id };
  }

  return { list, read };
}

module.exports = {
  createSampleStore, isSampleId, NAME_PATTERN, MAX_SAMPLE_BYTES, MAX_SAMPLES,
};
