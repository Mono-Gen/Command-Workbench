// Tests for the sample store with a fake file system. Expected behavior comes from the plan
// (.tasks/ui_and_samples, 4.3), not from the code.
const test = require('node:test');
const assert = require('node:assert/strict');

const { createSampleStore, isSampleId, MAX_SAMPLE_BYTES, MAX_SAMPLES } = require('../../src/main/sample-store');

// tree: { dir: { name: { type: 'file'|'link'|'dir', text, size?, ino? } } }; a missing dir key means "no such folder".
// Reads go through open() like the real code: the handle reports what was really opened.
function fakeFs(tree, { failOpen = {}, hooks = {} } = {}) {
  const calls = { lstat: [], open: [], readdir: [] };
  const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
  const entryOf = (p) => {
    const norm = p.split(String.fromCharCode(92)).join('/');
    const slash = norm.lastIndexOf('/');
    return { dir: norm.slice(0, slash), name: norm.slice(slash + 1), norm };
  };
  const statOf = (entry) => ({
    isDirectory: () => entry.type === 'dir',
    isFile: () => entry.type === 'file',
    size: entry.size ?? Buffer.byteLength(entry.text ?? ''),
    ino: entry.ino ?? 1,
    dev: 1,
  });
  return {
    calls,
    async lstat(p) {
      calls.lstat.push(p);
      if (hooks.lstat) { const replaced = await hooks.lstat(p, calls.lstat.length); if (replaced) return replaced; }
      const { dir, name, norm } = entryOf(p);
      if (Object.hasOwn(tree, norm)) return { isDirectory: () => true, isFile: () => false, size: 0, ino: 99, dev: 1 };
      const entry = tree[dir]?.[name];
      if (!entry) throw missing();
      return statOf(entry);
    },
    async readdir(p) {
      calls.readdir.push(p);
      const key = p.split(String.fromCharCode(92)).join('/');
      if (!Object.hasOwn(tree, key)) throw missing();
      return Object.keys(tree[key]);
    },
    async readFile(p) {
      calls.readFile = (calls.readFile ?? []).concat(p);
      const { dir, name } = entryOf(p);
      if (failOpen[name]) throw Object.assign(new Error('x'), { code: failOpen[name] });
      const entry = tree[dir]?.[name];
      if (!entry) throw missing();
      return entry.text ?? '';
    },
    async open(p) {
      calls.open.push(p);
      const { dir, name } = entryOf(p);
      if (failOpen[name]) throw Object.assign(new Error('x'), { code: failOpen[name] });
      let entry = tree[dir]?.[name];
      if (!entry) throw missing();
      if (hooks.open) entry = (await hooks.open(p, entry)) ?? entry;
      const data = Buffer.from(entry.text ?? '');
      return {
        async stat() { return statOf(entry); },
        async read(buffer, offset, length, position) {
          const chunk = data.subarray(position, position + length);
          chunk.copy(buffer, offset);
          return { bytesRead: chunk.length };
        },
        async close() {},
      };
    },
  };
}

const FOLDER = 'C:/app/samples';
const BUILTIN = 'C:/app/builtin';
const sample = (name) => ({ type: 'file', text: JSON.stringify({ schemaVersion: 1, name }) });
const store = (tree, options) => createSampleStore({ fs: fakeFs(tree, options), folderDir: FOLDER, builtinDir: BUILTIN });

test('names: only a strict file name is a sample id', () => {
  for (const good of ['a.json', 'A1.json', 'udp-unit.json', 'my_sample.v2.json', `${'x'.repeat(59)}.json`]) assert.equal(isSampleId(good), true, good);
  for (const bad of ['', '.json', 'a', 'a.JSON', '.hidden.json', '-a.json', '../a.json', 'a/b.json', 'a\\b.json', 'a b.json', 'a.json ', 'a.json.txt',
    `${'x'.repeat(60)}.json`, 'ä.json', 'a\u0000.json', null, undefined, 5, {}]) assert.equal(isSampleId(bad), false, String(bad));
});

