const test = require('node:test');
const assert = require('node:assert/strict');

const { parseCommand } = require('../../src/core/parse-command');

function bytesOf(result) {
  assert.equal(result.ok, true, 'parse must succeed');
  return Array.from(result.bytes);
}

function errorOf(input, options = { mode: 'text', appendTerminator: 'none' }) {
  const result = parseCommand(input, options);
  assert.equal(result.ok, false, 'parse must fail');
  return result.errors;
}

const textExamples = [
  ['SETPWR 1[CR]', [0x53, 0x45, 0x54, 0x50, 0x57, 0x52, 0x20, 0x31, 0x0d]],
  ['<cr><lf>', [0x0d, 0x0a]],
  ['[CRLF]', [0x0d, 0x0a]],
  ['A\\r\\n', [0x41, 0x0d, 0x0a]],
  ['\\\\r', [0x5c, 0x72]],
  ['\\[CR\\]', [0x5b, 0x43, 0x52, 0x5d]],
  ['abc0x0D', [0x61, 0x62, 0x63, 0x30, 0x78, 0x30, 0x44]],
  ['0x0D', [0x0d]],
  ['X 0x0D', [0x58, 0x20, 0x0d]],
  ['\\x41B', [0x41, 0x42]],
  ['a]b>', [0x61, 0x5d, 0x62, 0x3e]],
  ['é', [0xc3, 0xa9]],
];

test('parses every successful text-mode example', () => {
  for (const [input, expected] of textExamples) {
    assert.deepEqual(
      bytesOf(parseCommand(input, { mode: 'text', appendTerminator: 'none' })),
      expected,
      `unexpected bytes for ${JSON.stringify(input)}`,
    );
  }
});

const errorExamples = [
  ['0x0D0', { position: 0, length: 5, code: 'invalid_hex_literal' }],
  ['0x0', { position: 0, length: 3, code: 'invalid_hex_literal' }],
  ['[XYZ]', { position: 0, length: 5, code: 'unknown_name' }],
  ['[CR', { position: 0, length: 1, code: 'unclosed_bracket' }],
  ['[]', { position: 0, length: 2, code: 'empty_name' }],
  ['\\x4', { position: 0, length: 3, code: 'invalid_hex_escape' }],
  ['\\q', { position: 0, length: 2, code: 'unknown_escape' }],
];

test('reports every failing text-mode example', () => {
  for (const [input, expected] of errorExamples) {
    assert.deepEqual(errorOf(input), [expected], `unexpected error for ${JSON.stringify(input)}`);
  }
});

test('supports every named byte with both bracket styles and mixed case', () => {
  const names = [
    ['NUL', [0x00]], ['SOH', [0x01]], ['STX', [0x02]], ['ETX', [0x03]],
    ['EOT', [0x04]], ['ENQ', [0x05]], ['ACK', [0x06]], ['BEL', [0x07]],
    ['BS', [0x08]], ['TAB', [0x09]], ['HT', [0x09]], ['LF', [0x0a]],
    ['VT', [0x0b]], ['FF', [0x0c]], ['CR', [0x0d]], ['SO', [0x0e]],
    ['SI', [0x0f]], ['DLE', [0x10]], ['DC1', [0x11]], ['DC2', [0x12]],
    ['DC3', [0x13]], ['DC4', [0x14]], ['NAK', [0x15]], ['SYN', [0x16]],
    ['ETB', [0x17]], ['CAN', [0x18]], ['EM', [0x19]], ['SUB', [0x1a]],
    ['ESC', [0x1b]], ['FS', [0x1c]], ['GS', [0x1d]], ['RS', [0x1e]],
    ['US', [0x1f]], ['SP', [0x20]], ['DEL', [0x7f]], ['CRLF', [0x0d, 0x0a]],
  ];

  for (const [name, expected] of names) {
    const mixed = [...name].map((char, index) => index % 2 === 0 ? char.toLowerCase() : char).join('');
    assert.deepEqual(bytesOf(parseCommand(`[${name}]`, { mode: 'text', appendTerminator: 'none' })), expected);
    assert.deepEqual(bytesOf(parseCommand(`<${mixed}>`, { mode: 'text', appendTerminator: 'none' })), expected);
  }
});

test('parses all text escapes', () => {
  const input = '\\\\\\r\\n\\t\\0\\[\\]\\<\\>\\x7f';
  assert.deepEqual(
    bytesOf(parseCommand(input, { mode: 'text', appendTerminator: 'none' })),
    [0x5c, 0x0d, 0x0a, 0x09, 0x00, 0x5b, 0x5d, 0x3c, 0x3e, 0x7f],
  );
});

