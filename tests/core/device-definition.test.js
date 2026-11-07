const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  parseDefinitionText,
  validateDefinition,
} = require('../../src/core/device-definition');

function minimalDefinition() {
  return {
    schemaVersion: 1,
    name: 'Fictional Matrix',
    framing: { terminator: 'cr' },
  };
}

function completeDefinition() {
  return {
    schemaVersion: 1,
    name: 'Fictional Matrix',
    description: 'A fictional matrix switch used only in tests.',
    framing: { terminator: 'crlf' },
    greeting: ['READY ', '{var.power}', '[CR]'],
    connection: {
      maxConnections: 3,
      overLimit: 'accept_then_close',
      idleTimeoutMs: 5000,
      idleBehavior: 'stop_responding',
      startupQuietMs: 25,
      minCommandIntervalMs: 10,
    },
    variables: {
      power: { type: 'bool', initial: false },
      input: { type: 'enum', values: ['alpha', 'beta'], initial: 'alpha' },
      level: { type: 'int', min: -10, max: 10, initial: 0 },
      label: { type: 'string', maxLength: 12, initial: 'desk' },
    },
    commands: [
      {
        id: 'set_input',
        pattern: 'INPUT {value}',
        capture: { value: { map: { A: 'alpha', B: 'beta' } } },
        when: [{ var: 'power', is: true }],
        do: { set: { input: '{capture.value}' } },
        reply: null,
        otherwise: { reply: 'ERR OFF[CR]' },
        invalid: { reply: 'ERR INPUT[CR]' },
      },
    ],
    notifications: [
      { when: { var: 'input', changes: true }, send: 'INPUT {var.input}[CR]', to: 'all' },
    ],
    unknown: { reply: null },
  };
}

function errorsOf(value) {
  const result = validateDefinition(value);
  assert.equal(result.ok, false, 'definition must be rejected');
  return result.errors;
}

function hasError(errors, pointer, code) {
  assert.ok(
    errors.some((error) => error.pointer === pointer && error.code === code),
    `expected ${code} at ${pointer}: ${JSON.stringify(errors)}`,
  );
}

test('accepts and normalizes a complete definition without aliasing input', () => {
  const input = completeDefinition();
  const result = validateDefinition(input);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(Object.isFrozen(result.definition), true);

  input.name = 'Mutated';
  input.variables.input.values[0] = 'mutated';
  input.commands[0].pattern = 'MUTATED';
  assert.equal(result.definition.name, 'Fictional Matrix');
  assert.equal(result.definition.transport, 'tcp');
  assert.deepEqual(result.definition.variables.input.values, ['alpha', 'beta']);
  assert.equal(result.definition.commands[0].sourcePattern, 'INPUT {value}');
});

test('validates and normalizes transport including UDP greeting refusal', () => {
  for (const [input, expected] of [[undefined, 'tcp'], ['tcp', 'tcp'], ['udp', 'udp']]) {
    const value = minimalDefinition();
    if (input !== undefined) value.transport = input;
    const result = validateDefinition(value);
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(result.definition.transport, expected);
    assert.equal(Object.isFrozen(result.definition), true);
  }

  for (const transport of [null, 1, {}, []]) {
    const value = { ...minimalDefinition(), transport };
    assert.deepEqual(errorsOf(value), [{ pointer: '/transport', code: 'invalid_type' }]);
  }
  assert.deepEqual(errorsOf({ ...minimalDefinition(), transport: 'sctp' }), [
    { pointer: '/transport', code: 'invalid_value' },
  ]);

  for (const greeting of ['READY[CR]', ['READY', '[CR]'], null]) {
    const value = { ...minimalDefinition(), transport: 'udp', greeting };
    assert.deepEqual(errorsOf(value), [
      { pointer: '/greeting', code: 'greeting_not_supported_for_udp' },
    ]);
  }
  assert.equal(validateDefinition({ ...minimalDefinition(), transport: 'udp' }).ok, true);
  assert.equal(validateDefinition({ ...minimalDefinition(), transport: 'tcp', greeting: 'READY[CR]' }).ok, true);
});

