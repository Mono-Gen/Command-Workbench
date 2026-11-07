// Controller (udp-endpoint) <-> UDP device over real sockets on 127.0.0.1. Ports are chosen by the
// OS, datagrams are sent one at a time and every wait has a deadline; loss, duplication and order
// are never assumed beyond what one-at-a-time use needs (delivery is not guaranteed even on loopback).
const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const fs = require('node:fs');
const path = require('node:path');

const { createDeviceUdpServer } = require('../../src/main/device-udp-server');
const { createUdpEndpoint } = require('../../src/main/udp-endpoint');
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

const sample = () => {
  const result = parseDefinitionText(fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'samples', 'udp-unit.json'), 'utf8'));
  assert.equal(result.ok, true);
  return result.definition;
};

async function startDevice(t) {
  const events = [];
  const server = createDeviceUdpServer({ onEvent: (e) => events.push(e) });
  t.after(() => server.stop());
  const result = await server.start({ definition: sample(), host: HOST, port: 0 });
  assert.equal(result.ok, true, JSON.stringify(result));
  return { server, port: result.port, events };
}

function controller(t) {
  const events = [];
  const endpoint = createUdpEndpoint({ onEvent: (e) => events.push(e) });
  t.after(async () => { endpoint.disconnect(); await sleep(20); });
  const replies = () => events.filter((e) => e.type === 'recv').map((e) => Buffer.from(e.bytes).toString('latin1').split(CR).join('<CR>'));
  return { endpoint, events, replies };
}

async function connectTo(c, port) {
  assert.equal(c.endpoint.connect({ host: HOST, port }).ok, true);
  await until(() => c.endpoint.getState() === 'connected', 'socket ready');
}

// The sample ignores commands that come less than 50 ms apart (per source), so each request waits.
async function ask(c, text) {
  await sleep(70);
  const before = c.replies().length;
  assert.equal((await c.endpoint.send(Uint8Array.from(Buffer.from(text, 'latin1')), { expectsReply: true })).ok, true);
  await until(() => c.replies().length > before, `reply to ${text}`);
  return c.replies()[before];
}

test('a controller gets one reply per datagram, with or without the trailing terminator', async (t) => {
  const device = await startDevice(t);
  const c = controller(t);
  await connectTo(c, device.port);
  assert.equal(await ask(c, `ID?${CR}`), 'UNIT 1.0<CR>');
  assert.equal(await ask(c, 'LEVEL?'), 'LEVEL=5<CR>');
  assert.equal(await ask(c, `LEVEL 3${CR}`), 'OK<CR>');
  await until(() => c.replies().includes('EVT LEVEL=3<CR>'), 'announcement to the sender too');
  assert.equal(await ask(c, `LEVEL?${CR}`), 'LEVEL=3<CR>');
  assert.ok(c.events.filter((e) => e.type === 'recv').every((e) => e.fromTarget === true));
});

test('two controllers are separate peers; a change by one is announced to the other', async (t) => {
  const device = await startDevice(t);
  const a = controller(t);
  const b = controller(t);
  await connectTo(a, device.port);
  await connectTo(b, device.port);
  assert.equal(await ask(a, 'ID?'), 'UNIT 1.0<CR>');
  assert.equal(await ask(b, 'ID?'), 'UNIT 1.0<CR>');
  assert.equal(device.server.getState().connections.length, 2);
  assert.equal(await ask(a, 'LEVEL 9'), 'OK<CR>');
  await until(() => b.replies().includes('EVT LEVEL=9<CR>'), 'announcement to b');
});

test('a datagram that is not a known command gets the unknown reply, and the port stays usable after stop and restart', async (t) => {
  const device = await startDevice(t);
  const c = controller(t);
  await connectTo(c, device.port);
  assert.equal(await ask(c, 'NOPE'), 'ERR 2<CR>');
  const { port } = device;
  await device.server.stop();
  const again = await device.server.start({ definition: sample(), host: HOST, port });
  assert.equal(again.ok, true, 'the port is released by stop');
  assert.equal(await ask(c, 'ID?'), 'UNIT 1.0<CR>');
});

test('a second server on a busy port reports listen_failed', async (t) => {
  const device = await startDevice(t);
  const other = createDeviceUdpServer();
  const result = await other.start({ definition: sample(), host: HOST, port: device.port });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'listen_failed');
  assert.equal(other.getState().lifecycle, 'idle');
});

test('a plain socket sees datagram boundaries kept: two requests, two replies', async (t) => {
  const device = await startDevice(t);
  const socket = dgram.createSocket('udp4');
  t.after(() => { try { socket.close(); } catch { /* already closed */ } });
  const got = [];
  socket.on('message', (m) => got.push(m.toString('latin1').split(CR).join('<CR>')));
  const sendOne = (text) => new Promise((resolve) => socket.send(Buffer.from(text, 'latin1'), device.port, HOST, resolve));
  await sendOne(`ID?${CR}`);
  await until(() => got.length === 1, 'first reply');
  await sleep(70);
  await sendOne(`LEVEL?${CR}`);
  await until(() => got.length === 2, 'second reply');
  assert.deepEqual(got, ['UNIT 1.0<CR>', 'LEVEL=5<CR>']);
});
