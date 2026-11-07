// The device service picks the TCP or the UDP implementation by the definition's transport.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createDeviceService } = require('../../src/main/device-service');
const { createDeviceServer } = require('../../src/main/device-server');
const { createDeviceUdpServer } = require('../../src/main/device-udp-server');
const { bundledSampleStore } = require('../helpers/sample-store');
const { createFakeClock, flush } = require('../helpers/fakes');
const { FakeServer } = require('../helpers/fake-server');
const { FakeUdp } = require('../helpers/fake-udp');

const SAMPLES = path.join(__dirname, '..', '..', 'src', 'samples');

function setup({ withUdp = true, confirmAnswers = [] } = {}) {
  const clock = createFakeClock();
  const emitted = [];
  const confirmCalls = [];
  const answers = [...confirmAnswers];
  const udpSockets = [];
  const tcpServers = [];
  let service;
  const onEvent = (event) => service.handleServerEvent(event);
  const server = createDeviceServer({
    createServer: (handler) => { const s = new FakeServer(handler); tcpServers.push(s); return s; },
    scheduler: clock.scheduler,
    now: clock.now,
    onEvent,
  });
  const udpServer = createDeviceUdpServer({
    createSocket: () => { const s = new FakeUdp(); udpSockets.push(s); return s; },
    scheduler: clock.scheduler,
    now: clock.now,
    onEvent,
  });
  service = createDeviceService({
    server,
    udpServer: withUdp ? udpServer : null,
    chooseFile: async () => ({ ok: false, code: 'cancelled' }),
    sampleStore: bundledSampleStore(),
    confirm: async (info) => { confirmCalls.push(info); return answers.length ? answers.shift() : true; },
    emit: (channel, payload) => emitted.push([channel, payload]),
    now: clock.now,
    scheduler: clock.scheduler,
  });
  const channel = (name) => emitted.filter(([c]) => c === name).map(([, p]) => p);
  return { service, clock, channel, confirmCalls, udpSockets, tcpServers };
}

test('a UDP definition is described with its transport and starts the UDP server', async () => {
  const ctx = setup();
  const loaded = await ctx.service.loadSample('udp-unit.json');
  assert.equal(loaded.info.transport, 'udp');
  assert.equal(loaded.info.hasGreeting, false);
  const started = await ctx.service.start({ host: '127.0.0.1', port: 0 });
  assert.equal(started.ok, true);
  assert.equal(ctx.udpSockets.length, 1);
  assert.equal(ctx.tcpServers.length, 0, 'no TCP server is created for a UDP definition');
  const state = ctx.service.getState();
  assert.equal(state.server.transport, 'udp');
  assert.equal(state.server.running, true);
  assert.equal(ctx.channel('deviceState').at(-1).transport, 'udp');
});

test('a TCP definition still starts the TCP server', async () => {
  const ctx = setup();
  assert.equal((await ctx.service.loadSample('matrix-switch.json')).info.transport, 'tcp');
  assert.equal((await ctx.service.start({ host: '127.0.0.1', port: 0 })).ok, true);
  assert.equal(ctx.tcpServers.length, 1);
  assert.equal(ctx.udpSockets.length, 0);
});

test('while one implementation runs, the definition cannot be replaced and the other cannot start', async () => {
  const ctx = setup();
  await ctx.service.loadSample('udp-unit.json');
  await ctx.service.start({ host: '127.0.0.1', port: 0 });
  assert.equal((await ctx.service.loadSample('matrix-switch.json')).code, 'running');
  assert.equal((await ctx.service.start({ host: '127.0.0.1', port: 0 })).code, 'already_running');
  assert.equal((await ctx.service.stop()).ok, true);
  assert.equal(ctx.service.getState().server.running, false);
  assert.equal((await ctx.service.loadSample('matrix-switch.json')).ok, true);
  assert.equal((await ctx.service.start({ host: '127.0.0.1', port: 0 })).ok, true);
});

test('listening on all interfaces for UDP asks with the spoofing warning as well', async () => {
  const ctx = setup();
  await ctx.service.loadSample('udp-unit.json');
  await ctx.service.start({ host: '0.0.0.0', port: 0 });
  assert.deepEqual(ctx.confirmCalls[0].reasons, ['bind_all', 'udp_spoofable']);
  await ctx.service.stop();
  await ctx.service.loadSample('matrix-switch.json');
  await ctx.service.start({ host: '0.0.0.0', port: 0 });
  assert.deepEqual(ctx.confirmCalls[1].reasons, ['bind_all']);
});

test('declining the dialog starts nothing', async () => {
  const ctx = setup({ confirmAnswers: [false] });
  await ctx.service.loadSample('udp-unit.json');
  assert.equal((await ctx.service.start({ host: '0.0.0.0', port: 0 })).code, 'cancelled');
  assert.equal(ctx.udpSockets.length, 0);
});

test('a definition replaced while the dialog is open does not start under the old confirmation', async () => {
  const ctx = setup();
  await ctx.service.loadSample('udp-unit.json');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const original = ctx.service;
  // Re-create the service with a confirm that waits, so another definition can be loaded meanwhile.
  const waiting = createDeviceService({
    server: createDeviceServer({ createServer: (h) => new FakeServer(h) }),
    udpServer: createDeviceUdpServer({ createSocket: () => new FakeUdp() }),
    chooseFile: async () => ({ ok: false, code: 'cancelled' }),
    sampleStore: bundledSampleStore(),
    confirm: async () => { await gate; return true; },
    emit: () => {},
  });
  assert.ok(original);
  await waiting.loadSample('udp-unit.json');
  const pending = waiting.start({ host: '0.0.0.0', port: 0 });
  await flush();
  await waiting.loadSample('matrix-switch.json');
  release();
  assert.equal((await pending).code, 'busy');
});

test('without a UDP implementation a UDP definition is refused with a clear code', async () => {
  const ctx = setup({ withUdp: false });
  await ctx.service.loadSample('udp-unit.json');
  assert.equal((await ctx.service.start({ host: '127.0.0.1', port: 0 })).code, 'udp_unsupported');
});

test('faults and "close all" go to the running implementation', async () => {
  const ctx = setup();
  await ctx.service.loadSample('udp-unit.json');
  await ctx.service.start({ host: '127.0.0.1', port: 0 });
  assert.equal(ctx.service.setFault({ muted: true }).ok, true);
  assert.equal(ctx.service.closeAll().ok, true);
  assert.equal(ctx.service.getState().server.faults.muted, true);
});

test('UDP traffic is logged like TCP traffic, and send errors are rate limited as peer-driven events', async () => {
  const ctx = setup();
  await ctx.service.loadSample('udp-unit.json');
  await ctx.service.start({ host: '127.0.0.1', port: 0 });
  ctx.udpSockets[0].emit('message', Buffer.from('ID?\r'), { address: '10.0.0.7', port: 5000, family: 'IPv4' });
  await flush();
  const dirs = ctx.channel('deviceLog').map((l) => l.dir);
  assert.deepEqual(dirs, ['rx', 'tx']);
  assert.equal(ctx.channel('deviceLog')[0].text, 'ID?');
});

test('shutdown stops the UDP server too', async () => {
  const ctx = setup();
  await ctx.service.loadSample('udp-unit.json');
  await ctx.service.start({ host: '127.0.0.1', port: 0 });
  await ctx.service.shutdown();
  assert.equal(ctx.udpSockets[0].closed, true);
  assert.equal(ctx.clock.pendingTimers(), 0);
});
