// Tests for the text of the two native confirmation dialogs that remain (the main process shows
// them itself, so the page cannot skip them): saving a command as a "query", and turning
// read-only mode off. Sending needs no dialog: pressing "Send" is the confirmation.
const test = require('node:test');
const assert = require('node:assert/strict');

const { confirmDialogText, MAX_SHOWN_BYTES } = require('../../src/main/messages');

const bytes = Uint8Array.from([0x40, 0x53, 0x0d]);
const items = [{ device: 'Dev', name: 'Get power', bytes }, { device: 'Dev', name: 'Get input', bytes: Uint8Array.from([0x41]) }];

test('both dialogs have Japanese and English texts, with their own title, message and buttons', () => {
  for (const locale of ['ja', 'en']) {
    const save = confirmDialogText(locale, { reasons: ['classify_query'], items });
    const unlock = confirmDialogText(locale, { reasons: ['disable_read_only'] });
    for (const text of [save, unlock]) {
      assert.ok(text.title.length > 0 && text.message.length > 0);
      assert.ok(text.confirmLabel.length > 0 && text.cancelLabel.length > 0);
      assert.equal(text.reasonLines.length, 1);
      assert.ok(text.reasonLines[0].length > 0);
    }
    assert.notEqual(save.title, unlock.title);
    assert.notEqual(save.message, unlock.message);
    assert.notEqual(save.confirmLabel, unlock.confirmLabel);
  }
});

test('saving as "query" lists every command with its exact bytes', () => {
  for (const locale of ['ja', 'en']) {
    const text = confirmDialogText(locale, { reasons: ['classify_query'], items });
    assert.ok(text.detail.includes('Dev / Get power: 40 53 0D'));
    assert.ok(text.detail.includes('Dev / Get input: 41'));
  }
});

test('all bytes up to the limit are shown, with nothing cut', () => {
  const atLimit = new Uint8Array(MAX_SHOWN_BYTES).fill(0x41);
  const text = confirmDialogText('en', { reasons: ['classify_query'], items: [{ device: 'D', name: 'n', bytes: atLimit }] });
  assert.equal(text.detail.split('41').length - 1, MAX_SHOWN_BYTES, 'every byte is listed');
  assert.ok(!text.detail.includes('...'));
});

test('beyond the limit a visible marker is added (the service refuses to save such a query anyway)', () => {
  const long = new Uint8Array(MAX_SHOWN_BYTES + 100).fill(0x41);
  const text = confirmDialogText('en', { reasons: ['classify_query'], items: [{ device: 'D', name: 'n', bytes: long }] });
  assert.ok(text.detail.includes('...'));
});

test('a long list of commands is cut at 20 items with a count of the rest', () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ device: 'D', name: `c${i}`, bytes }));
  const text = confirmDialogText('en', { reasons: ['classify_query'], items: many });
  assert.ok(text.detail.includes('D / c19'));
  assert.ok(!text.detail.includes('D / c20'));
  assert.ok(text.detail.includes('and 5 more'));
});

test('turning off read-only mode needs no detail lines', () => {
  assert.equal(confirmDialogText('en', { reasons: ['disable_read_only'] }).detail, '');
});

test('an unknown locale falls back to Japanese (the primary language)', () => {
  assert.deepEqual(
    confirmDialogText('xx', { reasons: ['classify_query'], items }),
    confirmDialogText('ja', { reasons: ['classify_query'], items }),
  );
});

test('listening on all interfaces has its own warning dialog with a clear confirm button', () => {
  for (const locale of ['ja', 'en']) {
    const text = confirmDialogText(locale, { reasons: ['bind_all'] });
    const other = confirmDialogText(locale, { reasons: ['disable_read_only'] });
    assert.ok(text.title.length > 0 && text.message.length > 0 && text.reasonLines[0].length > 0);
    assert.notEqual(text.title, other.title);
    assert.notEqual(text.confirmLabel, other.confirmLabel);
    assert.equal(text.detail, '');
  }
});

