const test = require('node:test');
const assert = require('node:assert/strict');

const { validateDefinition } = require('../../src/core/device-definition');
const { createDeviceEngine } = require('../../src/core/device-engine');

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function baseDefinition() {
  return {
    schemaVersion: 1,
    name: 'Fictional Matrix',
    framing: { terminator: 'cr' },
    variables: {
      power: { type: 'bool', initial: false },
      input: { type: 'enum', values: ['alpha', 'beta'], initial: 'alpha' },
      count: { type: 'int', min: -10, max: 10, initial: 0 },
      label: { type: 'string', maxLength: 5, initial: '' },
    },
  };
}

function engineFrom(source) {
  const result = validateDefinition(source);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  return createDeviceEngine(result.definition);
}

function handle(engine, text) {
  return engine.handleMessage(encoder.encode(text));
}

function effectText(effect) {
  return decoder.decode(effect.bytes);
}

test('rejects anything except a validated definition and invalid byte input', () => {
  assert.throws(() => createDeviceEngine(baseDefinition()), TypeError);
  assert.throws(() => createDeviceEngine(null), TypeError);
  const engine = engineFrom(baseDefinition());
  assert.throws(() => engine.handleMessage([]), TypeError);
  assert.throws(() => engine.applyStatePatch(null), TypeError);
});

test('handles empty, unknown, and undecodable messages', () => {
  const source = baseDefinition();
  source.unknown = { reply: 'UNKNOWN[CR]' };
  const engine = engineFrom(source);

  assert.deepEqual(engine.handleMessage(new Uint8Array()), {
    outcome: 'empty', commandIndex: null, effects: [], changes: [],
  });

  const unknown = handle(engine, 'NOPE');
  assert.equal(unknown.outcome, 'unknown');
  assert.equal(unknown.commandIndex, null);
  assert.equal(effectText(unknown.effects[0]), 'UNKNOWN\r');
  assert.deepEqual(unknown.effects[0], {
    type: 'send', to: 'sender', kind: 'reply', bytes: unknown.effects[0].bytes, delayMs: 0,
  });

  const undecodable = engine.handleMessage(Uint8Array.from([0xff]));
  assert.equal(undecodable.outcome, 'unknown_undecodable');
  assert.equal(effectText(undecodable.effects[0]), 'UNKNOWN\r');
});

test('matches literals, captures, stars, whole text, and first command only', () => {
  const source = baseDefinition();
  source.commands = [
    { pattern: 'PING', reply: 'FIRST' },
    { pattern: 'PING', reply: 'SECOND' },
    { pattern: 'SET {value} END', reply: '{capture.value}' },
    { pattern: 'WRAP * END', reply: 'STAR' },
    { pattern: 'TAIL {value}', reply: '{capture.value}' },
  ];
  const engine = engineFrom(source);

  assert.equal(effectText(handle(engine, 'PING').effects[0]), 'FIRST');
  assert.equal(effectText(handle(engine, 'SET beta END').effects[0]), 'beta');
  assert.equal(handle(engine, 'SET beta extra END').outcome, 'unknown');
  assert.equal(handle(engine, 'WRAP  any spaces  END').outcome, 'matched');
  assert.equal(effectText(handle(engine, 'TAIL omega').effects[0]), 'omega');
  assert.equal(handle(engine, 'PING trailing').outcome, 'unknown');
});

test('uses the earliest next literal without greedy backtracking', () => {
  const source = baseDefinition();
  source.commands = [{ pattern: 'A{left}X{right}Z', reply: '{capture.left}|{capture.right}' }];
  const engine = engineFrom(source);

  const outcome = handle(engine, 'AoneXtwoXthreeZ');
  assert.equal(outcome.outcome, 'matched');
  assert.equal(effectText(outcome.effects[0]), 'one|twoXthree');
});

test('matches ASCII case-insensitively but preserves captures and non-ASCII case', () => {
  const source = baseDefinition();
  source.commands = [
    { pattern: 'set {value} end', caseInsensitive: true, reply: '{capture.value}' },
    { pattern: 'ÉCHO', caseInsensitive: true, reply: 'NONASCII' },
  ];
  const engine = engineFrom(source);

  assert.equal(effectText(handle(engine, 'SET MiXeD END').effects[0]), 'MiXeD');
  assert.equal(handle(engine, 'éCHO').outcome, 'unknown');
});

