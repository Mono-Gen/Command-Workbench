// Tests for the IPC layer: argument validation per channel and the sender check.
// The renderer is untrusted, so every argument is checked here before it reaches the service.
const test = require('node:test');
const assert = require('node:assert/strict');

const { createIpcHandlers, isTrustedSender, CHANNELS } = require('../../src/main/ipc');

function fakeService() {
  const calls = [];
  const record = (name) => (...args) => { calls.push([name, ...args]); return { ok: true, from: name }; };
  const service = {};
  for (const name of ['init', 'getState', 'saveData', 'parsePreview', 'connect', 'disconnect', 'setReadOnly', 'setKeepAlive', 'sendSaved', 'sendDirect', 'startPeriodic', 'stopPeriodic']) {
    service[name] = record(name);
  }
  return { service, calls };
}

const INVALID = { ok: false, code: 'invalid_arguments' };

test('exposes exactly the documented channels', () => {
  assert.deepEqual([...CHANNELS].sort(), [
    'connect', 'deviceCloseAll', 'deviceLoadFile', 'deviceLoadSample', 'deviceRefreshSamples', 'deviceSetFault', 'deviceStart',
    'deviceState', 'deviceStop', 'disconnect', 'init', 'parsePreview',
    'relayClearRecording', 'relayDraft', 'relayLoadRecording', 'relaySaveDraft', 'relaySaveRecording', 'relayStart',
    'relayState', 'relayStop', 'relayUseDraft',
    'saveData', 'sendDirect', 'sendSaved',
    'setKeepAlive', 'setLocale', 'setReadOnly', 'startPeriodic', 'stopPeriodic',
  ]);
});

test('connect: validates target types, timeout and keepalive; passes only known fields', async () => {
  const { service, calls } = fakeService();
  const handlers = createIpcHandlers({ service, setLocale: () => {} });

  assert.deepEqual(await handlers.connect({ host: '192.0.2.1', port: 23, extra: 'ignored', __proto__: { polluted: 1 } }), { ok: true, from: 'connect' });
  assert.deepEqual(calls.at(-1), ['connect', { host: '192.0.2.1', port: 23, timeoutMs: undefined, keepAlive: undefined }]);

  assert.deepEqual(await handlers.connect({ host: '192.0.2.1', port: 23, timeoutMs: 3000, keepAlive: { enabled: true, initialDelayMs: 30000 } }), { ok: true, from: 'connect' });
  assert.deepEqual(calls.at(-1)[1], { host: '192.0.2.1', port: 23, timeoutMs: 3000, keepAlive: { enabled: true, initialDelayMs: 30000 } });

  for (const bad of [
    null, undefined, 'x', 5, [], {},
    { host: 5, port: 23 }, { host: 'h', port: '23' },
    { host: 'h', port: 23, timeoutMs: 999 }, { host: 'h', port: 23, timeoutMs: 60001 }, { host: 'h', port: 23, timeoutMs: 1.5 }, { host: 'h', port: 23, timeoutMs: '5000' },
    { host: 'h', port: 23, keepAlive: 'yes' }, { host: 'h', port: 23, keepAlive: { enabled: 'yes' } },
    { host: 'h', port: 23, keepAlive: { enabled: true, initialDelayMs: 10 } },
  ]) {
    assert.deepEqual(await handlers.connect(bad), INVALID, JSON.stringify(bad));
  }
  assert.equal(calls.length, 2, 'nothing invalid reached the service');
});

test('sendSaved: needs string device and command names', async () => {
  const { service, calls } = fakeService();
  const handlers = createIpcHandlers({ service, setLocale: () => {} });
  assert.equal((await handlers.sendSaved({ device: 'D', command: 'C' })).ok, true);
  assert.deepEqual(calls.at(-1), ['sendSaved', { device: 'D', command: 'C' }]);
  for (const bad of [null, {}, { device: 'D' }, { device: 1, command: 'C' }, { device: 'D', command: {} }, 'D']) {
    assert.deepEqual(await handlers.sendSaved(bad), INVALID);
  }
});