test('an existing folder is used alone; builtin samples are not mixed in', async () => {
  const s = store({ [FOLDER]: { 'mine.json': sample('Mine') }, [BUILTIN]: { 'other.json': sample('Other') } });
  const result = await s.list();
  assert.equal(result.source, 'folder');
  assert.deepEqual(result.items, [{ id: 'mine.json', name: 'Mine', ok: true }]);
});

test('an empty folder stays empty (the user chose that)', async () => {
  const s = store({ [FOLDER]: {}, [BUILTIN]: { 'other.json': sample('Other') } });
  const result = await s.list();
  assert.equal(result.source, 'folder');
  assert.deepEqual(result.items, []);
});

test('without the folder the builtin samples are used', async () => {
  const s = store({ [BUILTIN]: { 'b.json': sample('B'), 'a.json': sample('A') } });
  const result = await s.list();
  assert.equal(result.source, 'builtin');
  assert.deepEqual(result.items.map((i) => i.id), ['a.json', 'b.json'], 'sorted by name');
});

test('a link or a regular file named like a folder: the folder itself must be a real directory', async () => {
  const s = createSampleStore({
    fs: { ...fakeFs({ [BUILTIN]: { 'b.json': sample('B') } }), lstat: async () => ({ isDirectory: () => false, isFile: () => false, size: 0 }) },
    folderDir: FOLDER,
    builtinDir: BUILTIN,
  });
  assert.equal((await s.list()).source, 'builtin');
});

test('only plain files with strict names are listed; links, folders and odd names are ignored', async () => {
  const s = store({
    [FOLDER]: {
      'ok.json': sample('Ok'),
      'link.json': { type: 'link', text: '{}' },
      'folder.json': { type: 'dir' },
      'notes.txt': { type: 'file', text: 'x' },
      'UPPER.JSON': sample('Upper'),
      '.hidden.json': sample('Hidden'),
      'sp ace.json': sample('Space'),
    },
  });
  assert.deepEqual((await s.list()).items.map((i) => i.id), ['ok.json']);
});

test('a broken file is listed with its reason instead of being hidden', async () => {
  const s = store({
    [FOLDER]: {
      'broken.json': { type: 'file', text: '{ nope' },
      'noname.json': { type: 'file', text: '{"schemaVersion":1}' },
      'array.json': { type: 'file', text: '[1]' },
      'big.json': { type: 'file', text: '{}', size: MAX_SAMPLE_BYTES + 1 },
      'denied.json': sample('Denied'),
    },
  }, { failOpen: { 'denied.json': 'EACCES' } });
  const byId = Object.fromEntries((await s.list()).items.map((i) => [i.id, i]));
  assert.equal(byId['broken.json'].reason, 'invalid_json');
  assert.equal(byId['noname.json'].reason, 'no_name');
  assert.equal(byId['array.json'].reason, 'no_name');
  assert.equal(byId['big.json'].reason, 'too_large');
  assert.equal(byId['denied.json'].reason, 'EACCES');
  assert.ok(Object.values(byId).every((i) => i.ok === false));
});

test('size boundary: 1 MiB is read, one byte more is not', async () => {
  const padded = (extra) => `{"name":"X","pad":"${'a'.repeat(MAX_SAMPLE_BYTES - 21 + extra)}"}`;
  assert.equal(Buffer.byteLength(padded(0)), MAX_SAMPLE_BYTES);
  const s = store({ [FOLDER]: {
    'at.json': { type: 'file', text: padded(0) },
    'over.json': { type: 'file', text: padded(1) },
  } });
  const byId = Object.fromEntries((await s.list()).items.map((i) => [i.id, i]));
  assert.equal(byId['at.json'].ok, true);
  assert.equal(byId['over.json'].reason, 'too_large');
});

