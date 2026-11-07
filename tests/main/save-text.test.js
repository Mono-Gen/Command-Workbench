const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { saveTextAtomic, MAX_SAVE_BYTES } = require('../../src/main/save-text');

async function withDir(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wb-save-'));
  try {
    await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

test('writes the text and leaves no temporary file', async () => {
  await withDir(async (dir) => {
    const target = path.join(dir, 'out.json');
    assert.deepEqual(await saveTextAtomic(fsp, target, '{"a":1}\n日本'), { ok: true });
    assert.equal(await fsp.readFile(target, 'utf8'), '{"a":1}\n日本');
    assert.deepEqual(await fsp.readdir(dir), ['out.json']);
  });
});

test('replaces an existing file as a whole', async () => {
  await withDir(async (dir) => {
    const target = path.join(dir, 'out.json');
    await fsp.writeFile(target, 'old content that is longer than the new one');
    assert.equal((await saveTextAtomic(fsp, target, 'new')).ok, true);
    assert.equal(await fsp.readFile(target, 'utf8'), 'new');
  });
});

test('a failed write keeps the old file and removes the temporary file', async () => {
  await withDir(async (dir) => {
    const target = path.join(dir, 'out.json');
    await fsp.writeFile(target, 'keep me');
    const failing = {
      ...fsp,
      open: async (file, flags) => {
        const handle = await fsp.open(file, flags);
        return {
          writeFile: async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); },
          sync: () => handle.sync(),
          close: () => handle.close(),
        };
      },
      rename: fsp.rename,
      rm: fsp.rm,
    };
    assert.deepEqual(await saveTextAtomic(failing, target, 'new'), { ok: false, code: 'write_failed', errno: 'ENOSPC' });
    assert.equal(await fsp.readFile(target, 'utf8'), 'keep me');
    assert.deepEqual(await fsp.readdir(dir), ['out.json']);
  });
});

test('a failing rename (target is a folder) is reported and cleaned up', async () => {
  await withDir(async (dir) => {
    const target = path.join(dir, 'taken');
    await fsp.mkdir(target);
    const result = await saveTextAtomic(fsp, target, 'x');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'write_failed');
    assert.deepEqual(await fsp.readdir(dir), ['taken']);
  });
});

test('an existing temporary name is never overwritten', async () => {
  await withDir(async (dir) => {
    const target = path.join(dir, 'out.json');
    await fsp.writeFile(`${target}.fixed.tmp`, 'someone else');
    const result = await saveTextAtomic(fsp, target, 'x', { randomName: () => 'fixed' });
    assert.equal(result.ok, false);
    assert.equal(await fsp.readFile(`${target}.fixed.tmp`, 'utf8'), 'someone else');
  });
});

test('rejects bad arguments and oversized text', async () => {
  assert.deepEqual(await saveTextAtomic(fsp, '', 'x'), { ok: false, code: 'invalid_arguments' });
  assert.deepEqual(await saveTextAtomic(fsp, 'a', 5), { ok: false, code: 'invalid_arguments' });
  assert.deepEqual(await saveTextAtomic(fsp, 'a', 'x'.repeat(MAX_SAVE_BYTES + 1)), { ok: false, code: 'file_too_large' });
});
