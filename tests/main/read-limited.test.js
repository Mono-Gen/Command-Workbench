// Tests for reading a user-chosen file safely: open once, check the SAME handle, read at most the
// limit. (Checking with stat and then reading by path would let the file change in between.)
const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { readRegularFileLimited } = require('../../src/main/read-limited');

async function tempDir(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pw-readlim-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('reads a regular file within the limit, with a BOM and non-ASCII text intact', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'a.json');
  await fsp.writeFile(file, '﻿{"name":"日本語 é"}');
  const result = await readRegularFileLimited(fsp, file, 1024);
  assert.equal(result.ok, true);
  assert.equal(result.text, '﻿{"name":"日本語 é"}');
});

test('a file exactly at the limit is read; one byte more is refused', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'a.json');
  await fsp.writeFile(file, 'x'.repeat(100));
  assert.equal((await readRegularFileLimited(fsp, file, 100)).ok, true);
  assert.deepEqual(await readRegularFileLimited(fsp, file, 99), { ok: false, code: 'file_too_large' });
});

test('an empty file is read as empty text', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'empty.json');
  await fsp.writeFile(file, '');
  assert.deepEqual(await readRegularFileLimited(fsp, file, 100), { ok: true, text: '' });
});

test('a directory is not a file', async (t) => {
  const dir = await tempDir(t);
  const result = await readRegularFileLimited(fsp, dir, 100);
  assert.equal(result.ok, false);
  assert.ok(['not_a_file', 'read_failed'].includes(result.code), result.code);
});

test('a missing file is reported with its error code', async (t) => {
  const dir = await tempDir(t);
  assert.deepEqual(await readRegularFileLimited(fsp, path.join(dir, 'nope.json'), 100), { ok: false, code: 'read_failed', errno: 'ENOENT' });
});

test('a file that grows after the size check is still read at most up to the limit and refused', async (t) => {
  // The handle reports a small size, but more bytes are there when reading: the extra byte is noticed.
  const dir = await tempDir(t);
  const file = path.join(dir, 'a.json');
  await fsp.writeFile(file, 'x'.repeat(50));
  const lyingFs = {
    open: async (p, flags) => {
      const handle = await fsp.open(p, flags);
      return {
        stat: async () => ({ isFile: () => true, size: 10 }),
        read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
        close: () => handle.close(),
      };
    },
  };
  assert.deepEqual(await readRegularFileLimited(lyingFs, file, 20), { ok: false, code: 'file_too_large' });
});

test('the handle is always closed, including after a refusal', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'a.json');
  await fsp.writeFile(file, 'x'.repeat(100));
  let closed = 0;
  const countingFs = {
    open: async (p, flags) => {
      const handle = await fsp.open(p, flags);
      return {
        stat: () => handle.stat(),
        read: (...args) => handle.read(...args),
        close: async () => { closed += 1; await handle.close(); },
      };
    },
  };
  await readRegularFileLimited(countingFs, file, 10);
  await readRegularFileLimited(countingFs, file, 1000);
  assert.equal(closed, 2);
});
