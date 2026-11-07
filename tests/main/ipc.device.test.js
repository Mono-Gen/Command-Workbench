// IPC validation for the device-role channels. The page is untrusted: every argument is checked
// here, only known fields are passed on, and the page can never pass a path or a definition.
const test = require('node:test');
const assert = require('node:assert/strict');

const { createIpcHandlers } = require('../../src/main/ipc');

function setup() {
  const calls = [];
  const rec = (name) => (...args) => { calls.push([name, ...args]); return { ok: true, from: name }; };
  const deviceService = {
    getState: rec('getState'), loadFile: rec('loadFile'), loadSample: rec('loadSample'), refreshSamples: rec('refreshSamples'), start: rec('start'),
    stop: rec('stop'), setFault: rec('setFault'), closeAll: rec('closeAll'),
  };
  const handlers = createIpcHandlers({ service: {}, deviceService, setLocale: () => {} });
  return { handlers, calls };
}

const INVALID = { ok: false, code: 'invalid_arguments' };

test('argument-less device channels ignore any argument (the page cannot smuggle a path or a definition)', async () => {
  const { handlers, calls } = setup();
  await handlers.deviceState({ path: 'C:/x' });
  await handlers.deviceLoadFile({ path: 'C:/x', text: '{}' });
  await handlers.deviceStop('x');
  await handlers.deviceCloseAll(5);
  assert.deepEqual(calls, [['getState'], ['loadFile'], ['stop'], ['closeAll']]);
});

test('deviceLoadSample: exactly { id } with a file-name shaped id (the service checks it against a scan)', async () => {
  const { handlers, calls } = setup();
  assert.equal((await handlers.deviceLoadSample({ id: 'matrix-switch.json' })).ok, true);
  assert.deepEqual(calls.at(-1), ['loadSample', 'matrix-switch.json']);
  const bad = [null, {}, { id: 5 }, { id: '' }, { id: 'matrix-switch' }, { id: '../x.json' }, { id: 'a\b.json' }, { id: 'a/b.json' },
    { id: `${'x'.repeat(60)}.json` }, { id: 'ok.json', path: 'C:/x' }, 'matrix-switch.json'];
  for (const arg of bad) assert.deepEqual(await handlers.deviceLoadSample(arg), INVALID, JSON.stringify(arg));
  assert.equal(calls.filter(([name]) => name === 'loadSample').length, 1, 'nothing invalid reached the service');
});

test('deviceRefreshSamples: no argument at all', async () => {
  const { handlers, calls } = setup();
  assert.equal((await handlers.deviceRefreshSamples()).ok, true);
  assert.deepEqual(calls, [['refreshSamples']]);
  assert.deepEqual(await handlers.deviceRefreshSamples({ path: 'C:/x' }), INVALID);
  assert.equal(calls.length, 1);
});

test('deviceStart: host must be one of the two allowed values and port an integer 0-65535; only those fields pass', async () => {
  const { handlers, calls } = setup();
  await handlers.deviceStart({ host: '127.0.0.1', port: 5200, definition: { evil: true }, path: 'x' });
  assert.deepEqual(calls.at(-1), ['start', { host: '127.0.0.1', port: 5200 }]);
  await handlers.deviceStart({ host: '0.0.0.0', port: 0 });
  assert.deepEqual(calls.at(-1), ['start', { host: '0.0.0.0', port: 0 }]);
  for (const bad of [null, {}, { host: 'localhost', port: 1 }, { host: '192.0.2.1', port: 1 }, { host: '127.0.0.1', port: -1 }, { host: '127.0.0.1', port: 1023 }, { host: '127.0.0.1', port: 80 }, { host: '127.0.0.1', port: 65536 }, { host: '127.0.0.1', port: '5' }, { host: '127.0.0.1', port: 1.5 }]) {
    assert.deepEqual(await handlers.deviceStart(bad), INVALID, JSON.stringify(bad));
  }
});

test('deviceSetFault: known fields only, with their types', async () => {
  const { handlers, calls } = setup();
  await handlers.deviceSetFault({ dropNextReplies: 2, extraDelayMs: 300, muted: true, other: 1 });
  assert.deepEqual(calls.at(-1), ['setFault', { dropNextReplies: 2, extraDelayMs: 300, muted: true }]);
  await handlers.deviceSetFault({ muted: false });
  assert.deepEqual(calls.at(-1), ['setFault', { muted: false }]);
  for (const bad of [null, 'x', [], { dropNextReplies: '2' }, { extraDelayMs: 1.5 }, { muted: 'yes' }, { dropNextReplies: null }]) {
    assert.deepEqual(await handlers.deviceSetFault(bad), INVALID, JSON.stringify(bad));
  }
});