test('sendDirect: only text/hex mode, the four terminators, boolean expectsReply; a "kind" is dropped', async () => {
  const { service, calls } = fakeService();
  const handlers = createIpcHandlers({ service, setLocale: () => {} });
  await handlers.sendDirect({ text: 'A', mode: 'text', appendTerminator: 'cr', expectsReply: false, kind: 'query' });
  assert.deepEqual(calls.at(-1), ['sendDirect', { text: 'A', mode: 'text', appendTerminator: 'cr', expectsReply: false }]);
  for (const bad of [
    null, { text: 5, mode: 'text', appendTerminator: 'none' }, { text: 'A', mode: 'bin', appendTerminator: 'none' },
    { text: 'A', mode: 'text', appendTerminator: 'cr+lf' }, { text: 'A', mode: 'text', appendTerminator: 'none', expectsReply: 'yes' },
    { text: 'A'.repeat(1048577), mode: 'text', appendTerminator: 'none' },
  ]) {
    assert.deepEqual(await handlers.sendDirect(bad), INVALID, JSON.stringify(bad).slice(0, 60));
  }
});

test('parsePreview: same checks as sendDirect, without expectsReply', async () => {
  const { service, calls } = fakeService();
  const handlers = createIpcHandlers({ service, setLocale: () => {} });
  await handlers.parsePreview({ text: '', mode: 'hex', appendTerminator: 'lf', expectsReply: true });
  assert.deepEqual(calls.at(-1), ['parsePreview', { text: '', mode: 'hex', appendTerminator: 'lf' }]);
  assert.deepEqual(await handlers.parsePreview({ text: 1, mode: 'hex', appendTerminator: 'lf' }), INVALID);
});

test('startPeriodic: interval must be an integer; names must be strings', async () => {
  const { service, calls } = fakeService();
  const handlers = createIpcHandlers({ service, setLocale: () => {} });
  await handlers.startPeriodic({ device: 'D', command: 'C', intervalMs: 5000 });
  assert.deepEqual(calls.at(-1), ['startPeriodic', { device: 'D', command: 'C', intervalMs: 5000 }]);
  for (const bad of [null, { device: 'D', command: 'C' }, { device: 'D', command: 'C', intervalMs: '5000' }, { device: 'D', command: 'C', intervalMs: 1.5 }, { command: 'C', intervalMs: 5000 }]) {
    assert.deepEqual(await handlers.startPeriodic(bad), INVALID);
  }
});

test('setReadOnly needs a real boolean; setKeepAlive validates both fields', async () => {
  const { service, calls } = fakeService();
  const handlers = createIpcHandlers({ service, setLocale: () => {} });
  await handlers.setReadOnly(true);
  assert.deepEqual(calls.at(-1), ['setReadOnly', true]);
  for (const bad of ['true', 1, null, undefined, {}]) assert.deepEqual(await handlers.setReadOnly(bad), INVALID);

  await handlers.setKeepAlive({ enabled: false, initialDelayMs: 30000 });
  assert.deepEqual(calls.at(-1), ['setKeepAlive', false, 30000]);
  for (const bad of [null, { enabled: 1 }, { enabled: true, initialDelayMs: 10 }, { enabled: true, initialDelayMs: 'x' }]) {
    assert.deepEqual(await handlers.setKeepAlive(bad), INVALID);
  }
});

test('saveData needs a plain object; the service validates the content', async () => {
  const { service, calls } = fakeService();
  const handlers = createIpcHandlers({ service, setLocale: () => {} });
  await handlers.saveData({ schemaVersion: 1, devices: [] });
  assert.deepEqual(calls.at(-1), ['saveData', { schemaVersion: 1, devices: [] }]);
  for (const bad of [null, undefined, 'x', 5, []]) assert.deepEqual(await handlers.saveData(bad), INVALID);
});

test('setLocale accepts only "ja" or "en"', async () => {
  const seen = [];
  const handlers = createIpcHandlers({ service: fakeService().service, setLocale: (l) => seen.push(l) });
  assert.deepEqual(await handlers.setLocale('en'), { ok: true });
  assert.deepEqual(await handlers.setLocale('ja'), { ok: true });
  for (const bad of ['fr', '', null, 5, {}]) assert.deepEqual(await handlers.setLocale(bad), INVALID);
  assert.deepEqual(seen, ['en', 'ja']);
});

