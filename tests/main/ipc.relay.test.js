// IPC validation for the relay-role channels. The page is untrusted: every argument is checked
// here, only known fields are passed on, and the page can never pass a path, a recording or a
// definition.
const test = require('node:test');
const assert = require('node:assert/strict');

const { createIpcHandlers, CHANNELS } = require('../../src/main/ipc');

function setup() {
  const calls = [];
  const rec = (name) => (...args) => { calls.push([name, ...args]); return { ok: true, from: name }; };
  const relayService = {
    getState: rec('getState'), start: rec('start'), stop: rec('stop'), clearRecording: rec('clearRecording'),
    saveRecording: rec('saveRecording'), loadRecording: rec('loadRecording'), draft: rec('draft'),
    saveDraft: rec('saveDraft'), useDraft: rec('useDraft'),
  };
  const handlers = createIpcHandlers({ service: {}, deviceService: {}, relayService, setLocale: () => {} });
  return { handlers, calls };
}

const INVALID = { ok: false, code: 'invalid_arguments' };
const GOOD = { listenHost: '127.0.0.1', listenPort: 5200, upstreamHost: 'player.local', upstreamPort: 5000 };

test('every relay channel is registered and has a handler', () => {
  const { handlers } = setup();
  const names = ['relayState', 'relayStart', 'relayStop', 'relayClearRecording', 'relaySaveRecording',
    'relayLoadRecording', 'relayDraft', 'relaySaveDraft', 'relayUseDraft'];
  for (const name of names) {
    assert.ok(CHANNELS.includes(name), name);
    assert.equal(typeof handlers[name], 'function', name);
  }
});

test('argument-less relay channels refuse any argument (no path, recording or definition can be smuggled)', async () => {
  const { handlers, calls } = setup();
  const names = ['relayState', 'relayStop', 'relayClearRecording', 'relaySaveRecording', 'relayLoadRecording', 'relaySaveDraft', 'relayUseDraft'];
  for (const name of names) {
    for (const smuggle of [{ path: 'C:/x', text: '{}', recording: {}, definition: {} }, null, 0, '', 'x', []]) {
      assert.deepEqual(await handlers[name](smuggle), INVALID, `${name} ${JSON.stringify(smuggle)}`);
    }
  }
  assert.deepEqual(calls, [], 'nothing reached the service');
  for (const name of names) await handlers[name]();
  assert.deepEqual(calls, [['getState'], ['stop'], ['clearRecording'], ['saveRecording'], ['loadRecording'], ['saveDraft'], ['useDraft']]);
});

test('relayStart: exactly the four fields, allowed host, valid ports, a bounded upstream host', async () => {
  const { handlers, calls } = setup();
  assert.deepEqual(await handlers.relayStart(GOOD), { ok: true, from: 'start' });
  assert.deepEqual(calls.at(-1), ['start', GOOD]);
  assert.deepEqual(await handlers.relayStart(Object.assign(Object.create(null), GOOD)), { ok: true, from: 'start' }, 'a null-prototype object is plain');
  class Exotic { constructor() { Object.assign(this, GOOD); } }
  for (const odd of [{ ...GOOD, evil: true }, { ...GOOD, path: 'x' }, new Exotic(), Object.create(GOOD), { listenHost: '127.0.0.1', listenPort: 5200, upstreamHost: 'a' }]) {
    assert.deepEqual(await handlers.relayStart(odd), INVALID, JSON.stringify(odd));
  }
  await handlers.relayStart({ ...GOOD, listenHost: '0.0.0.0', listenPort: 0 });
  assert.deepEqual(calls.at(-1), ['start', { ...GOOD, listenHost: '0.0.0.0', listenPort: 0 }]);
  const bads = [
    null, 'x', [], {},
    { ...GOOD, listenHost: 'localhost' }, { ...GOOD, listenHost: '192.0.2.1' }, { ...GOOD, listenHost: undefined },
    { ...GOOD, listenPort: 80 }, { ...GOOD, listenPort: 1023 }, { ...GOOD, listenPort: 65536 }, { ...GOOD, listenPort: '5200' }, { ...GOOD, listenPort: 1.5 },
    { ...GOOD, upstreamHost: '' }, { ...GOOD, upstreamHost: 5 }, { ...GOOD, upstreamHost: 'x'.repeat(254) }, { ...GOOD, upstreamHost: null },
    { ...GOOD, upstreamPort: 0 }, { ...GOOD, upstreamPort: 65536 }, { ...GOOD, upstreamPort: '5000' }, { ...GOOD, upstreamPort: 2.5 },
  ];
  for (const bad of bads) assert.deepEqual(await handlers.relayStart(bad), INVALID, JSON.stringify(bad));
  assert.equal(calls.filter(([name]) => name === 'start').length, 3, 'nothing invalid reached the service');
});

test('relayDraft: a known source, optional terminator and quiet time, no other field', async () => {
  const { handlers, calls } = setup();
  await handlers.relayDraft({ source: 'live' });
  assert.deepEqual(calls.at(-1), ['draft', { source: 'live' }]);
  for (const odd of [{ source: 'live', recording: { evil: 1 } }, { source: 'live', definition: {} }, { source: 'live', path: 'x' }]) {
    assert.deepEqual(await handlers.relayDraft(odd), INVALID, JSON.stringify(odd));
  }
  await handlers.relayDraft({ source: 'loaded', terminator: 'crlf', quietMs: 0 });
  assert.deepEqual(calls.at(-1), ['draft', { source: 'loaded', terminator: 'crlf', quietMs: 0 }]);
  for (const bad of [null, {}, { source: 'file' }, { source: 'live', terminator: 'tab' }, { source: 'live', terminator: 'none' },
    { source: 'live', quietMs: -1 }, { source: 'live', quietMs: 60001 }, { source: 'live', quietMs: '5' }, { source: 'live', quietMs: 1.5 }]) {
    assert.deepEqual(await handlers.relayDraft(bad), INVALID, JSON.stringify(bad));
  }
});

test('a service that throws a TypeError gives invalid_arguments; any other error stays internal', async () => {
  const errors = [];
  const handlers = createIpcHandlers({
    service: {},
    deviceService: {},
    relayService: {
      start: () => { throw new TypeError('x'); },
      stop: () => { throw new Error('secret stack'); },
    },
    setLocale: () => {},
    onError: (e) => errors.push(e),
  });
  assert.deepEqual(await handlers.relayStart(GOOD), INVALID);
  assert.deepEqual(await handlers.relayStop(), { ok: false, code: 'internal_error' });
  assert.equal(errors.length, 1);
});
