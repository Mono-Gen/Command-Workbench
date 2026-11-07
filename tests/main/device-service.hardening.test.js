// Regression tests for the independent audit: what the device service pushes to the page is
// bounded, timers follow the server's real state, and arguments follow the same rules everywhere.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createDeviceService } = require('../../src/main/device-service');
const { createDeviceServer } = require('../../src/main/device-server');
const { bundledSampleStore } = require('../helpers/sample-store');
const { createFakeClock, flush } = require('../helpers/fakes');
const { FakeServer } = require('../helpers/fake-server');

const SAMPLES = path.join(__dirname, '..', '..', 'src', 'samples');
const CR = 0x0d;
const withCr = (text) => Uint8Array.from([...Buffer.from(text, 'utf8'), CR]);

function setup({ limits = {} } = {}) {
  const clock = createFakeClock();
  const emitted = [];
  const servers = [];
  let service;
  const server = createDeviceServer({
    createServer: (handler) => { const s = new FakeServer(handler); servers.push(s); return s; },
    scheduler: clock.scheduler,
    now: clock.now,
    onEvent: (event) => service.handleServerEvent(event),
  });
  service = createDeviceService({
    server,
    chooseFile: async () => ({ ok: false, code: 'cancelled' }),
    sampleStore: bundledSampleStore(),
    confirm: async () => true,
    emit: (channel, payload) => emitted.push([channel, payload]),
    now: clock.now,
    scheduler: clock.scheduler,
    limits,
  });
  const channel = (name) => emitted.filter(([c]) => c === name).map(([, p]) => p);
  return { service, server, clock, emitted, channel, fake: () => servers.at(-1) };
}

test('ports below 1024 are refused here too (0 and 1024-65535 only)', async () => {
  const ctx = setup();
  await ctx.service.loadSample('matrix-switch.json');
  for (const port of [1, 80, 1023]) {
    assert.deepEqual(await ctx.service.start({ host: '127.0.0.1', port }), { ok: false, code: 'invalid_port' }, String(port));
  }
  assert.equal((await ctx.service.start({ host: '127.0.0.1', port: 1024 })).ok, true);
});

test('state pushes caused by events are throttled; the next tick delivers the latest state', async () => {
  const ctx = setup();
  await ctx.service.loadSample('matrix-switch.json');
  await ctx.service.start({ host: '127.0.0.1', port: 0 });
  const socket = ctx.fake().accept();
  await flush();
  const before = ctx.channel('deviceState').length;

  for (let i = 0; i < 50; i += 1) {
    socket.emit('data', Buffer.from(withCr(i % 2 === 0 ? 'PWR 1' : 'PWR 0')));
  }
  await flush();
  assert.ok(ctx.channel('deviceState').length - before <= 2, 'a burst of state changes does not produce a burst of pushes');

  ctx.clock.advance(1000);
  assert.equal(ctx.channel('deviceState').at(-1).variables.power, 'standby', 'the tick delivers the latest state (50th change = PWR 0)');
});

test('events that the page does not need to see one by one (refused connections) are limited', async () => {
  const ctx = setup({ limits: { logEventsPerSecond: 3 } });
  for (let i = 0; i < 20; i += 1) ctx.service.handleServerEvent({ type: 'refused', reason: 'limit', t: 0, generation: 1 });
  assert.ok(ctx.channel('deviceEvent').filter((e) => e.type === 'refused').length <= 3);
});

test('when the server stops by itself, the service timers stop too', async () => {
  const ctx = setup();
  await ctx.service.loadSample('matrix-switch.json');
  await ctx.service.start({ host: '127.0.0.1', port: 0 });
  assert.ok(ctx.clock.pendingTimers() >= 1, 'the refresh timer runs while the server runs');

  // A server error after listening makes the server stop itself (no stop() call from the service).
  ctx.fake().emit('error', Object.assign(new Error('boom'), { code: 'EIO' }));
  await flush();
  assert.equal(ctx.server.getState().running, false);
  assert.equal(ctx.clock.pendingTimers(), 0, 'no timer keeps running after the server stopped');
  assert.ok(ctx.channel('deviceEvent').some((e) => e.type === 'server_error'));
});