test('a BOM is accepted and the display name is cut at 100 characters', async () => {
  const s = store({ [FOLDER]: { 'bom.json': { type: 'file', text: `\ufeff${JSON.stringify({ name: 'N'.repeat(150) })}` } } });
  const [item] = (await s.list()).items;
  assert.equal(item.ok, true);
  assert.equal(item.name.length, 100);
});

test('at most 30 samples are scanned and the rest is counted', async () => {
  const files = {};
  for (let i = 0; i < MAX_SAMPLES + 5; i += 1) files[`s${String(i).padStart(2, '0')}.json`] = sample(`S${i}`);
  const result = await store({ [FOLDER]: files }).list();
  assert.equal(result.items.length, MAX_SAMPLES);
  assert.equal(result.omitted, 5);
});

test('an unreadable folder is reported with its code, not as an empty list', async () => {
  const fsx = fakeFs({ [FOLDER]: {} });
  fsx.readdir = async () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); };
  const result = await createSampleStore({ fs: fsx, folderDir: FOLDER, builtinDir: BUILTIN }).list();
  assert.deepEqual({ ok: result.ok, code: result.code }, { ok: false, code: 'EACCES' });
});

test('read: returns the text of a listed sample and its file name', async () => {
  const s = store({ [FOLDER]: { 'mine.json': sample('Mine') } });
  const result = await s.read('mine.json');
  assert.equal(result.ok, true);
  assert.equal(result.fileName, 'mine.json');
  assert.equal(JSON.parse(result.text).name, 'Mine');
});

test('read: ids that are not in the current scan are refused, whatever they look like', async () => {
  const s = store({ [FOLDER]: { 'mine.json': sample('Mine'), 'link.json': { type: 'link', text: '{}' } }, 'C:/app': { 'secret.json': sample('Secret') } });
  for (const id of ['other.json', '../secret.json', '..\\secret.json', 'C:/app/secret.json', 'link.json', 'mine', '', null, 5]) {
    assert.deepEqual(await s.read(id), { ok: false, code: 'unknown_sample' }, String(id));
  }
});

test('read: a file that is not valid JSON is still returned (the definition check reports it with positions)', async () => {
  const s = store({ [FOLDER]: { 'broken.json': { type: 'file', text: '{ nope' } } });
  assert.deepEqual(await s.read('broken.json'), { ok: true, text: '{ nope', fileName: 'broken.json' });
});

test('read: only the requested file is opened, not every file of the folder', async () => {
  const fsx = fakeFs({ [FOLDER]: { 'a.json': sample('A'), 'b.json': sample('B'), 'c.json': sample('C') } });
  const result = await createSampleStore({ fs: fsx, folderDir: FOLDER, builtinDir: BUILTIN }).read('b.json');
  assert.equal(result.ok, true);
  assert.deepEqual(fsx.calls.open.map((x) => x.split(String.fromCharCode(92)).join('/')), ['C:/app/samples/b.json']);
});

test('read: a file swapped for a link after the check is refused (the opened file is what counts)', async () => {
  const fsx = fakeFs({ [FOLDER]: { 'mine.json': sample('Mine') } }, {
    hooks: { open: async (p, entry) => ({ ...entry, type: 'link' }) },
  });
  const result = await createSampleStore({ fs: fsx, folderDir: FOLDER, builtinDir: BUILTIN }).read('mine.json');
  assert.deepEqual(result, { ok: false, code: 'sample_unreadable', reason: 'changed' });
});

test('read: a different file behind the same name (other identity) is refused', async () => {
  const fsx = fakeFs({ [FOLDER]: { 'mine.json': { ...sample('Mine'), ino: 5 } } }, {
    hooks: { open: async (p, entry) => ({ ...entry, ino: 6 }) },
  });
  const result = await createSampleStore({ fs: fsx, folderDir: FOLDER, builtinDir: BUILTIN }).read('mine.json');
  assert.deepEqual(result, { ok: false, code: 'sample_unreadable', reason: 'changed' });
});

