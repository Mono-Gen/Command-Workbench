const test = require('node:test');
const assert = require('node:assert/strict');

const { formatView, createTextStream } = require('../../src/core/format-view');

test('formats every cell kind and character mapping', () => {
  const rows = formatView(Uint8Array.from([0x00, 0x0a, 0x0d, 0x1f, 0x20, 0x41, 0x7e, 0x7f, 0x80, 0xff]));
  assert.deepEqual(rows, [{
    offset: 0,
    cells: [
      { hex: '00', char: '·', kind: 'control' },
      { hex: '0A', char: '␊', kind: 'lf' },
      { hex: '0D', char: '␍', kind: 'cr' },
      { hex: '1F', char: '·', kind: 'control' },
      { hex: '20', char: ' ', kind: 'printable' },
      { hex: '41', char: 'A', kind: 'printable' },
      { hex: '7E', char: '~', kind: 'printable' },
      { hex: '7F', char: '·', kind: 'control' },
      { hex: '80', char: '.', kind: 'high' },
      { hex: 'FF', char: '.', kind: 'high' },
    ],
  }]);
});

test('splits rows and assigns byte offsets', () => {
  const rows = formatView(Uint8Array.from([0x41, 0x42, 0x43, 0x44, 0x45]), { bytesPerRow: 2 });
  assert.deepEqual(rows, [
    {
      offset: 0,
      cells: [
        { hex: '41', char: 'A', kind: 'printable' },
        { hex: '42', char: 'B', kind: 'printable' },
      ],
    },
    {
      offset: 2,
      cells: [
        { hex: '43', char: 'C', kind: 'printable' },
        { hex: '44', char: 'D', kind: 'printable' },
      ],
    },
    {
      offset: 4,
      cells: [{ hex: '45', char: 'E', kind: 'printable' }],
    },
  ]);
});

test('uses sixteen bytes per row by default', () => {
  const rows = formatView(Uint8Array.from({ length: 17 }, (_, index) => index));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].cells.length, 16);
  assert.equal(rows[1].offset, 16);
  assert.equal(rows[1].cells.length, 1);
});

test('returns no rows for empty input', () => {
  assert.deepEqual(formatView(new Uint8Array()), []);
});

test('rejects invalid byte input and row sizes', () => {
  assert.throws(() => formatView([0x41]), TypeError);
  for (const bytesPerRow of [0, -1, 1.5, Number.NaN, Infinity, '16']) {
    assert.throws(() => formatView(new Uint8Array(), { bytesPerRow }), TypeError);
  }
});

test('decodes a UTF-8 sequence split across pushes', () => {
  const stream = createTextStream();
  assert.equal(stream.push(Uint8Array.from([0xe2])), '');
  assert.equal(stream.push(Uint8Array.from([0x82, 0xac])), '€');
});

test('replaces invalid UTF-8 and preserves control characters', () => {
  const stream = createTextStream();
  assert.equal(stream.push(Uint8Array.from([0xff, 0x0d, 0x0a, 0x41])), '\ufffd\r\nA');
});

test('reset discards a pending sequence and starts a new decoder', () => {
  const stream = createTextStream();
  assert.equal(stream.push(Uint8Array.from([0xe2])), '');
  assert.equal(stream.reset(), undefined);
  assert.equal(stream.push(Uint8Array.from([0x41])), 'A');
});