test('reports all text scanner error codes with UTF-16 positions and lengths', () => {
  assert.deepEqual(errorOf('😀\\q\\xZ[NO-NAME]<'), [
    { position: 2, length: 2, code: 'unknown_escape' },
    { position: 4, length: 2, code: 'invalid_hex_escape' },
    { position: 7, length: 9, code: 'unknown_name' },
    { position: 16, length: 1, code: 'unclosed_bracket' },
  ]);
  assert.deepEqual(errorOf('x\\'), [{ position: 1, length: 1, code: 'dangling_backslash' }]);
  assert.deepEqual(errorOf('\ud800A\udfff'), [
    { position: 0, length: 1, code: 'lone_surrogate' },
    { position: 2, length: 1, code: 'lone_surrogate' },
  ]);
});

test('checks bare hex runs of zero through three digits', () => {
  assert.deepEqual(errorOf('0x'), [{ position: 0, length: 2, code: 'invalid_hex_literal' }]);
  assert.deepEqual(errorOf('0xA'), [{ position: 0, length: 3, code: 'invalid_hex_literal' }]);
  assert.deepEqual(bytesOf(parseCommand('0xA5', { mode: 'text', appendTerminator: 'none' })), [0xa5]);
  assert.deepEqual(errorOf('0xA5F'), [{ position: 0, length: 5, code: 'invalid_hex_literal' }]);
  assert.deepEqual(bytesOf(parseCommand('10x0D', { mode: 'text', appendTerminator: 'none' })), [0x31, 0x30, 0x78, 0x30, 0x44]);
});

test('parses hex tokens, whitespace, and paired runs', () => {
  const result = parseCommand('40  53\t4453\r\n2c31', { mode: 'hex', appendTerminator: 'none' });
  assert.deepEqual(bytesOf(result), [0x40, 0x53, 0x44, 0x53, 0x2c, 0x31]);
});

test('reports every hex-mode error with token positions', () => {
  const result = parseCommand('0x0D ABC G1', { mode: 'hex', appendTerminator: 'none' });
  assert.deepEqual(result, {
    ok: false,
    errors: [
      { position: 0, length: 4, code: 'invalid_hex_char' },
      { position: 5, length: 3, code: 'odd_hex_length' },
      { position: 9, length: 2, code: 'invalid_hex_char' },
    ],
  });
});

test('treats only space, tab, CR, and LF as hex separators', () => {
  assert.deepEqual(errorOf('AA\fBB', { mode: 'hex', appendTerminator: 'none' }), [
    { position: 0, length: 5, code: 'invalid_hex_char' },
  ]);
});

test('rejects empty input before appending a terminator', () => {
  assert.deepEqual(errorOf('', { mode: 'text', appendTerminator: 'cr' }), [
    { position: 0, length: 0, code: 'empty_input' },
  ]);
  assert.deepEqual(errorOf(' \t\r\n', { mode: 'hex', appendTerminator: 'crlf' }), [
    { position: 0, length: 0, code: 'empty_input' },
  ]);
});

test('accepts 65536 parsed bytes and rejects 65537 parsed bytes', () => {
  const atLimit = parseCommand('a'.repeat(65536), { mode: 'text', appendTerminator: 'crlf' });
  assert.equal(atLimit.ok, true);
  assert.equal(atLimit.bytes.length, 65538, 'terminator bytes must not count toward the limit');

  assert.deepEqual(errorOf('a'.repeat(65537)), [
    { position: 0, length: 65537, code: 'too_large' },
  ]);
});

test('appends every terminator and warns when data already ends in CR or LF', () => {
  const expected = {
    none: [0x41], cr: [0x41, 0x0d], lf: [0x41, 0x0a], crlf: [0x41, 0x0d, 0x0a],
  };
  for (const [appendTerminator, bytes] of Object.entries(expected)) {
    const result = parseCommand('A', { mode: 'text', appendTerminator });
    assert.deepEqual(bytesOf(result), bytes);
    assert.deepEqual(result.warnings, []);
  }

  for (const input of ['[CR]', '[LF]']) {
    const result = parseCommand(input, { mode: 'text', appendTerminator: 'cr' });
    assert.deepEqual(result.warnings, ['terminator_doubled']);
  }
});

test('throws TypeError for invalid parser options', () => {
  assert.throws(() => parseCommand('A', { mode: 'binary', appendTerminator: 'none' }), TypeError);
  assert.throws(() => parseCommand('A', { mode: 'text', appendTerminator: 'nul' }), TypeError);
});
