const test = require('node:test');
const assert = require('node:assert/strict');

const { validateDefinition } = require('../../src/core/device-definition');
const { createDeviceEngine } = require('../../src/core/device-engine');
const { toNotationParts, toPattern, LIMITS } = require('../../src/core/notation-escape');

const encoder = new TextEncoder();

function validate(source) {
  const result = validateDefinition(source);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  return result.definition;
}

function renderParts(parts) {
  const engine = createDeviceEngine(validate(replySource(parts)));
  return engine.handleMessage(encoder.encode('GO')).effects[0].bytes;
}

function replySource(parts, greeting = false) {
  const value = Array.isArray(parts) && parts.length === 1 ? parts[0] : parts;
  return greeting
    ? { schemaVersion: 1, name: 't', framing: { terminator: 'cr' }, greeting: value }
    : {
      schemaVersion: 1, name: 't', framing: { terminator: 'cr' },
      commands: [{ pattern: 'GO', reply: value }],
    };
}

test('exports the exact notation limits', () => {
  assert.deepEqual(LIMITS, {
    PART_UNITS: 1024, MAX_PARTS: 32, REPLY_BYTES: 4096, PATTERN_UNITS: 256,
  });
});

test('escapes the fixed reply table exactly', () => {
  const cases = [
    ['OK\r\n', ['OK[CR][LF]']],
    ['a[b]<c>\\d', ['a\\[b\\]\\<c\\>\\\\d']],
    ['0x0D', ['\\x30x0D']],
    ['abc0X1', ['abc\\x30X1']],
    ['00x', ['0\\x30x']],
    ['{x}*', ['{{x}}*']],
    ['\u0000\u001b\u007f\t', ['\\x00\\x1B\\x7F[TAB]']],
    ['é😀', ['é😀']],
    ['\ufeff', ['\\xEF\\xBB\\xBF']],
    ['', null],
  ];
  for (const [input, expected] of cases) {
    assert.deepEqual(toNotationParts(input), expected, JSON.stringify(input));
  }
});

test('escapes the fixed pattern table exactly', () => {
  assert.equal(toPattern('PWR ?'), 'PWR ?');
  assert.equal(toPattern('A{b}*'), 'A{{b}}**');
  assert.equal(toPattern(''), null);
  assert.equal(toPattern('x'.repeat(257)), null);
  assert.equal(toPattern('\ufeffx'), null);
});

test('splits greedily without splitting atomic tokens or surrogate pairs', () => {
  const plain = 'a'.repeat(3000);
  const plainParts = toNotationParts(plain);
  assert.deepEqual(plainParts.map((part) => part.length), [1024, 1024, 952]);
  assert.deepEqual(renderParts(plainParts), encoder.encode(plain));

  for (const [input, expectedLengths] of [
    [`${'a'.repeat(1023)}\r`, [1023, 4]],
    [`${'a'.repeat(1022)}\u001b`, [1022, 4]],
    [`${'a'.repeat(1023)}{`, [1023, 2]],
    [`${'a'.repeat(1023)}😀`, [1023, 2]],
  ]) {
    const parts = toNotationParts(input);
    assert.deepEqual(parts.map((part) => part.length), expectedLengths);
    assert.deepEqual(renderParts(parts), encoder.encode(input));
  }
});

test('returns null beyond the reply byte boundary', () => {
  assert.notEqual(toNotationParts('x'.repeat(4096)), null);
  assert.equal(toNotationParts('x'.repeat(4097)), null);
  assert.equal(toNotationParts('é'.repeat(2049)), null);
});

test('throws TypeError for non-strings and lone surrogates', () => {
  for (const value of [null, [], 1]) {
    assert.throws(() => toNotationParts(value), TypeError);
    assert.throws(() => toPattern(value), TypeError);
  }
  for (const text of ['\ud800', '\udc00', `a\ud800b`, `a\udc00b`]) {
    assert.throws(() => toNotationParts(text), TypeError);
    assert.throws(() => toPattern(text), TypeError);
  }
});

function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
}

const alphabet = [
  ...Array.from({ length: 32 }, (_, value) => String.fromCodePoint(value)),
  '\u007f', '\\', '[', ']', '<', '>', '{', '}', '*', '$', '0', '1', '9',
  'a', 'Z', ' ', 'é', '日', '本', '😀', '\ufeff', '\u0080', '\u0085', '\u009f',
  '0x', '0X',
];

function randomText(next, maxTokens = 20) {
  const count = 1 + (next() % maxTokens);
  let text = '';
  for (let index = 0; index < count; index += 1) text += alphabet[next() % alphabet.length];
  return text;
}

test('reply and greeting round-trip for 3000 seeded weighted strings', () => {
  const next = seeded(0x51f15e);
  for (let run = 0; run < 3000; run += 1) {
    const text = randomText(next);
    const parts = toNotationParts(text);
    assert.notEqual(parts, null);
    assert.deepEqual(renderParts(parts), encoder.encode(text), `notation run ${run}`);

    const commandEngine = createDeviceEngine(validate(replySource(parts)));
    const result = commandEngine.handleMessage(encoder.encode('GO'));
    assert.equal(result.effects.length, 1);
    assert.deepEqual(result.effects[0].bytes, encoder.encode(text), `reply run ${run}`);

    const greetingEngine = createDeviceEngine(validate(replySource(parts, true)));
    assert.deepEqual(greetingEngine.greeting(), encoder.encode(text), `greeting run ${run}`);
  }
});

test('patterns match exactly one seeded source string for 3000 cases', () => {
  const next = seeded(0x9e3779b9);
  for (let run = 0; run < 3000; run += 1) {
    let text = randomText(next, 12);
    if (text.startsWith('\ufeff')) text = `x${text}`;
    const pattern = toPattern(text);
    assert.notEqual(pattern, null);
    const definition = validate({
      schemaVersion: 1, name: 't', framing: { terminator: 'cr' },
      commands: [{ pattern, reply: 'HIT' }],
    });
    const engine = createDeviceEngine(definition);
    const hits = (candidate) => engine.handleMessage(encoder.encode(candidate)).effects
      .some((effect) => Buffer.from(effect.bytes).equals(Buffer.from('HIT')));
    assert.equal(hits(text), true, `source run ${run}`);

    const points = Array.from(text);
    const position = next() % (points.length + 1);
    const mutations = [
      `${text}x`, `x${text}`, points.slice(1).join(''),
      [...points.slice(0, position), 'q', ...points.slice(position)].join(''),
    ];
    for (const mutation of mutations) {
      if (mutation !== text) assert.equal(hits(mutation), false, `mutation run ${run}`);
    }
  }
});

test('unrepresentable seeded inputs return null without throwing', () => {
  const next = seeded(0xc001d00d);
  for (let run = 0; run < 3000; run += 1) {
    const choice = next() % 4;
    const text = choice === 0 ? ''
      : choice === 1 ? 'x'.repeat(4097 + (next() % 10))
        : choice === 2 ? '\u0000'.repeat(4097 + (next() % 10))
          : `\ufeff${randomText(next, 5)}`;
    if (choice === 3) assert.equal(toPattern(text), null);
    else assert.equal(toNotationParts(text), null);
  }
});