test('read: a file that grew after the check never exceeds the limit', async () => {
  const big = `{"name":"X","pad":"${'a'.repeat(MAX_SAMPLE_BYTES)}"}`;
  const fsx = fakeFs({ [FOLDER]: { 'mine.json': sample('Mine') } }, {
    // The opened file reports a small size (as when it grows while being read) but holds more.
    hooks: { open: async (p, entry) => ({ ...entry, text: big, size: 10 }) },
  });
  const result = await createSampleStore({ fs: fsx, folderDir: FOLDER, builtinDir: BUILTIN }).read('mine.json');
  assert.deepEqual(result, { ok: false, code: 'sample_unreadable', reason: 'too_large' });
});

test('read: a failure while opening is returned as a code', async () => {
  const fsx = fakeFs({ [FOLDER]: { 'mine.json': sample('Mine') } }, { failOpen: { 'mine.json': 'EBUSY' } });
  const result = await createSampleStore({ fs: fsx, folderDir: FOLDER, builtinDir: BUILTIN }).read('mine.json');
  assert.deepEqual(result, { ok: false, code: 'sample_unreadable', reason: 'EBUSY' });
});

test('a samples folder that exists but cannot be inspected is an error, never a switch to the bundled samples', async () => {
  const fsx = fakeFs({ [BUILTIN]: { 'b.json': sample('B') } }, {
    hooks: { lstat: async (p) => { if (p === FOLDER) throw Object.assign(new Error('x'), { code: 'EACCES' }); return null; } },
  });
  const s = createSampleStore({ fs: fsx, folderDir: FOLDER, builtinDir: BUILTIN });
  const result = await s.list();
  assert.deepEqual({ ok: result.ok, source: result.source, code: result.code }, { ok: false, source: 'folder', code: 'EACCES' });
  assert.deepEqual(await s.read('b.json'), { ok: false, code: 'EACCES' });
});

test('a missing folder, a null folder and a plain file called samples all fall back to the bundled samples', async () => {
  const tree = { [BUILTIN]: { 'b.json': sample('B') }, 'C:/app': { samples: { type: 'file', text: 'x' } } };
  for (const folderDir of ['C:/app/nowhere', null, 'C:/app/samples']) {
    const result = await createSampleStore({ fs: fakeFs(tree), folderDir, builtinDir: BUILTIN }).list();
    assert.equal(result.source, 'builtin', String(folderDir));
  }
});

test('the folder swapped while it is being read is detected', async () => {
  let calls = 0;
  const fsx = fakeFs({ [FOLDER]: { 'a.json': sample('A') } }, {
    hooks: { lstat: async (p) => {
      if (p !== FOLDER) return null;
      calls += 1;
      return calls === 1 ? null : { isDirectory: () => true, isFile: () => false, size: 0, ino: 1234, dev: 1 };
    } },
  });
  const result = await createSampleStore({ fs: fsx, folderDir: FOLDER, builtinDir: BUILTIN }).list();
  assert.deepEqual({ ok: result.ok, code: result.code }, { ok: false, code: 'changed' });
});

test('bundled samples are read by path (inside the packaged archive a handle cannot be compared) but the size limit still holds', async () => {
  const fsx = fakeFs({ [BUILTIN]: { 'ok.json': sample('Ok'), 'big.json': { type: 'file', text: '{}', size: MAX_SAMPLE_BYTES + 1 } } });
  const s = createSampleStore({ fs: fsx, folderDir: null, builtinDir: BUILTIN });
  const byId = Object.fromEntries((await s.list()).items.map((i) => [i.id, i]));
  assert.equal(byId['ok.json'].ok, true);
  assert.equal(byId['big.json'].reason, 'too_large');
  assert.equal(fsx.calls.open.length, 0, 'no handle is opened for bundled files');
  assert.equal((await s.read('ok.json')).ok, true);
  assert.deepEqual(await s.read('big.json'), { ok: false, code: 'sample_unreadable', reason: 'too_large' });
});
