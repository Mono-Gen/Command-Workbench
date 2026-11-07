// The program's own page is served through a custom `app://` address instead of `file://`.
//
// Why: pages opened from `file://` get extra privileges in Electron (for example reading other local
// files). With a custom standard, secure scheme the page is an ordinary web origin, and the
// "file protocol extra privileges" fuse can be switched off. Only files inside the renderer folder
// can be reached, and nothing else is served.
const path = require('node:path');

const SCHEME = 'app';
const HOST = 'bundle';
const PAGE_URL = `${SCHEME}://${HOST}/index.html`;

const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'],
]);

// The absolute path of the file that a request URL names, or null when it is not an allowed file.
// Pure (no disk access): `rendererDir` is the folder that is served.
function resolveAppFile(requestUrl, rendererDir) {
  let url;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${SCHEME}:` || url.host !== HOST) return null;
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  // No way out of the folder: no backslashes, no "." / ".." parts, no NUL, no drive letters.
  if (pathname.includes('\\') || pathname.includes('\0') || !pathname.startsWith('/')) return null;
  const parts = pathname.slice(1).split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..' || part.includes(':'))) return null;
  const full = path.join(rendererDir, ...parts);
  const root = path.resolve(rendererDir) + path.sep;
  if (!path.resolve(full).startsWith(root)) return null;
  if (!MIME.has(path.extname(full).toLowerCase())) return null;
  return full;
}

const mimeFor = (file) => MIME.get(path.extname(file).toLowerCase()) ?? 'application/octet-stream';

// Registers the handler. `readFile` is injected (fs.promises.readFile reads inside the packaged
// archive too), so the logic can be tested without Electron.
function createAppProtocolHandler({ rendererDir, readFile }) {
  return async (request) => {
    const file = resolveAppFile(request.url, rendererDir);
    if (file === null) return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    try {
      const body = await readFile(file);
      return new Response(body, { status: 200, headers: { 'content-type': mimeFor(file), 'cache-control': 'no-store' } });
    } catch {
      return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    }
  };
}

module.exports = {
  SCHEME, HOST, PAGE_URL, resolveAppFile, mimeFor, createAppProtocolHandler,
};