test('bundled samples default to TCP transport', () => {
  const samples = ['matrix-switch.json', 'quirky-player.json'];
  for (const sample of samples) {
    const text = fs.readFileSync(path.join(__dirname, '../../src/samples', sample), 'utf8');
    const result = parseDefinitionText(text);
    assert.equal(result.ok, true, `${sample}: ${JSON.stringify(result.errors)}`);
    assert.equal(result.definition.transport, 'tcp', sample);
  }
});

test('parses BOM-prefixed JSON and reports size and syntax errors', () => {
  const parsed = parseDefinitionText(`\ufeff${JSON.stringify(minimalDefinition())}`);
  assert.equal(parsed.ok, true, JSON.stringify(parsed.errors));

  const baseText = JSON.stringify(minimalDefinition());
  const atLimit = `${baseText}${' '.repeat(1048576 - Buffer.byteLength(baseText, 'utf8'))}`;
  assert.equal(Buffer.byteLength(atLimit, 'utf8'), 1048576);
  assert.equal(parseDefinitionText(atLimit).ok, true);

  assert.deepEqual(parseDefinitionText(' '.repeat(1048577)), {
    ok: false,
    errors: [{ pointer: '', code: 'file_too_large' }],
  });

  const invalid = parseDefinitionText('{"name": }');
  assert.equal(invalid.ok, false);
  assert.equal(invalid.errors[0].pointer, '');
  assert.equal(invalid.errors[0].code, 'invalid_json');
  assert.ok(invalid.errors[0].detail.position === null
    || typeof invalid.errors[0].detail.position === 'number');
  assert.ok(invalid.errors[0].detail.line === null
    || typeof invalid.errors[0].detail.line === 'number');
  assert.ok(invalid.errors[0].detail.column === null
    || typeof invalid.errors[0].detail.column === 'number');
});

test('rejects nesting depth 17 when parsing JSON text', () => {
  const nested = `${'{"next":'.repeat(17)}null${'}'.repeat(17)}`;
  assert.deepEqual(parseDefinitionText(nested), {
    ok: false,
    errors: [{ pointer: '', code: 'too_deep' }],
  });
});

test('reports top-level field, type, value, and schema errors at exact pointers', () => {
  const value = {
    schemaVersion: 2,
    name: '   ',
    description: 7,
    framing: { terminator: 'nul', extra: true },
    connection: [],
    variables: [],
    commands: {},
    notifications: {},
    unknown: { reply: null, extra: true },
    extra: true,
  };
  const errors = errorsOf(value);
  hasError(errors, '/schemaVersion', 'unsupported_schema_version');
  hasError(errors, '/name', 'invalid_value');
  hasError(errors, '/description', 'invalid_type');
  hasError(errors, '/framing/terminator', 'invalid_value');
  hasError(errors, '/framing', 'unknown_field');
  hasError(errors, '/connection', 'not_an_object');
  hasError(errors, '/variables', 'not_an_object');
  hasError(errors, '/commands', 'not_an_array');
  hasError(errors, '/notifications', 'not_an_array');
  hasError(errors, '/unknown', 'unknown_field');
  hasError(errors, '', 'unknown_field');

  assert.deepEqual(errorsOf({}), [
    { pointer: '/schemaVersion', code: 'invalid_schema_version' },
    { pointer: '/name', code: 'missing_field' },
    { pointer: '/framing', code: 'missing_field' },
  ]);
});

test('applies connection defaults and validates connection values and types', () => {
  const value = minimalDefinition();
  value.connection = {};
  const result = validateDefinition(value);
  assert.equal(result.ok, true);
  assert.deepEqual(result.definition.connection, {
    maxConnections: 1,
    overLimit: 'refuse',
    idleTimeoutMs: 0,
    idleBehavior: 'close',
    startupQuietMs: 0,
    minCommandIntervalMs: 0,
  });

  value.connection = {
    maxConnections: 0,
    overLimit: 1,
    idleTimeoutMs: 999,
    idleBehavior: 'wait',
    startupQuietMs: 600001,
    minCommandIntervalMs: -1,
  };
  const errors = errorsOf(value);
  hasError(errors, '/connection/maxConnections', 'invalid_value');
  hasError(errors, '/connection/overLimit', 'invalid_type');
  hasError(errors, '/connection/idleTimeoutMs', 'invalid_value');
  hasError(errors, '/connection/idleBehavior', 'invalid_value');
  hasError(errors, '/connection/startupQuietMs', 'invalid_value');
  hasError(errors, '/connection/minCommandIntervalMs', 'invalid_value');
});

