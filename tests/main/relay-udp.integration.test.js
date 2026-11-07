// Controller (udp-endpoint) -> UDP relay -> UDP device over real sockets on 127.0.0.1. Ports come
// from the OS, requests are sent one at a time and every wait has a deadline; loss and order are
// never assumed beyond what one-at-a-time use needs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createUdpRelay } = require('../../src/main/relay-udp');
const { createDeviceUdpServer } = require('../../src/main/device-udp-server');
const { createUdpEndpoint } = require('../../src/main/udp-endpoint');
const { createRecorder, serializeRecording, parseRecordingText } = require('../../src/core/recording');
const { parseDefinitionText } = require('../../src/core/device-definition');

const HOST = '127.0.0.1';
const CR = String.fromCharCode(13);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, label, ms = 4000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(5);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

async function chain(t) {
  const parsed = parseDefinitionText(fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'samples', 'udp-unit.json'), 'utf8'));
  assert.equal(parsed.ok, true);
  const device = createDeviceUdpServer();
  t.after(() => device.stop());
  const d = await device.start({ definition: parsed.definition, host: HOST, port: 0 });
  assert.equal(d.ok, true);

  const recorder = createRecorder({ now: () => performance.now(), transport: 'udp' });
  const relayEvents = [];
  const relay = createUdpRelay({ recorder, onEvent: (e) => relayEvents.push(e) });
  t.after(() => relay.stop());
  const r = await relay.start({ listenHost: HOST, listenPort: 0, upstreamHost: HOST, upstreamPort: d.port });
  assert.equal(r.ok, true, JSON.stringify(r));

  const events = [];
  const endpoint = createUdpEndpoint({ onEvent: (e) => events.push(e) });
  t.after(async () => { endpoint.disconnect(); await sleep(20); });
  assert.equal(endpoint.connect({ host: HOST, port: r.port }).ok, true);
  await until(() => endpoint.getState() === 'connected', 'socket ready');
  const replies = () => events.filter((e) => e.type === 'recv').map((e) => Buffer.from(e.bytes).toString('latin1').split(CR).join('<CR>'));
  const ask = async (text) => {
    await sleep(70); // the sample ignores commands closer than 50 ms
    const before = replies().length;
    assert.equal((await endpoint.send(Uint8Array.from(Buffer.from(text, 'latin1')), { expectsReply: true })).ok, true);
    await until(() => replies().length > before, `reply to ${text}`);
    return replies()[before];
  };
  return { ask, replies, recorder, relay, device, relayEvents };
}

test('requests and replies pass through unchanged, and the recording keeps one event per datagram', async (t) => {
  const c = await chain(t);
  assert.equal(await c.ask(`ID?${CR}`), 'UNIT 1.0<CR>');
  assert.equal(await c.ask('LEVEL?'), 'LEVEL=5<CR>');
  assert.equal(await c.ask(`LEVEL 4${CR}`), 'OK<CR>');
  await until(() => c.replies().includes('EVT LEVEL=4<CR>'), 'announcement');

  const snapshot = c.recorder.snapshot();
  assert.equal(snapshot.transport, 'udp');
  assert.equal(snapshot.connections.length, 1, 'one session');
  const view = snapshot.events.map((e) => `${e.d}:${Buffer.from(e.bytes).toString('latin1').split(CR).join('<CR>')}`);
  // Requests keep their exact bytes (with or without the terminator); each reply is its own event.
  assert.deepEqual(view.filter((v) => v.startsWith('up:')), ['up:ID?<CR>', 'up:LEVEL?', 'up:LEVEL 4<CR>']);
  assert.deepEqual(view.filter((v) => v.startsWith('down:')).sort(), ['down:EVT LEVEL=4<CR>', 'down:LEVEL=5<CR>', 'down:OK<CR>', 'down:UNIT 1.0<CR>'].sort());
});

test('the device sees the relay as one source and the recording round-trips through the file format', async (t) => {
  const c = await chain(t);
  await c.ask('ID?');
  assert.equal(c.device.getState().connections.length, 1);
  const text = serializeRecording(c.recorder.snapshot());
  assert.ok(!text.includes('127.0.0.1'), 'no address in the recording');
  const parsed = parseRecordingText(text);
  assert.equal(parsed.ok, true, JSON.stringify(parsed.errors));
  assert.equal(parsed.recording.transport, 'udp');
  assert.equal(parsed.recording.events.length, 2);
});

test('stopping the relay releases its port and closes the session as stop', async (t) => {
  const c = await chain(t);
  await c.ask('ID?');
  const { port } = c.relay.getState();
  assert.equal((await c.relay.stop()).ok, true);
  assert.equal(c.recorder.snapshot().connections[0].closeReason, 'stop');
  const again = await c.relay.start({ listenHost: HOST, listenPort: port, upstreamHost: HOST, upstreamPort: c.device.getState().port });
  assert.equal(again.ok, true, 'the port was released');
});
