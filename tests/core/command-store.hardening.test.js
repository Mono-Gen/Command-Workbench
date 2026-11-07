// Regression tests for validation holes found by the independent audit.
const test = require('node:test');
const assert = require('node:assert/strict');

const { validateStore } = require('../../src/core/command-store');

function store() {
  return {
    schemaVersion: 1,
    devices: [{ name: 'Dev', host: 'h', port: 1, commands: [{ name: 'c', text: 'A', mode: 'text', appendTerminator: 'none', kind: 'query' }] }],
  };
}

test('an object that only inherits its required fields is rejected', () => {
  const inherited = Object.create({ schemaVersion: 1, devices: [] });
  assert.deepEqual(validateStore(inherited), { ok: false, errors: [{ path: '$', code: 'not_an_object' }] });

  const device = Object.create({ name: 'D', host: 'h', port: 1, commands: [] });
  const data = { schemaVersion: 1, devices: [device] };
  assert.deepEqual(validateStore(data).errors, [{ path: 'devices[0]', code: 'not_an_object' }]);
});

test('objects with a null prototype (from JSON.parse of some libraries) are accepted', () => {
  const bare = Object.assign(Object.create(null), store());
  assert.equal(validateStore(bare).ok, true);
});

test('command text is limited in UTF-8 bytes, not UTF-16 units', () => {
  const atLimit = store();
  atLimit.devices[0].commands[0].text = 'é'.repeat(32768); // 2 bytes each = 65536 bytes
  assert.equal(validateStore(atLimit).ok, true);

  const overLimit = store();
  overLimit.devices[0].commands[0].text = '😀'.repeat(32768); // 4 bytes each = 131072 bytes
  assert.deepEqual(validateStore(overLimit).errors, [{ path: 'devices[0].commands[0].text', code: 'invalid_text' }]);

  const oneOver = store();
  oneOver.devices[0].commands[0].text = `${'A'.repeat(65535)}é`; // 65535 + 2 bytes
  assert.equal(validateStore(oneOver).ok, false);
});

test('names that differ only by case, surrounding spaces or Unicode form are duplicates', () => {
  const devices = store();
  devices.devices.push({ ...store().devices[0], name: ' dev ' });
  assert.deepEqual(validateStore(devices).errors, [{ path: 'devices[1].name', code: 'duplicate_name' }]);

  const commands = store();
  commands.devices[0].commands.push({ ...commands.devices[0].commands[0], name: 'C' });
  assert.deepEqual(validateStore(commands).errors, [{ path: 'devices[0].commands[1].name', code: 'duplicate_name' }]);

  const unicode = store();
  unicode.devices[0].commands[0].name = 'café';
  unicode.devices[0].commands.push({ ...unicode.devices[0].commands[0], name: 'café' });
  assert.deepEqual(validateStore(unicode).errors, [{ path: 'devices[0].commands[1].name', code: 'duplicate_name' }]);
});

test('the stored name keeps its original spelling', () => {
  const data = store();
  data.devices[0].name = 'My Device';
  assert.equal(validateStore(data).data.devices[0].name, 'My Device');
});

test('the total size of all command texts is limited to 5 MiB, and validation stops early', () => {
  // 100 commands of 60 KiB = 6000 KiB > 5 MiB.
  const big = store();
  big.devices[0].commands = Array.from({ length: 100 }, (_, i) => ({
    name: `c${i}`, text: 'A'.repeat(61440), mode: 'text', appendTerminator: 'none', kind: 'set',
  }));
  assert.deepEqual(validateStore(big), { ok: false, errors: [{ path: '$', code: 'store_too_large' }] });

  const fits = store();
  fits.devices[0].commands = Array.from({ length: 80 }, (_, i) => ({
    name: `c${i}`, text: 'A'.repeat(61440), mode: 'text', appendTerminator: 'none', kind: 'set',
  }));
  assert.equal(validateStore(fits).ok, true, '80 x 60 KiB = 4.7 MiB is allowed');
});

test('names made only of spaces are invalid', () => {
  const data = store();
  data.devices[0].name = '   ';
  assert.deepEqual(validateStore(data).errors, [{ path: 'devices[0].name', code: 'invalid_name' }]);
});