test('validates every variable kind, name, shape, initial value, and limits', () => {
  const value = minimalDefinition();
  value.variables = {
    Bad: { type: 'bool', initial: true },
    enum_var: { type: 'enum', values: ['x', 'x'], initial: 'z' },
    int_var: { type: 'int', min: 2, max: 1, initial: 3 },
    bool_var: { type: 'bool', initial: 'true', extra: 1 },
    string_var: { type: 'string', maxLength: 2, initial: 'abc' },
    mystery: { type: 'mystery', initial: 0 },
    missing: { type: 'bool' },
  };
  const errors = errorsOf(value);
  hasError(errors, '/variables/Bad', 'invalid_name');
  hasError(errors, '/variables/enum_var/values', 'invalid_value');
  hasError(errors, '/variables/enum_var/initial', 'out_of_range');
  hasError(errors, '/variables/int_var/min', 'invalid_value');
  hasError(errors, '/variables/int_var/initial', 'out_of_range');
  hasError(errors, '/variables/bool_var/initial', 'type_mismatch');
  hasError(errors, '/variables/bool_var', 'unknown_field');
  hasError(errors, '/variables/string_var/initial', 'out_of_range');
  hasError(errors, '/variables/mystery/type', 'invalid_value');
  hasError(errors, '/variables/missing/initial', 'missing_field');

  const atLimit = minimalDefinition();
  atLimit.variables = Object.fromEntries(Array.from({ length: 64 }, (_, index) => [
    `v${index}`, { type: 'bool', initial: false },
  ]));
  assert.equal(validateDefinition(atLimit).ok, true);
  atLimit.variables.v64 = { type: 'bool', initial: false };
  hasError(errorsOf(atLimit), '/variables', 'too_many');
});

test('enforces collection, pattern length, and nesting boundaries', () => {
  const commands = minimalDefinition();
  commands.commands = Array.from({ length: 500 }, () => ({ pattern: 'PING' }));
  assert.equal(validateDefinition(commands).ok, true);
  commands.commands.push({ pattern: 'PING' });
  hasError(errorsOf(commands), '/commands', 'too_many');

  const notifications = minimalDefinition();
  notifications.variables = { power: { type: 'bool', initial: false } };
  notifications.notifications = Array.from({ length: 100 }, () => ({
    when: { var: 'power', changes: true }, send: 'N',
  }));
  assert.equal(validateDefinition(notifications).ok, true);
  notifications.notifications.push({ when: { var: 'power', changes: true }, send: 'N' });
  hasError(errorsOf(notifications), '/notifications', 'too_many');

  const pattern = minimalDefinition();
  pattern.commands = [{ pattern: 'x'.repeat(256) }];
  assert.equal(validateDefinition(pattern).ok, true);
  pattern.commands[0].pattern += 'x';
  hasError(errorsOf(pattern), '/commands/0/pattern', 'invalid_value');

  let depth16 = {};
  let cursor = depth16;
  for (let depth = 1; depth < 16; depth += 1) {
    cursor.next = {};
    cursor = cursor.next;
  }
  assert.notDeepEqual(errorsOf(depth16), [{ pointer: '', code: 'too_deep' }]);
  cursor.next = {};
  assert.deepEqual(errorsOf(depth16), [{ pointer: '', code: 'too_deep' }]);
});

test('rejects reserved keys and skips their subtrees', () => {
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const value = JSON.parse(JSON.stringify(minimalDefinition()));
    value.variables = JSON.parse(`{"safe":{"type":"bool","initial":false,"${key}":{"deep":{"bad":true}}}}`);
    const errors = errorsOf(value);
    hasError(errors, `/variables/safe/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`, 'reserved_key');
    assert.equal(errors.some((error) => error.pointer.includes('/deep')), false);
  }
});

