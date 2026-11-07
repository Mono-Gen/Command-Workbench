// The service with a UDP endpoint beside the TCP connection: sending, connection guards and
// periodic behavior must hold without inheriting TCP assumptions.
const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createService } = require('../../src/main/service');
const { createConnection } = require('../../src/main/connection');
const { createUdpEndpoint } = require('../../src/main/udp-endpoint');
const { createCommandStore } = require('../../src/main/storage');
const { createFakeClock, FakeSocket, flush } = require('../helpers/fakes');
const { FakeUdp } = require('../helpers/fake-udp');

const DATA = {
  schemaVersion: 1,
  devices: [{
    name: 'Lamp',
    host: '10.0.0.20',
    port: 5000,
    transport: 'udp',
    commands: [
      { name: 'Get state', text: 'STATE?[CR]', mode: 'text', appendTerminator: 'none', kind: 'query' },
      { name: 'Turn on', text: 'ON[CR]', mode: 'text', appendTerminator: 'none', kind: 'set' },
    ],
  }],
};

async function setup(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pw-service-udp-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  await fsp.writeFile(path.join(dir, 'workbench-commands.json'), JSON.stringify(DATA));
  const clock = createFakeClock();
  const tcpSockets = [];
  const udpSockets = [];
  const emitted = [];
  let service;
  const onEvent = (event) => service.handleConnectionEvent(event);
  const connection = createConnection({
    createSocket: () => { const s = new FakeSocket(); tcpSockets.push(s); return s; }, scheduler: clock.scheduler, now: clock.now, onEvent,
  });
  const udp = createUdpEndpoint({
    createSocket: () => { const s = new FakeUdp(); udpSockets.push(s); return s; },
    resolveHost: (h) => [h],
    getInterfaces: () => [{ address: '10.0.0.5', netmask: '255.255.255.0' }],
    scheduler: clock.scheduler,
    now: clock.now,
    onEvent,
  });
  service = createService({
    connection,
    udp,
    store: createCommandStore({ fs: fsp, dir, sleep: async () => {} }),
    confirm: async () => true,
    emit: (channel, payload) => emitted.push([channel, payload]),
    now: clock.now,
    scheduler: clock.scheduler,
  });
  await service.init();
  const channel = (name) => emitted.filter(([c]) => c === name).map(([, p]) => p);
  return { service, udp, connection, tcpSockets, udpSockets, emitted, channel, clock };
}

const UDP_TARGET = { transport: 'udp', host: '10.0.0.20', port: 5000 };
const sentTexts = (ctx) => ctx.udpSockets.flatMap((s) => s.sent.map((x) => Buffer.from(x.bytes).toString('latin1')));

async function udpReady(ctx, extra = {}) {
  assert.equal(ctx.service.connect({ ...UDP_TARGET, ...extra }).ok, true);
  await flush();
  assert.equal(ctx.service.getState().connectionState, 'connected');
}

test('state names the transport in use', async (t) => {
  const ctx = await setup(t);
  assert.equal(ctx.service.getState().transport, 'tcp');
  await udpReady(ctx);
  assert.equal(ctx.service.getState().transport, 'udp');
});

test('saved commands and direct input are sent over UDP', async (t) => {
  const ctx = await setup(t);
  await udpReady(ctx);
  assert.equal((await ctx.service.sendSaved({ device: 'Lamp', command: 'Turn on' })).ok, true);
  assert.equal((await ctx.service.sendSaved({ device: 'Lamp', command: 'Get state' })).ok, true);
  assert.equal((await ctx.service.sendDirect({ text: 'RAW', mode: 'text', appendTerminator: 'cr' })).ok, true);
  assert.deepEqual(sentTexts(ctx), ['ON\r', 'STATE?\r', 'RAW\r']);
});

test('a received datagram is shown as its own message, with the sender when it is not the target', async (t) => {
  const ctx = await setup(t);
  await udpReady(ctx, { acceptAnySource: true });
  const socket = ctx.udpSockets[0];
  // A multi-byte character split across two datagrams must NOT be joined (they are two messages).
  const snowman = Buffer.from('☃');
  socket.emit('message', snowman.subarray(0, 2), { address: '10.0.0.20', port: 5000 });
  socket.emit('message', snowman.subarray(2), { address: '10.0.0.20', port: 5000 });
  socket.emit('message', Buffer.from('hello'), { address: '10.0.0.77', port: 6000 });
  const logs = ctx.channel('log');
  assert.equal(logs.length, 3);
  assert.equal(logs[0].text.includes('☃'), false);
  assert.equal(logs[2].text, 'hello');
  assert.equal(logs[2].note, '10.0.0.77:6000');
  assert.equal(logs[0].note, undefined);
  assert.equal(ctx.channel('hints').at(-1).hints.some((h) => h.id === 'udp_other_source'), true);
});

