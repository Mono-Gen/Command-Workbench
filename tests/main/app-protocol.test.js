// The app:// address that serves the program's own page: only files of the renderer folder, nothing else.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { resolveAppFile, mimeFor, createAppProtocolHandler, PAGE_URL } = require('../../src/main/app-protocol');

const DIR = path.join(path.sep === '\\' ? 'C:\\app' : '/app', 'src', 'renderer');
const norm = (p) => p && p.split(path.sep).join('/');

test('the page and its scripts, styles and translations resolve inside the renderer folder', () => {
  assert.equal(PAGE_URL, 'app://bundle/index.html');
  for (const [url, rel] of [
    ['app://bundle/index.html', 'index.html'],
    ['app://bundle/app.js', 'app.js'],
    ['app://bundle/styles.css', 'styles.css'],
    ['app://bundle/i18n/ja.js', 'i18n/ja.js'],
    ['app://bundle/index.html?x=1#top', 'index.html'],
    ['app://bundle/APP.JS', 'APP.JS'],
  ]) {
    assert.equal(norm(resolveAppFile(url, DIR)), norm(path.join(DIR, rel)), url);
  }
});

test('anything that could leave the folder, or is not a plain allowed file, is refused', () => {
  const bad = [
    'app://bundle/%2E%2E%2Fmain/main.js', 'app://bundle/..%2Fmain%2Fmain.js', 'app://bundle/i18n%2F..%2F..%2Fmain.js',
    'app://bundle/..%5Cmain%5Cmain.js', 'app://bundle/a\\b.js',
    'app://bundle/C:/Windows/win.ini', 'app://bundle/C%3A/x.js', 'app://bundle//etc/passwd.js',
    'app://bundle/', 'app://bundle', 'app://bundle/i18n/', 'app://bundle/app.js%00.png', 'app://bundle/%00.js',
    'app://bundle/readme.txt', 'app://bundle/preload.json', 'app://bundle/noextension',
    'app://other/index.html', 'app://bundle.evil/index.html', 'file:///C:/app/src/renderer/index.html',
    'http://bundle/index.html', 'app:index.html', 'not a url', '', 'app://bundle/%E0%A4%A.js',
  ];
  for (const url of bad) assert.equal(resolveAppFile(url, DIR), null, url);
});

test('dot segments are resolved by the URL parser first, so they can never climb above the served folder', () => {
  for (const url of ['app://bundle/../main/main.js', 'app://bundle/%2e%2e/main/main.js', 'app://bundle/i18n/../../main/main.js', 'app://bundle/./app.js']) {
    const file = resolveAppFile(url, DIR);
    assert.ok(file === null || path.resolve(file).startsWith(DIR + path.sep), `${url} -> ${file}`);
  }
});

test('every served kind has a content type', () => {
  assert.equal(mimeFor('a.html'), 'text/html; charset=utf-8');
  assert.equal(mimeFor('a.JS'), 'text/javascript; charset=utf-8');
  assert.equal(mimeFor('a.css'), 'text/css; charset=utf-8');
  assert.equal(mimeFor('a.png'), 'image/png');
  assert.equal(mimeFor('a.xyz'), 'application/octet-stream');
});

test('the handler serves a file, answers 404 for refused or missing ones, and never reads outside', async () => {
  const reads = [];
  const handler = createAppProtocolHandler({
    rendererDir: DIR,
    readFile: async (file) => {
      reads.push(norm(file));
      if (norm(file).endsWith('missing.js')) throw Object.assign(new Error('x'), { code: 'ENOENT' });
      return Buffer.from('content');
    },
  });
  const ok = await handler({ url: 'app://bundle/app.js' });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal(await ok.text(), 'content');
  assert.equal((await handler({ url: 'app://bundle/..%2Fmain%2Fmain.js' })).status, 404);
  assert.equal((await handler({ url: 'app://bundle/missing.js' })).status, 404);
  assert.deepEqual(reads, [norm(path.join(DIR, 'app.js')), norm(path.join(DIR, 'missing.js'))], 'a refused path is never read');
});
