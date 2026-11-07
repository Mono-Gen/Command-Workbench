// Tests for the native network-listening confirmation dialogs owned by the main process.
const test = require('node:test');
const assert = require('node:assert/strict');

const { confirmDialogText } = require('../../src/main/messages');

test('listening on all interfaces has Japanese and English warning text', () => {
  for (const locale of ['ja', 'en']) {
    const text = confirmDialogText(locale, { reasons: ['bind_all'] });
    assert.ok(text.title.length > 0 && text.message.length > 0);
    assert.ok(text.confirmLabel.length > 0 && text.cancelLabel.length > 0);
    assert.equal(text.reasonLines.length, 1);
    assert.ok(text.reasonLines[0].length > 0);
    assert.equal(text.detail, '');
  }
});

test('relay confirmation names the target and keeps each supplied reason', () => {
  for (const locale of ['ja', 'en']) {
    const text = confirmDialogText(locale, {
      reasons: ['relay_bind_all', 'udp_spoofable'],
      target: '10.0.0.20:5000',
    });
    assert.ok(text.message.includes('10.0.0.20:5000'));
    assert.equal(text.reasonLines.length, 2);
    assert.ok(text.reasonLines.every((line) => line.length > 0));
  }
});

test('an unknown locale falls back to Japanese', () => {
  const info = { reasons: ['bind_all'] };
  assert.deepEqual(confirmDialogText('xx', info), confirmDialogText('ja', info));
});