test('hints use the UDP rules, not the TCP ones', async (t) => {
  const ctx = await setup(t);
  await udpReady(ctx);
  await ctx.service.sendDirect({ text: 'PING', mode: 'text', appendTerminator: 'none', expectsReply: true });
  ctx.clock.advance(4000);
  const ids = ctx.channel('hints').at(-1).hints.map((h) => h.id);
  assert.deepEqual(ids, ['udp_no_reply', 'check_terminator']);
});

test('periodic sending works over UDP and stops when the socket is lost', async (t) => {
  const ctx = await setup(t);
  await udpReady(ctx);
  assert.equal((await ctx.service.startPeriodic({ device: 'Lamp', command: 'Get state', intervalMs: 1000 })).ok, true);
  ctx.clock.advance(1000);
  await flush();
  assert.equal(sentTexts(ctx).length >= 1, true);
  ctx.udpSockets[0].emit('error', Object.assign(new Error('x'), { code: 'ECONNRESET' }));
  await flush();
  assert.equal(ctx.service.getState().periodicRunning, false, 'a lost socket stops the repeating sender');
});

test('TCP and UDP cannot run at the same time, and the other kind works after a disconnect', async (t) => {
  const ctx = await setup(t);
  await udpReady(ctx);
  assert.deepEqual(ctx.service.connect({ host: '192.0.2.5', port: 1100 }), { ok: false, code: 'busy' });
  assert.deepEqual(ctx.service.connect(UDP_TARGET), { ok: false, code: 'busy' });
  ctx.service.disconnect();
  await flush();
  assert.equal(ctx.service.getState().connectionState, 'closed');
  assert.equal(ctx.service.connect({ host: '192.0.2.5', port: 1100 }).ok, true);
  assert.equal(ctx.service.getState().transport, 'tcp');
  ctx.tcpSockets.at(-1).emit('connect');
  await flush();
  assert.equal(ctx.service.getState().connectionState, 'connected');
  // TCP ignores UDP-only fields and keeps its keepalive.
  assert.equal(ctx.service.setKeepAlive(true, 30000).ok, true);
});

test('keepalive is refused for UDP; a service without a UDP endpoint refuses UDP', async (t) => {
  const ctx = await setup(t);
  await udpReady(ctx);
  assert.deepEqual(ctx.service.setKeepAlive(true, 30000), { ok: false, code: 'unsupported' });
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pw-service-udp-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const plain = createService({
    connection: createConnection({ createSocket: () => new FakeSocket() }),
    store: createCommandStore({ fs: fsp, dir, sleep: async () => {} }),
    confirm: async () => true,
  });
  assert.deepEqual(plain.connect(UDP_TARGET), { ok: false, code: 'unsupported' });
});

test('a failed UDP connect leaves the TCP side usable and reports the failure as a fact', async (t) => {
  const ctx = await setup(t);
  const result = ctx.service.connect({ transport: 'udp', host: '8.8.8.8', port: 53 });
  assert.equal(result.ok, true, 'accepted, then refused during setup');
  await flush();
  const events = ctx.channel('event');
  assert.equal(events.some((e) => e.type === 'connect_fail' && e.code === 'target_not_allowed'), true);
  assert.equal(ctx.service.getState().connectionState, 'closed');
  assert.equal(ctx.service.connect({ host: '192.0.2.5', port: 1100 }).ok, true);
});

test('shutdown closes both kinds', async (t) => {
  const ctx = await setup(t);
  await udpReady(ctx);
  ctx.service.shutdown();
  await flush();
  assert.equal(ctx.udpSockets[0].closed, true);
  assert.equal(ctx.clock.pendingTimers(), 0);
});

test('a very large datagram is shown only in part, with its real size', async (t) => {
  const ctx = await setup(t);
  await udpReady(ctx);
  ctx.udpSockets[0].emit('message', Buffer.alloc(60000, 0x41), { address: '10.0.0.20', port: 5000 });
  const entry = ctx.channel('log')[0];
  assert.equal(entry.length, 60000);
  assert.equal(entry.shown, 4096);
  assert.equal(entry.text.length, 4096);
  assert.equal(entry.rows.reduce((n, row) => n + row.cells.length, 0), 4096, 'the screen gets only what it can show');
  ctx.udpSockets[0].emit('message', Buffer.from('small'), { address: '10.0.0.20', port: 5000 });
  assert.equal('shown' in ctx.channel('log')[1], false);
});