test('supports silent success, post-state replies, map hits, and map misses', () => {
  const source = baseDefinition();
  source.commands = [
    { pattern: 'ON', do: { set: { power: true } } },
    {
      pattern: 'INPUT {value}',
      capture: { value: { map: { A: 'alpha', B: 'beta' } } },
      do: { set: { input: '{capture.value}' } },
      reply: 'NOW {var.input}/{capture.value}',
      invalid: { reply: 'BAD {capture.value}' },
    },
  ];
  const engine = engineFrom(source);

  const silent = handle(engine, 'ON');
  assert.equal(silent.outcome, 'matched');
  assert.deepEqual(silent.effects, []);
  assert.deepEqual(silent.changes, [{ var: 'power', from: false, to: true }]);

  const hit = handle(engine, 'INPUT B');
  assert.equal(hit.outcome, 'matched');
  assert.equal(effectText(hit.effects[0]), 'NOW beta/beta');
  assert.deepEqual(hit.changes, [{ var: 'input', from: 'alpha', to: 'beta' }]);

  const miss = handle(engine, 'INPUT Z');
  assert.equal(miss.outcome, 'invalid');
  assert.equal(effectText(miss.effects[0]), 'BAD Z');
  assert.deepEqual(miss.changes, []);
});

test('converts integer capture values with the exact accepted syntax', () => {
  const source = baseDefinition();
  source.commands = [{
    pattern: 'INT {token}',
    capture: { token: { map: {
      zero: '0', negative: '-1', padded: '007', plus: '+1', exponent: '1e3',
      spaced: ' 1', huge: '9007199254740993',
    } } },
    do: { set: { count: '{capture.token}' } },
    reply: '{var.count}',
    invalid: { reply: 'INVALID' },
  }];
  const engine = engineFrom(source);

  const cases = [
    ['zero', 'matched', 0],
    ['negative', 'matched', -1],
    ['padded', 'invalid', 0],
    ['plus', 'invalid', 0],
    ['exponent', 'invalid', 0],
    ['spaced', 'invalid', 0],
    ['huge', 'invalid', 0],
  ];
  for (const [token, expectedOutcome, expectedValue] of cases) {
    engine.reset();
    const outcome = handle(engine, `INT ${token}`);
    assert.equal(outcome.outcome, expectedOutcome, token);
    assert.equal(engine.getState().values.count, expectedValue, token);
  }
});

test('converts bool, enum, and string captures and rejects invalid values', () => {
  const boolSource = baseDefinition();
  boolSource.commands = [{
    pattern: 'BOOL {value}', do: { set: { power: '{capture.value}' } },
    invalid: { reply: 'BAD' },
  }];
  const boolEngine = engineFrom(boolSource);
  assert.equal(handle(boolEngine, 'BOOL true').outcome, 'matched');
  assert.equal(boolEngine.getState().values.power, true);
  assert.equal(handle(boolEngine, 'BOOL false').outcome, 'matched');
  assert.equal(boolEngine.getState().values.power, false);
  assert.equal(handle(boolEngine, 'BOOL TRUE').outcome, 'invalid');

  const enumSource = baseDefinition();
  enumSource.commands = [{
    pattern: 'ENUM {value}', do: { set: { input: '{capture.value}' } },
    invalid: { reply: 'BAD' },
  }];
  const enumEngine = engineFrom(enumSource);
  assert.equal(handle(enumEngine, 'ENUM beta').outcome, 'matched');
  assert.equal(handle(enumEngine, 'ENUM BETA').outcome, 'invalid');

  const stringSource = baseDefinition();
  stringSource.commands = [{
    pattern: 'STR {value}',
    capture: { value: { map: { number: 12, bool: true, long: 'abcdef' } } },
    do: { set: { label: '{capture.value}' } },
    invalid: { reply: 'BAD' },
  }];
  const stringEngine = engineFrom(stringSource);
  assert.equal(handle(stringEngine, 'STR number').outcome, 'matched');
  assert.equal(stringEngine.getState().values.label, '12');
  assert.equal(handle(stringEngine, 'STR bool').outcome, 'matched');
  assert.equal(stringEngine.getState().values.label, 'true');
  assert.equal(handle(stringEngine, 'STR long').outcome, 'invalid');
});

