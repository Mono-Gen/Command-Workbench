const test = require('node:test');
const assert = require('node:assert/strict');

const { createFramer } = require('../../src/core/framing');

function simplify(events) {
  return events.map((event) => event.type === 'message'
    ? { type: 'message', bytes: Array.from(event.bytes) }
    : event);
}

test('frames CR, LF, and exact CRLF terminators', () => {
  const cases = [
    ['cr', [0x41, 0x0a, 0x42, 0x0d], [0x41, 0x0a, 0x42]],
    ['lf', [0x41, 0x0d, 0x42, 0x0a], [0x41, 0x0d, 0x42]],
    ['crlf', [0x41, 0x0a, 0x42, 0x0d, 0x0a], [0x41, 0x0a, 0x42]],
  ];

  for (const [terminator, input, expected] of cases) {
    const framer = createFramer({ terminator });
    assert.deepEqual(simplify(framer.push(Uint8Array.from(input))), [
      { type: 'message', bytes: expected },
    ]);
  }
});

test('returns several and empty messages from one chunk', () => {
  const framer = createFramer({ terminator: 'lf' });
  assert.deepEqual(simplify(framer.push(Uint8Array.from([0x0a, 0x41, 0x0a, 0x0a]))), [
    { type: 'message', bytes: [] },
    { type: 'message', bytes: [0x41] },
    { type: 'message', bytes: [] },
  ]);
});

test('is invariant across every two-part split including split CRLF', () => {
  const stream = Uint8Array.from([
    0x41, 0x0d, 0x0a,
    0x0d, 0x0a,
    0x42, 0x0a, 0x43, 0x0d, 0x0a,
  ]);
  const expected = [
    { type: 'message', bytes: [0x41] },
    { type: 'message', bytes: [] },
    { type: 'message', bytes: [0x42, 0x0a, 0x43] },
  ];

  for (let split = 0; split <= stream.length; split += 1) {
    const framer = createFramer({ terminator: 'crlf' });
    const events = [
      ...framer.push(stream.slice(0, split)),
      ...framer.push(stream.slice(split)),
    ];
    assert.deepEqual(simplify(events), expected, `split ${split} must preserve events`);
  }

  const bytewise = createFramer({ terminator: 'crlf' });
  const events = [];
  for (const byte of stream) {
    events.push(...bytewise.push(Uint8Array.of(byte)));
  }
  assert.deepEqual(simplify(events), expected);
});

test('is invariant across every possible partition of a stream', () => {
  const stream = Uint8Array.from([0x41, 0x0d, 0x0a, 0x42, 0x0d, 0x0a, 0x0d, 0x0a]);
  const expected = [
    { type: 'message', bytes: [0x41] },
    { type: 'message', bytes: [0x42] },
    { type: 'message', bytes: [] },
  ];
  const boundaryCount = stream.length - 1;

  for (let mask = 0; mask < 2 ** boundaryCount; mask += 1) {
    const framer = createFramer({ terminator: 'crlf' });
    const events = [];
    let start = 0;
    for (let boundary = 0; boundary < boundaryCount; boundary += 1) {
      if ((mask & (1 << boundary)) !== 0) {
        events.push(...framer.push(stream.slice(start, boundary + 1)));
        start = boundary + 1;
      }
    }
    events.push(...framer.push(stream.slice(start)));
    assert.deepEqual(simplify(events), expected, `partition mask ${mask} must preserve events`);
  }
});

test('allows the maximum length and overflows at maximum plus one', () => {
  const atLimit = createFramer({ terminator: 'cr', maxMessageBytes: 3 });
  assert.deepEqual(simplify(atLimit.push(Uint8Array.from([1, 2, 3, 0x0d]))), [
    { type: 'message', bytes: [1, 2, 3] },
  ]);

  const overLimit = createFramer({ terminator: 'cr', maxMessageBytes: 3 });
  assert.deepEqual(simplify(overLimit.push(Uint8Array.from([
    1, 2, 3, 4, 5, 0x0d, 6, 0x0d,
  ]))), [
    { type: 'overflow' },
    { type: 'message', bytes: [6] },
  ]);

  const zeroLimit = createFramer({ terminator: 'lf', maxMessageBytes: 0 });
  assert.deepEqual(simplify(zeroLimit.push(Uint8Array.from([0x0a, 0x41, 0x0a]))), [
    { type: 'message', bytes: [] },
    { type: 'overflow' },
  ]);
});

test('overflows unterminated data once and recovers across chunks', () => {
  const framer = createFramer({ terminator: 'crlf', maxMessageBytes: 2 });
  assert.deepEqual(simplify(framer.push(Uint8Array.from([1, 2, 3, 4]))), [
    { type: 'overflow' },
  ]);
  assert.deepEqual(simplify(framer.push(Uint8Array.from([5, 0x0d]))), []);
  assert.deepEqual(simplify(framer.push(Uint8Array.from([0x0a, 6, 0x0d, 0x0a]))), [
    { type: 'message', bytes: [6] },
  ]);
});

test('counts a lone CR as data in CRLF mode when it is not followed by LF', () => {
  const framer = createFramer({ terminator: 'crlf', maxMessageBytes: 2 });
  assert.deepEqual(simplify(framer.push(Uint8Array.from([0x41, 0x0d]))), []);
  assert.deepEqual(simplify(framer.push(Uint8Array.from([0x42, 0x0d, 0x0a]))), [
    { type: 'overflow' },
  ]);
});

test('reset drops an incomplete message and pending CR', () => {
  const framer = createFramer({ terminator: 'crlf' });
  framer.push(Uint8Array.from([0x41, 0x0d]));
  framer.reset();
  assert.deepEqual(simplify(framer.push(Uint8Array.from([0x0a, 0x42, 0x0d, 0x0a]))), [
    { type: 'message', bytes: [0x0a, 0x42] },
  ]);
});

test('returns message byte copies independent of input mutation', () => {
  const input = Uint8Array.from([0x41, 0x0d]);
  const framer = createFramer({ terminator: 'cr' });
  const [event] = framer.push(input);
  input[0] = 0x42;
  assert.deepEqual(Array.from(event.bytes), [0x41]);
});

test('rejects invalid options and non-Uint8Array chunks', () => {
  for (const terminator of [undefined, 'none', 'CR', null]) {
    assert.throws(() => createFramer({ terminator }), TypeError);
  }
  for (const maxMessageBytes of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '3']) {
    assert.throws(() => createFramer({ terminator: 'cr', maxMessageBytes }), TypeError);
  }

  const framer = createFramer({ terminator: 'cr' });
  for (const input of [[], 'A', null]) {
    assert.throws(() => framer.push(input), TypeError);
  }
});