test('reports every pattern grammar reason and accepts all pattern escapes', () => {
  const cases = [
    ['', 'empty'],
    ['{bad', 'syntax'],
    ['{a}{b}', 'adjacent'],
    ['{a}*', 'adjacent'],
    ['{a}x{a}', 'duplicate_capture'],
    ['*x*', 'multiple_star'],
    ['{a}x{b}x{c}x{d}x{e}', 'too_many_captures'],
  ];
  for (const [pattern, reason] of cases) {
    const value = minimalDefinition();
    value.commands = [{ pattern }];
    const error = errorsOf(value).find((item) => item.code === 'invalid_pattern');
    assert.equal(error.pointer, '/commands/0/pattern');
    assert.equal(error.detail.reason, reason);
    assert.equal(typeof error.detail.index, 'number');
  }

  const escaped = minimalDefinition();
  escaped.commands = [{ pattern: '{{x}} ** {value}' }];
  assert.equal(validateDefinition(escaped).ok, true);
});

test('validates template grammar, references, notation, and arrays', () => {
  const value = minimalDefinition();
  value.variables = { power: { type: 'bool', initial: false } };
  value.greeting = ['{{{var.power}}}', '[CR]'];
  value.commands = [{
    pattern: 'SET {value}',
    reply: ['{capture.value}', '}}'],
  }];
  assert.equal(validateDefinition(value).ok, true);

  const cases = [
    ['greeting', '{', 'invalid_template'],
    ['greeting', '{var.missing}', 'unknown_reference'],
    ['greeting', '{capture.value}', 'unknown_reference'],
    ['greeting', '[NOPE]', 'invalid_notation'],
    ['greeting', [], 'invalid_value'],
    ['greeting', [7], 'invalid_type'],
  ];
  for (const [field, template, code] of cases) {
    const invalid = minimalDefinition();
    invalid[field] = template;
    const pointer = Array.isArray(template) && template.length > 0 ? `/${field}/0` : `/${field}`;
    hasError(errorsOf(invalid), pointer, code);
  }

  const notification = minimalDefinition();
  notification.variables = { power: { type: 'bool', initial: false } };
  notification.notifications = [{
    when: { var: 'power', changes: true }, send: '{capture.value}',
  }];
  hasError(errorsOf(notification), '/notifications/0/send', 'unknown_reference');
});

test('validates command fields, capture maps, conditions, sets, and duplicate ids', () => {
  const value = minimalDefinition();
  value.variables = {
    power: { type: 'bool', initial: false },
    input: { type: 'enum', values: ['alpha', 'beta'], initial: 'alpha' },
    count: { type: 'int', min: 0, max: 4, initial: 0 },
  };
  value.commands = [
    {
      id: 'same', pattern: 'SET {value}', caseInsensitive: 'yes',
      capture: {
        missing: {},
        value: { map: {} },
      },
      when: [
        { var: 'missing', is: true },
        { var: 'power', is: 'true' },
        { var: 'input', in: ['alpha', 'missing'] },
        { var: 'count', min: -1, max: 5 },
        { var: 'count', is: 0, isNot: 1 },
      ],
      do: { set: { missing: true, power: '{capture.missing}', input: '{capture.value}x' } },
      delayMs: -1,
    },
    { id: 'same', pattern: 'GET' },
  ];
  const errors = errorsOf(value);
  hasError(errors, '/commands/0/caseInsensitive', 'invalid_type');
  hasError(errors, '/commands/0/capture/missing', 'unknown_reference');
  hasError(errors, '/commands/0/capture/value/map', 'invalid_value');
  hasError(errors, '/commands/0/when/0/var', 'unknown_reference');
  hasError(errors, '/commands/0/when/1/is', 'type_mismatch');
  hasError(errors, '/commands/0/when/2/in/1', 'out_of_range');
  hasError(errors, '/commands/0/when/3/min', 'out_of_range');
  hasError(errors, '/commands/0/when/3/max', 'out_of_range');
  hasError(errors, '/commands/0/when/4', 'invalid_condition');
  hasError(errors, '/commands/0/do/set/missing', 'unknown_reference');
  hasError(errors, '/commands/0/do/set/power', 'unknown_reference');
  hasError(errors, '/commands/0/do/set/input', 'out_of_range');
  hasError(errors, '/commands/0/delayMs', 'invalid_value');
  hasError(errors, '/commands/1/id', 'duplicate_name');
});

