// Tests for the pure helpers used by the page (loaded as a classic script in the browser and
// as a CommonJS module here).
const test = require('node:test');
const assert = require('node:assert/strict');

const L = require('../../src/renderer/logic');

test('visibleControls: line terminators and other control characters become visible symbols', () => {
  assert.equal(L.visibleControls('OK\r\n'), 'OK␍␊');
  assert.equal(L.visibleControls('a\tb'), 'a␉b');
  assert.equal(L.visibleControls('\u0000\u0007\u007f'), '···');
  assert.equal(L.visibleControls('plain text é€😀'), 'plain text é€😀');
  assert.equal(L.visibleControls(''), '');
});

test('visibleControls: the replacement character for invalid UTF-8 is kept as is', () => {
  assert.equal(L.visibleControls('a�b'), 'a�b');
});

test('formatClock: local time as HH:MM:SS.mmm with zero padding', () => {
  assert.equal(L.formatClock(new Date(2020, 0, 1, 3, 4, 5, 67).getTime()), '03:04:05.067');
  assert.equal(L.formatClock(new Date(2020, 0, 1, 23, 59, 59, 999).getTime()), '23:59:59.999');
  assert.equal(L.formatClock(new Date(2020, 0, 1, 0, 0, 0, 0).getTime()), '00:00:00.000');
});

test('hexLine and charLine: one entry per cell', () => {
  const cells = [{ hex: '40', char: '@', kind: 'printable' }, { hex: '0D', char: '␍', kind: 'cr' }];
  assert.equal(L.hexLine(cells), '40 0D');
  assert.equal(L.charLine(cells), '@␍');
  assert.equal(L.hexLine([]), '');
});

test('nextDefaultName: first free name, case-insensitive, numbered from 2', () => {
  assert.equal(L.nextDefaultName('New command', []), 'New command');
  assert.equal(L.nextDefaultName('New command', ['New command']), 'New command 2');
  assert.equal(L.nextDefaultName('New command', ['new COMMAND', 'New command 2']), 'New command 3');
});

const DATA = {
  schemaVersion: 1,
  devices: [
    { name: 'A', host: 'h1', port: 1, commands: [{ name: 'c1', text: 'x', mode: 'text', appendTerminator: 'none', kind: 'query' }] },
    { name: 'B', host: 'h2', port: 2, commands: [] },
  ],
};

test('withDevice: adds a new device, or replaces one by its old name, without mutating the input', () => {
  const snapshot = JSON.stringify(DATA);
  const added = L.withDevice(DATA, null, { name: 'C', host: 'h3', port: 3 });
  assert.deepEqual(added.devices.map((d) => d.name), ['A', 'B', 'C']);
  assert.deepEqual(added.devices[2].commands, [], 'a new device starts with no commands');

  const renamed = L.withDevice(DATA, 'A', { name: 'A2', host: 'hx', port: 9 });
  assert.deepEqual(renamed.devices[0], { name: 'A2', host: 'hx', port: 9, commands: DATA.devices[0].commands }, 'commands are kept');
  assert.equal(JSON.stringify(DATA), snapshot);
  assert.equal(L.withDevice(DATA, 'Nope', { name: 'Z', host: 'h', port: 1 }), null);
});

test('withoutDevice: removes by name; unknown name gives null', () => {
  assert.deepEqual(L.withoutDevice(DATA, 'A').devices.map((d) => d.name), ['B']);
  assert.equal(L.withoutDevice(DATA, 'Nope'), null);
});

test('withCommand: adds or replaces a command inside a device', () => {
  const command = { name: 'c2', text: 'y', mode: 'hex', appendTerminator: 'cr', kind: 'set' };
  const added = L.withCommand(DATA, 'B', null, command);
  assert.deepEqual(added.devices[1].commands, [command]);
  assert.notEqual(added.devices[1].commands[0], command, 'a copy is stored');

  const replaced = L.withCommand(DATA, 'A', 'c1', { ...command, name: 'c1b' });
  assert.deepEqual(replaced.devices[0].commands.map((c) => c.name), ['c1b']);
  assert.equal(L.withCommand(DATA, 'Nope', null, command), null);
  assert.equal(L.withCommand(DATA, 'A', 'Nope', command), null);
});

test('withoutCommand: removes a command; unknown device or command gives null', () => {
  assert.deepEqual(L.withoutCommand(DATA, 'A', 'c1').devices[0].commands, []);
  assert.equal(L.withoutCommand(DATA, 'A', 'Nope'), null);
  assert.equal(L.withoutCommand(DATA, 'Nope', 'c1'), null);
});

// A translation function like the page's: returns the key itself when a key is missing.
const TABLE = {
  'err.parse_error': 'Cannot read the input.',
  'parse.unknown_name': 'Unknown name at position {position}.',
  'blocked.read_only_blocks_set': 'Read-only mode blocks set commands.',
  'err.write_failed': 'Could not write ({errno}).',
  'err.not_connected': 'Not connected.',
  'err.unknown': 'Something went wrong ({code}).',
};
const t = (key, params = {}) => (TABLE[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(params[name]));

test('describeFailure: parse errors list the first problem with its position', () => {
  const text = L.describeFailure({ ok: false, code: 'parse_error', errors: [{ position: 3, length: 5, code: 'unknown_name' }] }, t);
  assert.equal(text, 'Cannot read the input. Unknown name at position 3.');
});

test('describeFailure: blocked results use the reason, write errors show the error code', () => {
  assert.equal(L.describeFailure({ ok: false, code: 'blocked', reason: 'read_only_blocks_set' }, t), 'Read-only mode blocks set commands.');
  assert.equal(L.describeFailure({ ok: false, code: 'write_failed', errno: 'EACCES' }, t), 'Could not write (EACCES).');
  assert.equal(L.describeFailure({ ok: false, code: 'not_connected' }, t), 'Not connected.');
});

test('describeFailure: an unknown code falls back to a generic message that still names the code', () => {
  assert.equal(L.describeFailure({ ok: false, code: 'brand_new' }, t), 'Something went wrong (brand_new).');
  assert.equal(L.describeFailure(undefined, t), 'Something went wrong (no_result).');
});

test('describeFailure: a parse error without a known detail still reports the main message', () => {
  assert.equal(L.describeFailure({ ok: false, code: 'parse_error', errors: [{ position: 0, length: 1, code: 'zzz' }] }, t), 'Cannot read the input. parse.zzz');
});

test('withDevice keeps the UDP settings of a device and drops them when it becomes TCP', () => {
  const data = { schemaVersion: 1, devices: [] };
  const udp = L.withDevice(data, null, { name: 'U', host: 'h', port: 5, transport: 'udp', localPort: 5100, acceptAnySource: true });
  assert.deepEqual(udp.devices[0], { name: 'U', host: 'h', port: 5, transport: 'udp', localPort: 5100, acceptAnySource: true, commands: [] });
  const edited = L.withDevice(udp, 'U', { name: 'U', host: 'h2', port: 6, transport: 'udp', localPort: 0, acceptAnySource: false });
  assert.deepEqual(edited.devices[0], { name: 'U', host: 'h2', port: 6, transport: 'udp', localPort: 0, acceptAnySource: false, commands: [] });
  const tcp = L.withDevice(edited, 'U', { name: 'U', host: 'h2', port: 6, transport: 'tcp', localPort: 5100 });
  assert.deepEqual(tcp.devices[0], { name: 'U', host: 'h2', port: 6, commands: [] }, 'a TCP device carries no UDP fields');
  assert.deepEqual(udp.devices[0].localPort, 5100, 'the input is not mutated');
});

