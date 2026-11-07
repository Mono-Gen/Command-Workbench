// The hand-over of a drafted definition from the relay service to the device service.
const test = require('node:test');
const assert = require('node:assert/strict');

const { createDeviceService } = require('../../src/main/device-service');
const { validateDefinition } = require('../../src/core/device-definition');
const { confirmDialogText } = require('../../src/main/messages');

const draft = () => {
  const result = validateDefinition({
    schemaVersion: 1, name: 'Draft from recording', framing: { terminator: 'cr' }, greeting: 'READY[CR]',
    commands: [{ pattern: 'ID?', reply: 'ID A1[CR]' }, { pattern: 'MUTE 1', reply: null }],
  });
  assert.equal(result.ok, true);
  return result.definition;
};

function setup({ running = false, lifecycle } = {}) {
  const emitted = [];
  const server = { getState: () => ({ running, lifecycle, connections: [] }), start: async () => ({ ok: true }), stop: async () => ({ ok: true }) };
  const service = createDeviceService({
    server,
    chooseFile: async () => ({ ok: false, code: 'cancelled' }),
    sampleStore: { list: async () => ({ ok: true, source: 'builtin', dir: '', items: [], omitted: 0 }), read: async () => ({ ok: false, code: 'unknown_sample' }) },
    confirm: async () => true,
    emit: (channel, payload) => emitted.push([channel, payload]),
  });
  return { service, emitted };
}

test('loadDraft makes the draft the current definition and pushes the state', () => {
  const { service, emitted } = setup();
  const result = service.loadDraft(draft(), { fileName: 'draft.json' });
  assert.equal(result.ok, true);
  assert.equal(result.info.source, 'draft');
  assert.equal(result.info.fileName, 'draft.json');
  assert.deepEqual(result.info.patterns, ['ID?', 'MUTE 1']);
  assert.equal(result.info.hasGreeting, true);
  assert.equal(service.getState().definition.name, 'Draft from recording');
  assert.equal(emitted.filter(([c]) => c === 'deviceState').length, 1);
  const announced = emitted.filter(([c]) => c === 'deviceDefinition');
  assert.equal(announced.length, 1, 'the page is told that the definition changed');
  assert.equal(announced[0][1].source, 'draft');
  assert.equal(announced[0][1].fileName, 'draft.json');
});

test('loadDraft refuses while the device runs, and anything that is not a validated definition', () => {
  assert.deepEqual(setup({ running: true }).service.loadDraft(draft()), { ok: false, code: 'running' });
  const { service, emitted } = setup();
  for (const bad of [null, {}, JSON.parse(JSON.stringify(draft())), { name: 'x', commands: [] }, 'text']) {
    assert.deepEqual(service.loadDraft(bad), { ok: false, code: 'invalid_definition' });
  }
  assert.equal(service.getState().definition, null);
  assert.equal(emitted.filter(([c]) => c === 'deviceDefinition').length, 0, 'a refused hand-over announces nothing');
});

test('the file name from the hand-over is bounded and defaults to "draft"', () => {
  const { service } = setup();
  assert.equal(service.loadDraft(draft(), { fileName: 'x'.repeat(500) }).info.fileName.length, 100);
  assert.equal(service.loadDraft(draft(), { fileName: 42 }).info.fileName, 'draft');
});

test('the relay confirmation names the real target in both languages', () => {
  for (const locale of ['ja', 'en']) {
    const text = confirmDialogText(locale, { reasons: ['relay_bind_all'], items: null, target: '10.0.0.20:5000' });
    assert.ok(text.message.includes('10.0.0.20:5000'), locale);
    assert.ok(text.reasonLines[0].length > 20);
    assert.ok(text.title && text.confirmLabel && text.cancelLabel);
  }
});

test('a server that is starting or stopping is busy too; only an idle one accepts a new definition', () => {
  for (const lifecycle of ['starting', 'stopping']) {
    const { service } = setup({ lifecycle });
    assert.deepEqual(service.loadDraft(draft()), { ok: false, code: 'running' }, lifecycle);
    assert.equal(service.getState().definition, null);
  }
  assert.equal(setup({ lifecycle: 'idle' }).service.loadDraft(draft()).ok, true);
});