test('accepts exact capture sources and treats similar strings as literals', () => {
  const value = minimalDefinition();
  value.variables = { label: { type: 'string', maxLength: 32, initial: '' } };
  value.commands = [{
    pattern: 'SET {value}',
    do: { set: { label: '{capture.value}' } },
  }, {
    pattern: 'LITERAL',
    do: { set: { label: 'x{capture.value}' } },
  }];
  assert.equal(validateDefinition(value).ok, true);
});

test('does not alias or freeze condition arrays from the input', () => {
  const value = minimalDefinition();
  value.variables = { input: { type: 'enum', values: ['alpha', 'beta'], initial: 'alpha' } };
  value.commands = [{ pattern: 'GET', when: [{ var: 'input', in: ['alpha'] }] }];
  const sourceArray = value.commands[0].when[0].in;
  const result = validateDefinition(value);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(Object.isFrozen(sourceArray), false);
  sourceArray[0] = 'beta';
  assert.deepEqual(result.definition.commands[0].when[0].in, ['alpha']);
});

test('validates notification shape and unknown reply nullability', () => {
  const value = minimalDefinition();
  value.variables = { power: { type: 'bool', initial: false } };
  value.notifications = [
    { when: { var: 'missing', changes: true }, send: 'N' },
    { when: { var: 'power', changes: false }, send: null, to: 'other' },
    { when: { var: 'power', changes: true, extra: true }, send: 'N' },
  ];
  value.unknown = { reply: null };
  const errors = errorsOf(value);
  hasError(errors, '/notifications/0/when/var', 'unknown_reference');
  hasError(errors, '/notifications/1/when', 'invalid_condition');
  hasError(errors, '/notifications/1/send', 'invalid_type');
  hasError(errors, '/notifications/1/to', 'invalid_value');
  hasError(errors, '/notifications/2/when', 'invalid_condition');
});

test('uses escaped JSON Pointer tokens for dynamic names', () => {
  const value = minimalDefinition();
  value.variables = { 'bad/name~': { type: 'bool', initial: false } };
  hasError(errorsOf(value), '/variables/bad~1name~0', 'invalid_name');
});

test('does not treat inherited object properties as defined variables', () => {
  const value = minimalDefinition();
  value.commands = [{
    pattern: 'PING',
    when: [{ var: 'constructor', is: true }],
    do: { set: { toString: true } },
  }];
  value.notifications = [{
    when: { var: 'constructor', changes: true },
    send: 'N',
  }];
  const errors = errorsOf(value);
  hasError(errors, '/commands/0/when/0/var', 'unknown_reference');
  hasError(errors, '/commands/0/do/set/toString', 'unknown_reference');
  hasError(errors, '/notifications/0/when/var', 'unknown_reference');
});

test('continues collecting independent errors after a structural error', () => {
  assert.deepEqual(errorsOf({ extra: Number.NaN }), [
    { pointer: '/extra', code: 'invalid_type' },
    { pointer: '', code: 'unknown_field' },
    { pointer: '/schemaVersion', code: 'invalid_schema_version' },
    { pointer: '/name', code: 'missing_field' },
    { pointer: '/framing', code: 'missing_field' },
  ]);

  assert.deepEqual(errorsOf({ connection: new Date(0) }), [
    { pointer: '/connection', code: 'invalid_type' },
    { pointer: '/schemaVersion', code: 'invalid_schema_version' },
    { pointer: '/name', code: 'missing_field' },
    { pointer: '/framing', code: 'missing_field' },
  ]);
});
