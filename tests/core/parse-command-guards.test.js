// Guards added after review: input type check and an early size cut-off.
const test = require('node:test');
const assert = require('node:assert/strict');

const { parseCommand } = require('../../src/core/parse-command');

const textOptions = { mode: 'text', appendTerminator: 'none' };

test('throws TypeError when text is not a string', () => {
  for (const bad of [undefined, null, 123, {}, ['A'], new Uint8Array([0x41])]) {
    assert.throws(() => parseCommand(bad, textOptions), TypeError, `must reject ${String(bad)}`);
  }
});

test('rejects oversized input without scanning it (limit is 1048576 UTF-16 units)', () => {
  const atLimit = 'A'.repeat(1048576);
  const overLimit = 'A'.repeat(1048577);

  // At the guard limit the byte limit (65536) still applies, via the normal path.
  assert.deepEqual(parseCommand(atLimit, textOptions), {
    ok: false,
    errors: [{ position: 0, length: 1048576, code: 'too_large' }],
  });
  // Above the guard limit the scan is skipped and the same error is returned.
  assert.deepEqual(parseCommand(overLimit, textOptions), {
    ok: false,
    errors: [{ position: 0, length: 1048577, code: 'too_large' }],
  });
});

test('byte limit boundary: 65536 bytes is accepted, 65537 is rejected', () => {
  const ok = parseCommand('A'.repeat(65536), textOptions);
  assert.equal(ok.ok, true);
  assert.equal(ok.bytes.length, 65536);

  assert.deepEqual(parseCommand('A'.repeat(65537), textOptions), {
    ok: false,
    errors: [{ position: 0, length: 65537, code: 'too_large' }],
  });
});

test('many unclosed brackets are handled in linear time and report a bounded number of errors', () => {
  for (const open of ['[', '<']) {
    const started = Date.now();
    const result = parseCommand(open.repeat(300000), { mode: 'text', appendTerminator: 'none' });
    assert.ok(Date.now() - started < 1000, 'must not be quadratic');
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1000);
    assert.ok(result.errors.every((e) => e.code === 'unclosed_bracket'));
    assert.deepEqual(result.errors[0], { position: 0, length: 1, code: 'unclosed_bracket' });
  }
});

test('a missing closing bracket is remembered per kind of bracket only', () => {
  // "<" has no ">" after it, but a later "[CR]" still closes normally.
  const result = parseCommand('<<[CR]', { mode: 'text', appendTerminator: 'none' });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map((e) => [e.position, e.code]), [[0, 'unclosed_bracket'], [1, 'unclosed_bracket']]);
  assert.deepEqual(Array.from(parseCommand('[CR]', { mode: 'text', appendTerminator: 'none' }).bytes), [0x0d]);
});

test('hex input with thousands of bad tokens also reports a bounded number of errors', () => {
  const result = parseCommand('zz '.repeat(50000), { mode: 'hex', appendTerminator: 'none' });
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1000);
});
