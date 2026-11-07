// Builds the release ZIP from an already built portable program (`npm run dist` first).
//
// Contents of the ZIP: the program, README (English and Japanese), LICENSE, the licenses of Electron and Chromium, the user documents
// (docs/, manual/) and the sample definitions (samples/, copied from src/samples so that there is one
// original). Nothing else is copied, and the staged folder is checked for local-only names before
// it is compressed. No dependency: the ZIP is made with PowerShell's Compress-Archive (Windows).
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

// Names that must never end up in a release (local-only folders and secrets).
const FORBIDDEN = [/^\./, /^node_modules$/i, /^\.tasks$/i, /^\.docs$/i, /^\.scratch$/i, /^\.agents$/i, /\.tmp$/i, /^workbench-commands\.json$/i, /^\.env/i];

function releaseName(packageJson) {
  const product = (packageJson.build && packageJson.build.productName) || packageJson.name;
  return { product, version: packageJson.version, folder: `${product.split(' ').join('-')}-${packageJson.version}` };
}

// What goes where (paths relative to the project root; `to` is relative to the release folder).
function releasePlan(packageJson) {
  const { product, version, folder } = releaseName(packageJson);
  const exe = `${product}-${version}-portable.exe`;
  return {
    folder,
    entries: [
      { from: path.join('dist', exe), to: exe, kind: 'file' },
      { from: 'README.md', to: 'README.md', kind: 'file' },
      { from: 'README_JP.md', to: 'README_JP.md', kind: 'file' },
      { from: 'LICENSE', to: 'LICENSE', kind: 'file' },
      // Notices of the parts the program is built on (Electron and Chromium), as their licenses ask.
      { from: path.join('dist', 'win-unpacked', 'LICENSE.electron.txt'), to: path.join('licenses', 'LICENSE.electron.txt'), kind: 'file' },
      { from: path.join('dist', 'win-unpacked', 'LICENSES.chromium.html'), to: path.join('licenses', 'LICENSES.chromium.html'), kind: 'file' },
      { from: 'docs', to: 'docs', kind: 'dir' },
      // The manual (HTML, no script) links to ../docs and ../README*, so it sits next to them.
      { from: 'manual', to: 'manual', kind: 'dir' },
      { from: path.join('src', 'samples'), to: 'samples', kind: 'dir' },
    ],
  };
}

// Returns the relative paths (in the staged tree) whose name is forbidden.
function findForbidden(relativePaths) {
  const bad = [];
  for (const relative of relativePaths) {
    if (relative.split(/[\\/]/).some((part) => FORBIDDEN.some((pattern) => pattern.test(part)))) bad.push(relative);
  }
  return bad;
}

function walk(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    out.push(path.relative(base, full));
    if (entry.isDirectory()) out.push(...walk(full, base));
  }
  return out;
}

function main() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const plan = releasePlan(packageJson);
  const releaseRoot = path.join(ROOT, 'dist', 'release');
  const stage = path.join(releaseRoot, plan.folder);
  const zip = path.join(releaseRoot, `${plan.folder}.zip`);

  for (const entry of plan.entries) {
    if (!fs.existsSync(path.join(ROOT, entry.from))) {
      throw new Error(`Missing ${entry.from}${entry.from.startsWith('dist') ? ' (run "npm run dist" first)' : ''}`);
    }
  }

  // Only our own output folder is ever deleted.
  if (path.dirname(stage) !== releaseRoot) throw new Error('Unexpected release folder');
  fs.rmSync(stage, { recursive: true, force: true });
  fs.rmSync(zip, { force: true });
  fs.mkdirSync(stage, { recursive: true });
  for (const entry of plan.entries) {
    const target = path.join(stage, entry.to);
    // Placeholder and hidden files (such as .gitkeep) are not part of a release.
    if (entry.kind === 'dir') fs.cpSync(path.join(ROOT, entry.from), target, { recursive: true, filter: (source) => !path.basename(source).startsWith('.') });
    else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(ROOT, entry.from), target);
    }
  }

  const forbidden = findForbidden(walk(stage));
  if (forbidden.length > 0) throw new Error(`Local-only names in the release: ${forbidden.join(', ')}`);

  // Paths go through the environment, so no quoting of unusual characters is needed.
  const result = spawnSync('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    'Compress-Archive -LiteralPath $env:WB_STAGE -DestinationPath $env:WB_ZIP -Force',
  ], { env: { ...process.env, WB_STAGE: stage, WB_ZIP: zip }, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Compress-Archive failed: ${(result.stderr || result.stdout || '').trim()}`);

  const files = walk(stage).filter((p) => fs.statSync(path.join(stage, p)).isFile());
  console.log(`Release folder: ${path.relative(ROOT, stage)}`);
  console.log(`ZIP: ${path.relative(ROOT, zip)} (${(fs.statSync(zip).size / (1024 * 1024)).toFixed(1)} MiB, ${files.length} files)`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`package: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { releasePlan, releaseName, findForbidden };