test('applies multi-variable sets atomically', () => {
  const source = baseDefinition();
  source.commands = [{
    pattern: 'SET {value}',
    do: { set: { power: true, count: '{capture.value}' } },
    invalid: { reply: 'BAD' },
  }];
  const engine = engineFrom(source);
  const outcome = handle(engine, 'SET nope');
  assert.equal(outcome.outcome, 'invalid');
  assert.deepEqual(engine.getState().values, {
    power: false, input: 'alpha', count: 0, label: '',
  });
  assert.deepEqual(outcome.changes, []);
});

test('evaluates every condition operator with strict typed comparisons', () => {
  const source = baseDefinition();
  source.commands = [
    { pattern: 'IS', when: [{ var: 'power', is: false }], reply: 'YES', otherwise: { reply: 'NO' } },
    { pattern: 'NOT', when: [{ var: 'input', isNot: 'beta' }], reply: 'YES', otherwise: { reply: 'NO' } },
    { pattern: 'IN', when: [{ var: 'input', in: ['alpha', 'beta'] }], reply: 'YES' },
    { pattern: 'RANGE', when: [{ var: 'count', min: -1, max: 1 }], reply: 'YES' },
  ];
  const engine = engineFrom(source);
  for (const command of ['IS', 'NOT', 'IN', 'RANGE']) {
    assert.equal(effectText(handle(engine, command).effects[0]), 'YES', command);
  }
  engine.applyStatePatch({ power: true, input: 'beta', count: 2 });
  assert.equal(handle(engine, 'IS').outcome, 'otherwise');
  assert.equal(handle(engine, 'NOT').outcome, 'otherwise');
  assert.equal(handle(engine, 'RANGE').outcome, 'otherwise');
});

test('distinguishes present silent handlers from absent unknown fall-through', () => {
  const source = baseDefinition();
  source.unknown = { reply: 'UNKNOWN' };
  source.commands = [
    { pattern: 'PRESENT', when: [{ var: 'power', is: true }], otherwise: {} },
    { pattern: 'ABSENT', when: [{ var: 'power', is: true }] },
    { pattern: 'BAD_PRESENT {value}', do: { set: { count: '{capture.value}' } }, invalid: {} },
    { pattern: 'BAD_ABSENT {value}', do: { set: { count: '{capture.value}' } } },
  ];
  const engine = engineFrom(source);

  assert.deepEqual(handle(engine, 'PRESENT').effects, []);
  assert.equal(effectText(handle(engine, 'ABSENT').effects[0]), 'UNKNOWN');
  assert.deepEqual(handle(engine, 'BAD_PRESENT nope').effects, []);
  assert.equal(effectText(handle(engine, 'BAD_ABSENT nope').effects[0]), 'UNKNOWN');
});

test('renders templates with escapes, references, non-ASCII, and notation boundaries', () => {
  const source = baseDefinition();
  source.variables.label.initial = '[CR]';
  source.commands = [{
    pattern: 'SHOW {value}',
    reply: ['{{', '{var.label}', '}}/', '{capture.value}', '/é[CR]'],
  }];
  const engine = engineFrom(source);
  const outcome = handle(engine, 'SHOW [LF]');
  assert.deepEqual(Array.from(outcome.effects[0].bytes), Array.from(encoder.encode('{[CR]}/[LF]/é\r')));
});

test('keeps successful changes and notifications when a reply is too large', () => {
  const source = baseDefinition();
  source.commands = [{ pattern: 'ON', do: { set: { power: true } }, reply: 'x'.repeat(1024) }];
  source.commands[0].reply = Array(5).fill('x'.repeat(1024));
  source.notifications = [{ when: { var: 'power', changes: true }, send: 'CHANGED' }];
  const engine = engineFrom(source);
  const outcome = handle(engine, 'ON');
  assert.equal(outcome.outcome, 'reply_too_large');
  assert.deepEqual(outcome.changes, [{ var: 'power', from: false, to: true }]);
  assert.equal(outcome.effects.length, 1);
  assert.equal(outcome.effects[0].kind, 'notification');
});

test('emits changed-variable notifications once in definition order after reply', () => {
  const source = baseDefinition();
  source.commands = [{
    pattern: 'CHANGE',
    do: { set: { power: true, input: 'beta', count: 0 } },
    reply: 'REPLY',
    delayMs: 25,
  }];
  source.notifications = [
    { when: { var: 'input', changes: true }, send: 'INPUT {var.input}', to: 'sender' },
    { when: { var: 'power', changes: true }, send: 'POWER {var.power}', to: 'all' },
    { when: { var: 'count', changes: true }, send: 'COUNT' },
  ];
  const engine = engineFrom(source);
  const outcome = handle(engine, 'CHANGE');
  assert.deepEqual(outcome.effects.map((effect) => [
    effect.kind, effect.to, effect.delayMs, effectText(effect),
  ]), [
    ['reply', 'sender', 25, 'REPLY'],
    ['notification', 'sender', 0, 'INPUT beta'],
    ['notification', 'all', 0, 'POWER true'],
  ]);

  assert.deepEqual(handle(engine, 'CHANGE').effects.map((effect) => effect.kind), ['reply']);
});

