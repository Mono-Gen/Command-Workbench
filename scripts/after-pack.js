// electron-builder hook: removes parts of the Electron runtime that this program never uses, to make
// the single file smaller. Each entry says why it is safe; anything that could change how the window
// is drawn on some PCs is NOT removed.
const fs = require('node:fs');
const path = require('node:path');

// dxcompiler.dll: shader compiler for Chromium's WebGPU path on Direct3D 12. The program draws plain
// HTML and never uses WebGPU; the library is loaded only on demand.
const UNUSED = ['dxcompiler.dll'];

exports.default = async function afterPack(context) {
  for (const name of UNUSED) {
    const file = path.join(context.appOutDir, name);
    if (fs.existsSync(file)) fs.rmSync(file);
  }
};

exports.UNUSED = UNUSED;
