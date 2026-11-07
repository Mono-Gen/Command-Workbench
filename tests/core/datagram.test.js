const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_DATAGRAM_BYTES,
  RECOMMENDED_MAX_BYTES,
  toMessage,
  checkSendSize,
} = require('../../src/core/datagram');

const bytes = (value) => Uint8Array.from(Buffer.from(value, 'latin1'));

test('exports the specified UDP payload limits', () => {
  assert.equal(MAX_DATAGRAM_BYTES, 65507);
  assert.equal(RECOMMENDED_MAX_BYTES, 1472);
});

test('removes exactly one matching trailing terminator', () => {
  const cases = [
    ['ID?', 'cr', 'ID?'],
    ['ID?\r', 'cr', 'ID?'],
    ['ID?\r\r', 'cr', 'ID?\r'],
    ['\r', 'cr', ''],
    ['', 'cr', ''],
    ['ID?\n', 'cr', 'ID?\n'],
    ['ID?\n', 'lf', 'ID?'],
    ['ID?\r\n', 'lf', 'ID?\r'],
    ['ID?\r\n', 'crlf', 'ID?'],
    ['ID?\r', 'crlf', 'ID?\r'],
    ['ID?\n', 'crlf', 'ID?\n'],
    ['ID?\r\n\r\n', 'crlf', 'ID?\r\n'],
  ];
  for (const [input, terminator, expected] of cases) {
    assert.deepEqual(toMessage(bytes(input), terminator), bytes(expected), `${terminator}: ${input}`);
  }
});

test('returns a new Uint8Array without aliasing the input', () => {
  const input = Uint8Array.of(0x41, 0x42);
  const output = toMessage(input, 'cr');
  assert.notEqual(output, input);
  output[0] = 0x58;
  assert.deepEqual(input, Uint8Array.of(0x41, 0x42));
});

test('rejects invalid bytes and terminators', () => {
  for (const value of [null, undefined, [], 'ID?', { 0: 1, length: 1 }]) {
    assert.throws(() => toMessage(value, 'cr'), TypeError);
  }
  for (const terminator of [undefined, null, '', 'none', 'CR', 1]) {
    assert.throws(() => toMessage(Uint8Array.of(1), terminator), TypeError);
  }
});

test('checks empty, fragmentation, and maximum-size boundaries', () => {
  const cases = [
    [0, { ok: false, code: 'empty' }],
    [1, { ok: true, fragmentation: false }],
    [1472, { ok: true, fragmentation: false }],
    [1473, { ok: true, fragmentation: true }],
    [65507, { ok: true, fragmentation: true }],
    [65508, { ok: false, code: 'too_large' }],
  ];
  for (const [length, expected] of cases) assert.deepEqual(checkSendSize(length), expected);
});

test('rejects non-integer and negative lengths', () => {
  for (const length of [-1, -0.5, 1.5, NaN, Infinity, '1', null, undefined]) {
    assert.throws(() => checkSendSize(length), TypeError);
  }
});

function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

test('seeded byte arrays obey terminator removal properties', () => {
  const next = seeded(0x43a91f2d);
  const endings = {
    cr: Uint8Array.of(0x0d),
    lf: Uint8Array.of(0x0a),
    crlf: Uint8Array.of(0x0d, 0x0a),
  };
  for (let run = 0; run < 1000; run += 1) {
    const input = Uint8Array.from({ length: next() % 80 }, () => next() & 0xff);
    for (const [terminator, ending] of Object.entries(endings)) {
      const matches = input.length >= ending.length
        && ending.every((byte, index) => input[input.length - ending.length + index] === byte);
      const expected = matches ? input.slice(0, input.length - ending.length) : input;
      assert.deepEqual(toMessage(input, terminator), expected, `${terminator} removal run ${run}`);

      let withoutEnding = input;
      while (withoutEnding.length >= ending.length
        && ending.every((byte, index) => withoutEnding[withoutEnding.length - ending.length + index] === byte)) {
        withoutEnding = withoutEnding.slice(0, withoutEnding.length - ending.length);
      }
      const appended = new Uint8Array(withoutEnding.length + ending.length);
      appended.set(withoutEnding);
      appended.set(ending, withoutEnding.length);
      assert.deepEqual(toMessage(appended, terminator), withoutEnding, `${terminator} append run ${run}`);
    }
  }
});
