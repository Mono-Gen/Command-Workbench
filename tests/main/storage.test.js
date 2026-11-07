// Tests for data-folder resolution and the safe load/save of the command list.
// Expected behavior comes from the plan (sections 7 and 9.5): no silent fallback, never
// overwrite an unreadable file, atomic replace with bounded retry, serialized saves.
const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { resolveDataDir, createCommandStore } = require('../../src/main/storage');

const FILE_NAME = 'workbench-commands.json';

function sampleData(name = 'Matrix') {
  return {
    schemaVersion: 1,
    devices: [{
      name,
      host: '192.0.2.10',
      port: 23,
      commands: [{ name: 'Get power', text: 'GETPWR[CR]', mode: 'text', appendTerminator: 'none', kind: 'query' }],
    }],
  };
}

async function withTempDir(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pw-storage-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

function errnoError(code) {
  return Object.assign(new Error(code), { code });
}

const noSleep = async () => {};

// ---- resolveDataDir -------------------------------------------------------------------

test('resolveDataDir: uses PORTABLE_EXECUTABLE_DIR when it is an absolute path', () => {
  const portable = path.resolve('portable-dir');
  assert.deepEqual(
    resolveDataDir({ env: { PORTABLE_EXECUTABLE_DIR: portable }, isPackaged: true, exeDir: path.resolve('tmp-extract'), devDir: path.resolve('dev') }),
    { ok: true, dir: portable, source: 'portable' },
  );
});

test('resolveDataDir: rejects a relative or empty PORTABLE_EXECUTABLE_DIR without falling back', () => {
  const base = { isPackaged: true, exeDir: path.resolve('x'), devDir: path.resolve('d') };
  assert.deepEqual(resolveDataDir({ ...base, env: { PORTABLE_EXECUTABLE_DIR: 'relative/dir' } }), { ok: false, code: 'portable_dir_not_absolute' });
  // An empty value is the same as unset: a packaged run then uses the unpacked exe folder.
  assert.deepEqual(resolveDataDir({ ...base, env: { PORTABLE_EXECUTABLE_DIR: '' } }), { ok: true, dir: base.exeDir, source: 'unpacked' });
});

test('resolveDataDir: a packaged run without the portable variable uses the exe folder', () => {
  const exeDir = path.resolve('app-folder');
  assert.deepEqual(
    resolveDataDir({ env: {}, isPackaged: true, exeDir, devDir: path.resolve('dev') }),
    { ok: true, dir: exeDir, source: 'unpacked' },
  );
});

test('resolveDataDir: a development run uses the development folder', () => {
  const devDir = path.resolve('dev-data');
  assert.deepEqual(
    resolveDataDir({ env: {}, isPackaged: false, exeDir: path.resolve('electron-dir'), devDir }),
    { ok: true, dir: devDir, source: 'development' },
  );
});

// ---- load -----------------------------------------------------------------------------

test('load: a missing file gives an empty store', async (t) => {
  const dir = await withTempDir(t);
  const store = createCommandStore({ fs: fsp, dir, sleep: noSleep });
  const result = await store.load();
  assert.equal(result.status, 'missing');
  assert.deepEqual(result.data, { schemaVersion: 1, devices: [] });
  assert.deepEqual(result.leftoverTemps, []);
});

test('save then load round-trips, with no temp file left behind', async (t) => {
  const dir = await withTempDir(t);
  const store = createCommandStore({ fs: fsp, dir, sleep: noSleep });
  await store.load(); // saving requires one load first
  assert.deepEqual(await store.save(sampleData()), { ok: true });

  const loaded = await store.load();
  assert.equal(loaded.status, 'ok');
  assert.equal(loaded.data.devices[0].commands[0].expectsReply, true, 'normalized on load');
  assert.deepEqual(await fsp.readdir(dir), [FILE_NAME]);
});

test('load: accepts a UTF-8 BOM (files edited in Notepad)', async (t) => {
  const dir = await withTempDir(t);
  await fsp.writeFile(path.join(dir, FILE_NAME), `﻿${JSON.stringify(sampleData())}`);
  const result = await createCommandStore({ fs: fsp, dir, sleep: noSleep }).load();
  assert.equal(result.status, 'ok');
});

test('load: broken JSON is reported, the file is not touched, and saving is blocked', async (t) => {
  const dir = await withTempDir(t);
  const file = path.join(dir, FILE_NAME);
  await fsp.writeFile(file, '{ "schemaVersion": 1, "devices": [');
  const store = createCommandStore({ fs: fsp, dir, sleep: noSleep });

  const result = await store.load();
  assert.equal(result.status, 'corrupt');
  assert.equal(result.code, 'invalid_json');

  assert.deepEqual(await store.save(sampleData()), { ok: false, code: 'blocked_by_unreadable_file' });
  assert.equal(await fsp.readFile(file, 'utf8'), '{ "schemaVersion": 1, "devices": [', 'original content kept');
});

test('load: an unknown schema version is "unsupported" and blocks saving', async (t) => {
  const dir = await withTempDir(t);
  await fsp.writeFile(path.join(dir, FILE_NAME), JSON.stringify({ schemaVersion: 2, devices: [] }));
  const store = createCommandStore({ fs: fsp, dir, sleep: noSleep });
  const result = await store.load();
  assert.equal(result.status, 'unsupported');
  assert.deepEqual((await store.save(sampleData())).code, 'blocked_by_unreadable_file');
});

test('load: valid JSON with invalid content is "invalid" with error paths, and blocks saving', async (t) => {
  const dir = await withTempDir(t);
  const bad = sampleData();
  bad.devices[0].port = 0;
  await fsp.writeFile(path.join(dir, FILE_NAME), JSON.stringify(bad));
  const store = createCommandStore({ fs: fsp, dir, sleep: noSleep });
  const result = await store.load();
  assert.equal(result.status, 'invalid');
  assert.deepEqual(result.errors, [{ path: 'devices[0].port', code: 'invalid_port' }]);
  assert.equal((await store.save(sampleData())).code, 'blocked_by_unreadable_file');
});

test('load: a file over 5 MiB is refused without being parsed', async (t) => {
  const dir = await withTempDir(t);
  await fsp.writeFile(path.join(dir, FILE_NAME), 'x'.repeat(5 * 1024 * 1024 + 1));
  const store = createCommandStore({ fs: fsp, dir, sleep: noSleep });
  assert.equal((await store.load()).status, 'too_large');
  assert.equal((await store.save(sampleData())).code, 'blocked_by_unreadable_file');
});

test('load: a read error other than "missing" is reported and blocks saving', async (t) => {
  const dir = await withTempDir(t);
  // The file must exist so the size check passes and the read itself is what fails.
  await fsp.writeFile(path.join(dir, FILE_NAME), JSON.stringify(sampleData()));
  const failingFs = { ...fsp, readFile: async () => { throw errnoError('EACCES'); } };
  const store = createCommandStore({ fs: failingFs, dir, sleep: noSleep });
  const result = await store.load();
  assert.equal(result.status, 'read_error');
  assert.equal(result.errno, 'EACCES');
  assert.equal((await store.save(sampleData())).code, 'blocked_by_unreadable_file');
});

test('load: reports temp files left by an earlier crash, and never deletes them', async (t) => {
  const dir = await withTempDir(t);
  await fsp.writeFile(path.join(dir, `${FILE_NAME}.123.1.tmp`), 'partial');
  await fsp.writeFile(path.join(dir, 'unrelated.tmp'), 'keep');
  const result = await createCommandStore({ fs: fsp, dir, sleep: noSleep }).load();
  assert.deepEqual(result.leftoverTemps, [`${FILE_NAME}.123.1.tmp`]);
  assert.deepEqual((await fsp.readdir(dir)).sort(), ['unrelated.tmp', `${FILE_NAME}.123.1.tmp`].sort());
});

// ---- save -----------------------------------------------------------------------------

test('save: invalid data is rejected before touching the disk', async (t) => {
  const dir = await withTempDir(t);
  const store = createCommandStore({ fs: fsp, dir, sleep: noSleep });
  const bad = sampleData();
  bad.devices[0].host = '';
  const result = await store.save(bad);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid_data');
  assert.deepEqual(result.errors, [{ path: 'devices[0].host', code: 'invalid_host' }]);
  assert.deepEqual(await fsp.readdir(dir), []);
});

test('save: concurrent saves are serialized and the last call wins', async (t) => {
  const dir = await withTempDir(t);
  const store = createCommandStore({ fs: fsp, dir, sleep: noSleep });
  await store.load();
  const results = await Promise.all([store.save(sampleData('A')), store.save(sampleData('B')), store.save(sampleData('C'))]);
  assert.deepEqual(results, [{ ok: true }, { ok: true }, { ok: true }]);
  assert.equal((await store.load()).data.devices[0].name, 'C');
  assert.deepEqual(await fsp.readdir(dir), [FILE_NAME]);
});

test('save: retries the replace on EPERM/EBUSY with growing delays, then succeeds', async (t) => {
  const dir = await withTempDir(t);
  const delays = [];
  let renameCalls = 0;
  const flakyFs = {
    ...fsp,
    rename: async (from, to) => {
      renameCalls += 1;
      if (renameCalls <= 2) throw errnoError(renameCalls === 1 ? 'EPERM' : 'EBUSY');
      return fsp.rename(from, to);
    },
  };
  const store = createCommandStore({ fs: flakyFs, dir, sleep: async (ms) => { delays.push(ms); }, maxAttempts: 5, retryDelayMs: 50 });
  await store.load();
  assert.deepEqual(await store.save(sampleData()), { ok: true });
  assert.equal(renameCalls, 3);
  assert.deepEqual(delays, [50, 100], 'delay grows with each failed attempt');
  assert.deepEqual(await fsp.readdir(dir), [FILE_NAME]);
});

test('save: gives up after the maximum attempts, keeps the original, removes the temp file', async (t) => {
  const dir = await withTempDir(t);
  const file = path.join(dir, FILE_NAME);
  const original = JSON.stringify(sampleData('Original'));
  await fsp.writeFile(file, original);

  let renameCalls = 0;
  const lockedFs = { ...fsp, rename: async () => { renameCalls += 1; throw errnoError('EPERM'); } };
  const store = createCommandStore({ fs: lockedFs, dir, sleep: noSleep, maxAttempts: 4 });
  await store.load();

  const result = await store.save(sampleData('New'));
  assert.deepEqual(result, { ok: false, code: 'replace_failed', errno: 'EPERM' });
  assert.equal(renameCalls, 4);
  assert.equal(await fsp.readFile(file, 'utf8'), original, 'original content kept');
  assert.deepEqual(await fsp.readdir(dir), [FILE_NAME], 'temp file removed');
});

test('save: a non-retryable replace error fails at once', async (t) => {
  const dir = await withTempDir(t);
  let renameCalls = 0;
  const brokenFs = { ...fsp, rename: async () => { renameCalls += 1; throw errnoError('EXDEV'); } };
  const store = createCommandStore({ fs: brokenFs, dir, sleep: noSleep, maxAttempts: 5 });
  await store.load();
  assert.deepEqual(await store.save(sampleData()), { ok: false, code: 'replace_failed', errno: 'EXDEV' });
  assert.equal(renameCalls, 1);
});

test('save: a folder that cannot be written is reported with the error code', async (t) => {
  const dir = await withTempDir(t);
  const readOnlyFs = { ...fsp, open: async () => { throw errnoError('EACCES'); } };
  const store = createCommandStore({ fs: readOnlyFs, dir, sleep: noSleep });
  await store.load();
  assert.deepEqual(await store.save(sampleData()), { ok: false, code: 'write_failed', errno: 'EACCES' });
  assert.deepEqual(await fsp.readdir(dir), []);
});

test('save: a failed write cleans up the temp file and keeps the original', async (t) => {
  const dir = await withTempDir(t);
  const file = path.join(dir, FILE_NAME);
  await fsp.writeFile(file, JSON.stringify(sampleData('Original')));

  const fullDiskFs = {
    ...fsp,
    open: async (...args) => {
      const handle = await fsp.open(...args);
      return {
        writeFile: async () => { throw errnoError('ENOSPC'); },
        sync: () => handle.sync(),
        close: () => handle.close(),
      };
    },
  };
  const store = createCommandStore({ fs: fullDiskFs, dir, sleep: noSleep });
  await store.load();
  assert.deepEqual(await store.save(sampleData('New')), { ok: false, code: 'write_failed', errno: 'ENOSPC' });
  assert.deepEqual(await fsp.readdir(dir), [FILE_NAME]);
  assert.equal(JSON.parse(await fsp.readFile(file, 'utf8')).devices[0].name, 'Original');
});

test('save: output is pretty-printed JSON with a trailing newline (hand-editable)', async (t) => {
  const dir = await withTempDir(t);
  const store = createCommandStore({ fs: fsp, dir, sleep: noSleep });
  await store.load();
  await store.save(sampleData());
  const text = await fsp.readFile(path.join(dir, FILE_NAME), 'utf8');
  assert.ok(text.endsWith('}\n'));
  assert.ok(text.includes('\n  "devices"'));
});
