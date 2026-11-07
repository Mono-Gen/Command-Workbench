// Draws assets/icon.svg at several sizes and writes assets/icon.ico (PNG images inside an ICO
// container) and assets/icon.png. Run with Electron, which does the drawing, so no dependency is
// needed:   electron scripts/make-icon.js     (ELECTRON_RUN_AS_NODE must not be set)
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ASSETS = path.join(__dirname, '..', 'assets');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

// ICO: a 6-byte header, one 16-byte entry per image, then the images (PNG data is allowed).
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  const entries = Buffer.alloc(16 * images.length);
  let offset = 6 + entries.length;
  images.forEach(({ size, png }, index) => {
    const at = index * 16;
    entries.writeUInt8(size >= 256 ? 0 : size, at); // 0 means 256
    entries.writeUInt8(size >= 256 ? 0 : size, at + 1);
    entries.writeUInt16LE(1, at + 4); // colour planes
    entries.writeUInt16LE(32, at + 6); // bits per pixel
    entries.writeUInt32LE(png.length, at + 8);
    entries.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, entries, ...images.map((i) => i.png)]);
}

// One window for all sizes: the SVG is scaled by CSS and the top-left square is captured.
async function renderAll(svg, sizes) {
  const win = new BrowserWindow({ show: false, width: 256, height: 256, useContentSize: true, transparent: true, frame: false, webPreferences: { offscreen: true } });
  const html = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent;overflow:hidden}svg{display:block;position:absolute;left:0;top:0}</style>${svg}`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  const images = [];
  for (const size of sizes) {
    await win.webContents.executeJavaScript(`(() => { const s = document.querySelector('svg'); s.style.width = '${size}px'; s.style.height = '${size}px'; })()`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const image = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
    images.push({ size, png: image.toPNG() });
  }
  win.destroy();
  return images;
}

app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(ASSETS, 'icon.svg'), 'utf8');
  const images = await renderAll(svg, SIZES);
  fs.writeFileSync(path.join(ASSETS, 'icon.ico'), buildIco(images));
  fs.writeFileSync(path.join(ASSETS, 'icon.png'), images.at(-1).png);
  console.log(`wrote assets/icon.ico (${SIZES.join(', ')}) and assets/icon.png`);
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
