// The release plan: what goes into the ZIP, and that local-only names are caught.
const test = require('node:test');
const assert = require('node:assert/strict');

const { releasePlan, releaseName, findForbidden } = require('../scripts/package');

const pkg = { name: 'command-workbench', version: '1.2.3', build: { productName: 'Command Workbench' } };

test('the release folder and ZIP are named after the product and the version', () => {
  assert.deepEqual(releaseName(pkg), { product: 'Command Workbench', version: '1.2.3', folder: 'Command-Workbench-1.2.3' });
  assert.equal(releaseName({ name: 'x', version: '0.0.1' }).folder, 'x-0.0.1');
});

test('the plan holds exactly the program, the READMEs, the licenses, docs, the manual and samples', () => {
  const plan = releasePlan(pkg);
  assert.equal(plan.folder, 'Command-Workbench-1.2.3');
  assert.deepEqual(plan.entries.map((e) => e.to.split(String.fromCharCode(92)).join('/')), ['Command Workbench-1.2.3-portable.exe', 'README.md', 'README_JP.md', 'LICENSE', 'licenses/LICENSE.electron.txt', 'licenses/LICENSES.chromium.html', 'docs', 'manual', 'samples']);
  const samples = plan.entries.find((e) => e.to === 'samples');
  assert.deepEqual({ from: samples.from.split('\\').join('/'), kind: samples.kind }, { from: 'src/samples', kind: 'dir' }, 'the samples have one original');
});

test('local-only names are found at any depth', () => {
  const bad = ['.tasks', 'docs/.docs/x.md', 'a/node_modules/b.js', '.env', 'samples/.hidden.json', 'x.tmp', 'workbench-commands.json', 'sub\\.scratch\\y'];
  assert.deepEqual(findForbidden(bad), bad);
  assert.deepEqual(findForbidden(['README.md', 'docs/udp.md', 'samples/udp-unit.json', 'Command Workbench-1.2.3-portable.exe', 'LICENSE']), []);
});

// The manual is plain HTML: no script, and every local link and image must exist (in the ZIP it sits
// next to docs/ and the READMEs, exactly as in the repository).
test('the manual pages have no script and no broken local link', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '..', 'manual');
  const pages = fs.readdirSync(dir).filter((f) => f.endsWith('.html'));
  assert.ok(pages.length >= 1);
  for (const page of pages) {
    const html = fs.readFileSync(path.join(dir, page), 'utf8');
    assert.ok(!/<script/i.test(html), `${page}: no script`);
    assert.ok(!/\bon[a-z]+\s*=/i.test(html), `${page}: no inline handler`);
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
    for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      const target = m[1];
      if (/^(https?:|mailto:)/.test(target)) continue;
      if (target.startsWith('#')) { assert.ok(ids.has(target.slice(1)), `${page}: missing anchor ${target}`); continue; }
      const file = target.split('#')[0];
      assert.ok(fs.existsSync(path.join(dir, file)), `${page}: missing file ${file}`);
    }
  }
});
