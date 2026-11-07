// Checks that the dependency policy from the implementation plan (section 10) holds.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const pkg = require(path.join(__dirname, '..', 'package.json'));

test('has no runtime dependencies', () => {
  assert.equal(pkg.dependencies, undefined);
});

test('devDependency versions are pinned (no range prefix)', () => {
  for (const [name, version] of Object.entries(pkg.devDependencies)) {
    assert.match(version, /^\d+\.\d+\.\d+$/, `${name} must be pinned without ^ or ~`);
  }
});

test('contains the two devDependencies agreed in the plan', () => {
  assert.equal(pkg.devDependencies.electron, '45.2.1');
  assert.equal(pkg.devDependencies['electron-builder'], '26.18.0');
});
