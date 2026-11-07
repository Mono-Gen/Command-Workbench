// Tests for the saved command-list validation. Expected values come from the plan (section 7):
// strict schema, schemaVersion 1, pinned field sets, size limits.
const test = require('node:test');
const assert = require('node:assert/strict');

const { validateStore, emptyStore, SCHEMA_VERSION } = require('../../src/core/command-store');

function validStore() {
  return {
    schemaVersion: 1,
    devices: [
      {
        name: 'Matrix',
        host: '192.0.2.10',
        port: 23,
        commands: [
          { name: 'Get power', text: 'GETPWR[CR]', mode: 'text', appendTerminator: 'none', kind: 'query' },
          { name: 'Power on', text: 'SETPWR 1[CR]', mode: 'text', appendTerminator: 'none', kind: 'set', expectsReply: false },
        ],
      },
    ],
  };
}

function codes(result) {
  assert.equal(result.ok, false, 'validation must fail');
  return result.errors.map((e) => `${e.path}:${e.code}`);
}

test('exports schema version 1 and an empty store that validates', () => {
  assert.equal(SCHEMA_VERSION, 1);
  assert.deepEqual(emptyStore(), { schemaVersion: 1, devices: [] });
  assert.equal(validateStore(emptyStore()).ok, true);
});

test('accepts a valid store and fills expectsReply from kind when missing', () => {
  const result = validateStore(validStore());
  assert.equal(result.ok, true);
  const [query, set] = result.data.devices[0].commands;
  assert.equal(query.expectsReply, true, 'a query is expected to reply by default');
  assert.equal(set.expectsReply, false, 'an explicit false is kept');
  const setDefault = validStore();
  delete setDefault.devices[0].commands[1].expectsReply;
  assert.equal(validateStore(setDefault).data.devices[0].commands[1].expectsReply, false, 'a set is silent by default');
});

test('does not mutate its input and returns a copy', () => {
  const input = validStore();
  const snapshot = JSON.stringify(input);
  const result = validateStore(input);
  assert.equal(JSON.stringify(input), snapshot);
  assert.notEqual(result.data, input);
});

test('rejects non-object roots', () => {
  for (const bad of [null, undefined, 1, 'x', [], true]) {
    assert.deepEqual(codes(validateStore(bad)), ['$:not_an_object']);
  }
});

test('schema version: unsupported numbers and invalid types are distinguished', () => {
  assert.deepEqual(codes(validateStore({ schemaVersion: 2, devices: [] })), ['schemaVersion:unsupported_schema_version']);
  assert.deepEqual(codes(validateStore({ schemaVersion: 0, devices: [] })), ['schemaVersion:unsupported_schema_version']);
  assert.deepEqual(codes(validateStore({ schemaVersion: '1', devices: [] })), ['schemaVersion:invalid_schema_version']);
  assert.deepEqual(codes(validateStore({ devices: [] })), ['schemaVersion:invalid_schema_version']);
});

test('unknown fields are rejected (no silent data loss on save)', () => {
  const store = validStore();
  store.extra = 1;
  store.devices[0].colour = 'red';
  store.devices[0].commands[0].mod = 'x';
  assert.deepEqual(codes(validateStore(store)).sort(), [
    '$:unknown_field',
    'devices[0]:unknown_field',
    'devices[0].commands[0]:unknown_field',
  ].sort());
});

test('devices must be an array with at most 200 entries', () => {
  assert.deepEqual(codes(validateStore({ schemaVersion: 1, devices: {} })), ['devices:not_an_array']);
  const many = { schemaVersion: 1, devices: Array.from({ length: 201 }, (_, i) => ({ name: `d${i}`, host: 'h', port: 1, commands: [] })) };
  assert.deepEqual(codes(validateStore(many)), ['devices:too_many']);
  many.devices.length = 200;
  assert.equal(validateStore(many).ok, true);
});

test('device name: required, 1-100 characters, unique', () => {
  const store = validStore();
  store.devices[0].name = '';
  assert.deepEqual(codes(validateStore(store)), ['devices[0].name:invalid_name']);
  store.devices[0].name = 'x'.repeat(101);
  assert.deepEqual(codes(validateStore(store)), ['devices[0].name:invalid_name']);
  store.devices[0].name = 'x'.repeat(100);
  assert.equal(validateStore(store).ok, true);
  store.devices.push({ ...validStore().devices[0], name: 'x'.repeat(100) });
  assert.deepEqual(codes(validateStore(store)), ['devices[1].name:duplicate_name']);
});

test('host: non-empty, no whitespace or control characters, at most 253 characters', () => {
  for (const bad of ['', ' ', 'a b', 'a\tb', 'a\nb', 'x'.repeat(254), 5, null]) {
    const store = validStore();
    store.devices[0].host = bad;
    assert.deepEqual(codes(validateStore(store)), ['devices[0].host:invalid_host'], `host ${JSON.stringify(bad)}`);
  }
  for (const good of ['192.0.2.10', 'device.local', 'fe80::1', 'x'.repeat(253)]) {
    const store = validStore();
    store.devices[0].host = good;
    assert.equal(validateStore(store).ok, true, `host ${good}`);
  }
});

test('port: integer from 1 to 65535', () => {
  for (const bad of [0, -1, 65536, 1.5, '23', null, NaN]) {
    const store = validStore();
    store.devices[0].port = bad;
    assert.deepEqual(codes(validateStore(store)), ['devices[0].port:invalid_port'], `port ${String(bad)}`);
  }
  for (const good of [1, 65535]) {
    const store = validStore();
    store.devices[0].port = good;
    assert.equal(validateStore(store).ok, true);
  }
});

