// The packaging hook removes only what it lists, and never a file the window needs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const afterPack = require('../scripts/after-pack');

test('only the listed unused files are removed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'after-pack-'));
  try {
    const keep = ['Command Workbench.exe', 'ffmpeg.dll', 'icudtl.dat', 'resources.pak', 'vk_swiftshader.dll', 'd3dcompiler_47.dll', 'LICENSES.chromium.html'];
    for (const name of [...keep, ...afterPack.UNUSED]) fs.writeFileSync(path.join(dir, name), 'x');
    await afterPack.default({ appOutDir: dir });
    assert.deepEqual(fs.readdirSync(dir).sort(), [...keep].sort());
    await afterPack.default({ appOutDir: dir }); // running again (nothing left to remove) is fine
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('nothing the window or the licenses need is on the removal list', () => {
  const needed = ['ffmpeg.dll', 'icudtl.dat', 'resources.pak', 'snapshot_blob.bin', 'v8_context_snapshot.bin', 'd3dcompiler_47.dll', 'vk_swiftshader.dll', 'LICENSES.chromium.html', 'LICENSE.electron.txt'];
  for (const name of afterPack.UNUSED) assert.ok(!needed.includes(name), name);
});