test('argument-less channels ignore any argument', async () => {
  const { service, calls } = fakeService();
  const handlers = createIpcHandlers({ service, setLocale: () => {} });
  await handlers.init({ junk: true });
  await handlers.disconnect('x');
  await handlers.stopPeriodic(5);
  assert.deepEqual(calls, [['init'], ['disconnect'], ['stopPeriodic']]);
});

test('a service that throws is reported as an internal error, not rethrown to the renderer', async () => {
  const errors = [];
  const { service } = fakeService();
  service.disconnect = () => { throw new Error('boom'); };
  const handlers = createIpcHandlers({ service, setLocale: () => {}, onError: (e) => errors.push(e.message) });
  assert.deepEqual(await handlers.disconnect(), { ok: false, code: 'internal_error' });
  assert.deepEqual(errors, ['boom']);
});

test('a TypeError from deeper code is an invalid-arguments result', async () => {
  const { service } = fakeService();
  service.sendDirect = () => { throw new TypeError('bad'); };
  const handlers = createIpcHandlers({ service, setLocale: () => {} });
  assert.deepEqual(await handlers.sendDirect({ text: 'A', mode: 'text', appendTerminator: 'none' }), INVALID);
});

test('isTrustedSender: only the top frame of our own page', () => {
  const page = 'file:///app/src/renderer/index.html';
  const ok = { senderFrame: { url: page, parent: null } };
  assert.equal(isTrustedSender(ok, page), true);
  assert.equal(isTrustedSender({ senderFrame: { url: page, parent: {} } }, page), false, 'a sub-frame is refused');
  assert.equal(isTrustedSender({ senderFrame: { url: 'https://example.com/', parent: null } }, page), false);
  assert.equal(isTrustedSender({ senderFrame: { url: `${page}#x`, parent: null } }, page), true, 'a hash does not change the page');
  assert.equal(isTrustedSender({ senderFrame: { url: `${page}?x=1`, parent: null } }, page), false, 'a query string is not our page');
  assert.equal(isTrustedSender({ senderFrame: null }, page), false);
  assert.equal(isTrustedSender({}, page), false);
  assert.equal(isTrustedSender(null, page), false);
});

test('connect: UDP settings are validated, UDP-only fields are refused for TCP, and only known fields pass', async () => {
  const { service, calls } = fakeService();
  const handlers = createIpcHandlers({ service, setLocale: () => {} });
  const target = { host: '10.0.0.20', port: 5000 };

  assert.deepEqual(await handlers.connect({ ...target, transport: 'udp', localPort: 5100, acceptAnySource: true }), { ok: true, from: 'connect' });
  assert.deepEqual(calls.at(-1), ['connect', { transport: 'udp', host: '10.0.0.20', port: 5000, timeoutMs: undefined, localPort: 5100, acceptAnySource: true }]);
  await handlers.connect({ ...target, transport: 'udp' });
  assert.deepEqual(calls.at(-1), ['connect', { transport: 'udp', host: '10.0.0.20', port: 5000, timeoutMs: undefined, localPort: undefined, acceptAnySource: undefined }]);
  await handlers.connect({ ...target, transport: 'tcp' });
  assert.deepEqual(calls.at(-1)[1], { host: '10.0.0.20', port: 5000, timeoutMs: undefined, keepAlive: undefined });
  const before = calls.length;

  for (const bad of [
    { ...target, transport: 'sctp' }, { ...target, transport: 5 },
    { ...target, transport: 'udp', localPort: '5100' }, { ...target, transport: 'udp', localPort: -1 }, { ...target, transport: 'udp', localPort: 70000 }, { ...target, transport: 'udp', localPort: 1.5 },
    { ...target, transport: 'udp', acceptAnySource: 'yes' }, { ...target, transport: 'udp', acceptAnySource: 1 },
    { ...target, transport: 'udp', localPort: 80 }, { ...target, transport: 'udp', localPort: 1023 },
    // UDP takes exactly its own fields: TCP-only settings and unknown fields are refused, not dropped.
    { ...target, transport: 'udp', keepAlive: { enabled: true } }, { ...target, transport: 'udp', extra: 1 },
    { ...target, localPort: 5100 }, { ...target, acceptAnySource: true }, { ...target, transport: 'tcp', localPort: 5100 },
  ]) {
    assert.deepEqual(await handlers.connect(bad), INVALID, JSON.stringify(bad));
  }
  assert.equal(calls.length, before, 'nothing invalid reached the service');
});