test('commands: array, at most 1000, names unique per device', () => {
  const store = validStore();
  store.devices[0].commands = 'x';
  assert.deepEqual(codes(validateStore(store)), ['devices[0].commands:not_an_array']);
  store.devices[0].commands = Array.from({ length: 1001 }, (_, i) => ({ name: `c${i}`, text: 'A', mode: 'text', appendTerminator: 'none', kind: 'query' }));
  assert.deepEqual(codes(validateStore(store)), ['devices[0].commands:too_many']);

  const dup = validStore();
  dup.devices[0].commands[1].name = dup.devices[0].commands[0].name;
  assert.deepEqual(codes(validateStore(dup)), ['devices[0].commands[1].name:duplicate_name']);

  const otherDevice = validStore();
  otherDevice.devices.push({ name: 'Other', host: 'h', port: 1, commands: [{ ...otherDevice.devices[0].commands[0] }] });
  assert.equal(validateStore(otherDevice).ok, true, 'the same command name on another device is fine');
});

test('command fields: name, text, mode, appendTerminator, kind, expectsReply', () => {
  const cases = [
    ['name', '', 'invalid_name'],
    ['name', 'x'.repeat(101), 'invalid_name'],
    ['text', '', 'invalid_text'],
    ['text', 'A'.repeat(65537), 'invalid_text'],
    ['text', 5, 'invalid_text'],
    ['mode', 'binary', 'invalid_mode'],
    ['appendTerminator', 'cr+lf', 'invalid_terminator'],
    ['kind', 'unknown', 'invalid_kind'],
    ['kind', undefined, 'invalid_kind'],
    ['expectsReply', 'yes', 'invalid_expects_reply'],
  ];
  for (const [field, value, code] of cases) {
    const store = validStore();
    store.devices[0].commands[0][field] = value;
    if (value === undefined) delete store.devices[0].commands[0][field];
    assert.deepEqual(codes(validateStore(store)), [`devices[0].commands[0].${field}:${code}`], `${field}=${String(value).slice(0, 10)}`);
  }
  const boundary = validStore();
  boundary.devices[0].commands[0].text = 'A'.repeat(65536);
  boundary.devices[0].commands[0].name = 'x'.repeat(100);
  assert.equal(validateStore(boundary).ok, true);
});

test('every enum value is accepted', () => {
  for (const mode of ['text', 'hex']) {
    for (const appendTerminator of ['none', 'cr', 'lf', 'crlf']) {
      for (const kind of ['query', 'set']) {
        const store = validStore();
        Object.assign(store.devices[0].commands[0], { mode, appendTerminator, kind });
        assert.equal(validateStore(store).ok, true, `${mode}/${appendTerminator}/${kind}`);
      }
    }
  }
});

test('collects every error, with paths', () => {
  const store = validStore();
  store.devices[0].port = 0;
  store.devices[0].commands[0].kind = 'x';
  assert.deepEqual(codes(validateStore(store)).sort(), [
    'devices[0].commands[0].kind:invalid_kind',
    'devices[0].port:invalid_port',
  ].sort());
});

test('a UDP device keeps its transport, local port and source setting; a TCP device stays unchanged', () => {
  const store = validStore();
  store.devices.push({ name: 'Lamp', host: '10.0.0.20', port: 5000, transport: 'udp', localPort: 5100, acceptAnySource: true, commands: [] });
  store.devices.push({ name: 'Plain UDP', host: '10.0.0.21', port: 5001, transport: 'udp', commands: [] });
  store.devices.push({ name: 'Explicit TCP', host: '10.0.0.22', port: 5002, transport: 'tcp', commands: [] });
  const result = validateStore(store);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.data.devices[1], { name: 'Lamp', host: '10.0.0.20', port: 5000, transport: 'udp', localPort: 5100, acceptAnySource: true, commands: [] });
  assert.deepEqual(result.data.devices[2], { name: 'Plain UDP', host: '10.0.0.21', port: 5001, transport: 'udp', commands: [] });
  assert.deepEqual(result.data.devices[3], { name: 'Explicit TCP', host: '10.0.0.22', port: 5002, commands: [] }, 'tcp is the default and is not stored');
  assert.equal(Object.hasOwn(result.data.devices[0], 'transport'), false);
});

test('UDP device fields are validated', () => {
  const bad = (device) => {
    const store = validStore();
    store.devices.push({ name: 'X', host: 'h', port: 1, commands: [], ...device });
    // `codes` gives "path:code"; only the code matters here.
    return codes(validateStore(store)).map((entry) => entry.split(':').pop());
  };
  assert.ok(bad({ transport: 'sctp' }).includes('invalid_transport'));
  assert.ok(bad({ transport: 5 }).includes('invalid_transport'));
  for (const localPort of [80, 1023, 65536, -1, 1.5, '5100', null]) {
    assert.ok(bad({ transport: 'udp', localPort }).includes('invalid_local_port'), String(localPort));
  }
  for (const value of ['yes', 1, null]) assert.ok(bad({ transport: 'udp', acceptAnySource: value }).includes('invalid_accept_any_source'), String(value));
  assert.ok(bad({ localPort: 5100 }).includes('udp_only_field'), 'UDP settings on a TCP device');
  assert.ok(bad({ transport: 'tcp', acceptAnySource: true }).includes('udp_only_field'));
  assert.equal(validateStore({ schemaVersion: 1, devices: [{ name: 'Ok', host: 'h', port: 1, transport: 'udp', localPort: 0, commands: [] }] }).ok, true);
});