test('does not notify on invalid or otherwise paths', () => {
  const source = baseDefinition();
  source.commands = [
    {
      pattern: 'BAD {value}', do: { set: { count: '{capture.value}' } },
      invalid: { reply: 'BAD' },
    },
    {
      pattern: 'OFF', when: [{ var: 'power', is: true }], do: { set: { input: 'beta' } },
      otherwise: { reply: 'OFF' },
    },
  ];
  source.notifications = [
    { when: { var: 'count', changes: true }, send: 'COUNT' },
    { when: { var: 'input', changes: true }, send: 'INPUT' },
  ];
  const engine = engineFrom(source);
  assert.deepEqual(handle(engine, 'BAD nope').effects.map((effect) => effect.kind), ['reply']);
  assert.deepEqual(handle(engine, 'OFF').effects.map((effect) => effect.kind), ['reply']);
});

test('applies state patches atomically and returns notification effects', () => {
  const source = baseDefinition();
  source.notifications = [
    { when: { var: 'power', changes: true }, send: 'P {var.power}', to: 'sender' },
    { when: { var: 'label', changes: true }, send: 'L {var.label}', to: 'all' },
  ];
  const engine = engineFrom(source);

  const result = engine.applyStatePatch({ power: true, label: 12 });
  assert.deepEqual(result.changes, [
    { var: 'power', from: false, to: true },
    { var: 'label', from: '', to: '12' },
  ]);
  assert.deepEqual(result.effects.map((effect) => [effect.to, effectText(effect)]), [
    ['sender', 'P true'], ['all', 'L 12'],
  ]);

  const before = engine.getState();
  assert.throws(() => engine.applyStatePatch({ power: false, missing: true }), TypeError);
  assert.deepEqual(engine.getState(), before);
  assert.throws(() => engine.applyStatePatch({ count: '007' }), TypeError);
  assert.deepEqual(engine.getState(), before);
});

test('resets state, renders greeting, and returns independent copies', () => {
  const source = baseDefinition();
  source.greeting = 'HELLO {var.input}[CR]';
  source.commands = [{ pattern: 'ON', do: { set: { power: true, input: 'beta' } } }];
  const engine = engineFrom(source);

  const state = engine.getState();
  state.values.input = 'mutated';
  assert.equal(engine.getState().values.input, 'alpha');
  const greeting = engine.greeting();
  assert.equal(decoder.decode(greeting), 'HELLO alpha\r');
  greeting[0] = 0;
  assert.equal(decoder.decode(engine.greeting()), 'HELLO alpha\r');

  handle(engine, 'ON');
  engine.reset();
  assert.deepEqual(engine.getState().values, {
    power: false, input: 'alpha', count: 0, label: '',
  });
});

test('returns null for missing or oversized greetings and skips oversized notifications', () => {
  assert.equal(engineFrom(baseDefinition()).greeting(), null);

  const source = baseDefinition();
  source.greeting = Array(5).fill('x'.repeat(1024));
  source.commands = [{ pattern: 'ON', do: { set: { power: true } } }];
  source.notifications = [{
    when: { var: 'power', changes: true }, send: Array(5).fill('x'.repeat(1024)),
  }];
  const engine = engineFrom(source);
  assert.equal(engine.greeting(), null);
  assert.deepEqual(handle(engine, 'ON').effects, []);
});

test('is deterministic for identical initial state and input and returns fresh bytes', () => {
  const source = baseDefinition();
  source.commands = [{ pattern: 'PING', reply: 'PONG' }];
  const firstEngine = engineFrom(source);
  const secondEngine = engineFrom(source);
  const first = handle(firstEngine, 'PING');
  const second = handle(secondEngine, 'PING');
  assert.deepEqual(first, second);
  assert.notEqual(first.effects[0].bytes, second.effects[0].bytes);

  first.effects[0].bytes[0] = 0;
  assert.equal(effectText(handle(firstEngine, 'PING').effects[0]), 'PONG');
});
