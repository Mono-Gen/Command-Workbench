// UDP endpoint tests with a fake dgram socket and a fake clock: every path is driven by the test.
const test = require('node:test');
const assert = require('node:assert/strict');

const { createUdpEndpoint } = require('../../src/main/udp-endpoint');
const { diagnose } = require('../../src/core/diagnose');
const { createFakeClock, flush } = require('../helpers/fakes');
const { FakeUdp } = require('../helpers/fake-udp');

const INTERFACES = [{ address: '10.0.0.5', netmask: '255.255.255.0' }, { address: '127.0.0.1', netmask: '255.0.0.0' }];
const bytes = (text) => Uint8Array.from(Buffer.from(text, 'latin1'));
const text = (u8) => Buffer.from(u8).toString('latin1');

function setup({ socketOptions = {}, resolve, limits = {} } = {}) {
  const clock = createFakeClock();
  const events = [];
  const sockets = [];
  const resolveCalls = [];
  const endpoint = createUdpEndpoint({
    createSocket: () => { const s = new FakeUdp(socketOptions); sockets.push(s); return s; },
    resolveHost: (host) => { resolveCalls.push(host); return resolve ? resolve(host) : [host]; },
    getInterfaces: () => INTERFACES,
    scheduler: clock.scheduler,
    now: clock.now,
    onEvent: (e) => events.push(e),
    limits,
  });
  const facts = (type) => events.filter((e) => e.type === type);
  return { endpoint, clock, events, sockets, resolveCalls, facts };
}

const TARGET = { host: '10.0.0.20', port: 5000 };

async function ready(options = {}, connectArgs = {}) {
  const ctx = setup(options);
  assert.deepEqual(ctx.endpoint.connect({ ...TARGET, ...connectArgs }), { ok: true, id: 1 });
  await flush();
  assert.equal(ctx.endpoint.getState(), 'connected');
  return ctx;
}

test('default mode: bind on all interfaces, connect to the pinned target, report ready', async () => {
  const ctx = await ready({}, { localPort: 5100 });
  const [socket] = ctx.sockets;
  assert.deepEqual(socket.bindArgs, { port: 5100, address: '0.0.0.0' });
  assert.deepEqual(socket.connectArgs, { port: 5000, address: '10.0.0.20' });
  const ok = ctx.facts('connect_ok')[0];
  assert.equal(ok.transport, 'udp');
  assert.equal(ok.localPort, 41000);
  assert.equal(ok.acceptAnySource, false);
  assert.deepEqual(ctx.events.filter((e) => e.type === 'state').map((e) => e.state), ['connecting', 'connected']);
});

test('accept-any mode: no connect(), sends go to an explicit address', async () => {
  const ctx = await ready({}, { acceptAnySource: true });
  const [socket] = ctx.sockets;
  assert.equal(socket.connectArgs, null);
  assert.deepEqual(await ctx.endpoint.send(bytes('PWR?\r'), {}), { ok: true });
  assert.deepEqual(socket.sent[0].target, { port: 5000, address: '10.0.0.20' });
  assert.equal(ctx.facts('connect_ok')[0].acceptAnySource, true);
});

test('arguments are validated again', () => {
  const { endpoint } = setup();
  const cases = [
    [{}, 'invalid_target'], [{ host: '', port: 5 }, 'invalid_target'], [{ host: 'a b', port: 5 }, 'invalid_target'],
    [{ host: 'x'.repeat(254), port: 5 }, 'invalid_target'], [{ host: 'h', port: 0 }, 'invalid_target'], [{ host: 'h', port: 65536 }, 'invalid_target'],
    [{ host: 'h', port: '5' }, 'invalid_target'],
    [{ ...TARGET, localPort: 80 }, 'invalid_local_port'], [{ ...TARGET, localPort: 70000 }, 'invalid_local_port'], [{ ...TARGET, localPort: '5100' }, 'invalid_local_port'],
    [{ ...TARGET, acceptAnySource: 'yes' }, 'invalid_arguments'],
  ];
  for (const [args, code] of cases) assert.deepEqual(endpoint.connect(args), { ok: false, code }, JSON.stringify(args));
});

test('the target is resolved once, pinned, and every answer must be allowed', async () => {
  const ctx = setup({ resolve: () => ['10.0.0.20', '10.0.0.21'] });
  ctx.endpoint.connect({ host: 'player.local', port: 5000 });
  await flush();
  assert.equal(ctx.sockets[0].connectArgs.address, '10.0.0.20');
  assert.equal(ctx.resolveCalls.length, 1);

  const cases = {
    public: ['8.8.8.8', 'target_not_allowed'],
    multicast: ['224.0.0.1', 'multicast'],
    limited: ['255.255.255.255', 'limited_broadcast'],
    directed: ['10.0.0.255', 'directed_broadcast'],
    unspecified: ['0.0.0.0', 'unspecified'],
    linkLocal: ['169.254.169.254', 'link_local'],
    v6: ['::1', 'not_ipv4'],
  };
  for (const [name, [address, code]] of Object.entries(cases)) {
    const c = setup({ resolve: () => [address] });
    c.endpoint.connect({ host: 'x.local', port: 5000 });
    await flush();
    assert.equal(c.facts('connect_fail')[0]?.code, code, name);
    assert.equal(c.sockets.length, 0, `${name}: no socket is created for a refused target`);
    assert.equal(c.endpoint.getState(), 'closed');
  }
  const mixed = setup({ resolve: () => ['10.0.0.20', '8.8.8.8'] });
  mixed.endpoint.connect({ host: 'mixed.example', port: 5000 });
  await flush();
  assert.equal(mixed.facts('connect_fail')[0].code, 'target_not_allowed', 'one bad answer refuses the whole name');
});

test('name lookup failures and the setup deadline end in connect_fail', async () => {
  let ctx = setup({ resolve: () => { throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }); } });
  ctx.endpoint.connect(TARGET);
  await flush();
  assert.equal(ctx.facts('connect_fail')[0].code, 'ENOTFOUND');
  ctx = setup({ resolve: () => [] });
  ctx.endpoint.connect(TARGET);
  await flush();
  assert.equal(ctx.facts('connect_fail')[0].code, 'ENOTFOUND');

  ctx = setup({ resolve: () => new Promise(() => {}) });
  ctx.endpoint.connect(TARGET);
  ctx.clock.advance(4999);
  assert.equal(ctx.endpoint.getState(), 'connecting');
  ctx.clock.advance(1);
  assert.equal(ctx.endpoint.getState(), 'closed');
  assert.equal(ctx.facts('connect_fail')[0].code, 'CONNECT_TIMEOUT');
  assert.equal(ctx.clock.pendingTimers(), 0);
});

test('a busy local port is reported as connect_fail and the hint explains it', async () => {
  const ctx = setup({ socketOptions: { bindError: 'EADDRINUSE' } });
  ctx.endpoint.connect({ ...TARGET, localPort: 5100 });
  await flush();
  assert.equal(ctx.facts('connect_fail')[0].code, 'EADDRINUSE');
  assert.equal(ctx.sockets[0].closed, true);
  assert.deepEqual(diagnose(ctx.endpoint.getHistory(), 100).map((h) => h.id), ['udp_local_port_busy']);
  assert.equal(ctx.clock.pendingTimers(), 0);
  // The endpoint can be used again afterwards.
  assert.equal(ctx.endpoint.connect(TARGET).ok, true);
});

test('received datagrams keep their boundaries; the source is checked only in accept-any mode', async () => {
  const ctx = await ready({}, { acceptAnySource: true });
  const [socket] = ctx.sockets;
  socket.emit('message', Buffer.from('A'), { address: '10.0.0.20', port: 5000 });
  socket.emit('message', Buffer.from('B'), { address: '10.0.0.20', port: 5001 });
  socket.emit('message', Buffer.from('C'), { address: '10.0.0.99', port: 5000 });
  const recv = ctx.facts('recv');
  assert.deepEqual(recv.map((e) => [text(e.bytes), e.fromTarget]), [['A', true], ['B', false], ['C', false]]);
  assert.deepEqual(recv[1].remote, { address: '10.0.0.20', port: 5001 });
  // The history keeps facts but not payloads.
  assert.equal(ctx.endpoint.getHistory().every((e) => !('bytes' in e)), true);
  assert.deepEqual(diagnose(ctx.endpoint.getHistory().concat([{ type: 'send', t: -1, transport: 'udp', expectsReply: true }]), 100000).map((h) => h.id), ['udp_other_source']);

  const filtered = await ready();
  filtered.sockets[0].emit('message', Buffer.from('X'), { address: '10.0.0.20', port: 5000 });
  assert.equal(filtered.facts('recv')[0].fromTarget, true, 'the system already dropped other sources');
});

test('an empty datagram is reported, not shown as data', async () => {
  const ctx = await ready();
  ctx.sockets[0].emit('message', Buffer.alloc(0), { address: '10.0.0.20', port: 5000 });
  assert.equal(ctx.facts('recv').length, 0);
  assert.equal(ctx.facts('recv_empty').length, 1);
});

test('a flood of received datagrams is limited and reported', async () => {
  const ctx = await ready({ limits: { recvPerSecond: 5 } });
  for (let i = 0; i < 20; i += 1) ctx.sockets[0].emit('message', Buffer.from('x'), { address: '10.0.0.20', port: 5000 });
  assert.equal(ctx.facts('recv').length, 5);
  ctx.clock.advance(1000);
  ctx.sockets[0].emit('message', Buffer.from('y'), { address: '10.0.0.20', port: 5000 });
  assert.equal(ctx.facts('recv_flood')[0].dropped, 15);
  assert.equal(ctx.facts('recv').length, 6);
});

test('sending: one send is one datagram, in order, with the facts the diagnosis needs', async () => {
  const ctx = await ready();
  const results = await Promise.all([
    ctx.endpoint.send(bytes('A\r'), { expectsReply: true, endsWithTerminator: true }),
    ctx.endpoint.send(bytes('B'), { expectsReply: false, endsWithTerminator: false }),
  ]);
  assert.deepEqual(results, [{ ok: true }, { ok: true }]);
  assert.deepEqual(ctx.sockets[0].sent.map((s) => text(s.bytes)), ['A\r', 'B']);
  assert.equal(ctx.sockets[0].sent[0].target, null, 'connected mode sends without an address');
  assert.deepEqual(ctx.facts('send').map((e) => [e.expectsReply, e.endsWithTerminator]), [[true, true], [false, false]]);
});

test('send refuses bad input and oversized datagrams before anything is sent', async () => {
  const ctx = await ready();
  assert.deepEqual(await ctx.endpoint.send(new Uint8Array(0)), { ok: false, code: 'invalid_data' });
  assert.deepEqual(await ctx.endpoint.send('text'), { ok: false, code: 'invalid_data' });
  assert.deepEqual(await ctx.endpoint.send(new Uint8Array(65508)), { ok: false, code: 'too_large' });
  assert.equal((await ctx.endpoint.send(new Uint8Array(65507))).ok, true);
  assert.equal((await ctx.endpoint.send(new Uint8Array(1473))).ok, true, 'fragmentation is a warning, not an error');
  assert.equal(ctx.sockets[0].sent.length, 2);
  const closed = setup();
  assert.deepEqual(await closed.endpoint.send(bytes('x')), { ok: false, code: 'not_connected' });
});

test('a failing send is that datagram only: facts, result and the socket stays open', async () => {
  const ctx = await ready();
  ctx.sockets[0].sendError = Object.assign(new Error('x'), { code: 'EMSGSIZE' });
  assert.deepEqual(await ctx.endpoint.send(bytes('x')), { ok: false, code: 'write_failed', errno: 'EMSGSIZE' });
  assert.equal(ctx.facts('send_error')[0].code, 'EMSGSIZE');
  assert.equal(ctx.endpoint.getState(), 'connected');
  assert.deepEqual(diagnose(ctx.endpoint.getHistory(), 10).map((h) => h.id), ['udp_datagram_too_large']);
  ctx.sockets[0].sendError = null;
  assert.equal((await ctx.endpoint.send(bytes('y'))).ok, true);

  ctx.sockets[0].throwOnSend = Object.assign(new Error('not running'), { code: 'ERR_SOCKET_DGRAM_NOT_RUNNING' });
  assert.equal((await ctx.endpoint.send(bytes('z'))).ok, false, 'a throwing socket does not crash the caller');
});

test('the guard runs right before the datagram goes out, after waiting in the queue', async () => {
  const ctx = await ready();
  ctx.sockets[0].heldSends = [];
  let allowed = true;
  const first = ctx.endpoint.send(bytes('1'), { guard: () => true });
  const second = ctx.endpoint.send(bytes('2'), { guard: () => allowed });
  await flush();
  allowed = false; // changed while the second one waited behind the first
  ctx.sockets[0].heldSends.shift()(null);
  assert.deepEqual(await first, { ok: true });
  assert.deepEqual(await second, { ok: false, code: 'blocked', reason: 'changed_before_send' });
  assert.deepEqual(ctx.sockets[0].sent.map((s) => text(s.bytes)), ['1']);
  const throwing = await ctx.endpoint.send(bytes('3'), { guard: () => { throw new Error('x'); } });
  assert.equal(throwing.code, 'blocked');
});

test('the send queue and the send rate are bounded', async () => {
  const ctx = await ready({ limits: { maxQueuedWrites: 2, sendsPerSecond: 3, sendBytesPerSecond: 10 } });
  ctx.sockets[0].heldSends = [];
  const a = ctx.endpoint.send(bytes('a'));
  const b = ctx.endpoint.send(bytes('b'));
  assert.deepEqual(await ctx.endpoint.send(bytes('c')), { ok: false, code: 'queue_full' });
  // The second send only starts after the first one's callback: release them one by one.
  for (let i = 0; i < 5; i += 1) {
    await flush();
    while (ctx.sockets[0].heldSends.length) ctx.sockets[0].heldSends.shift()(null);
  }
  await Promise.all([a, b]);

  const limited = await ready({ limits: { sendsPerSecond: 3 } });
  const outcomes = [];
  for (let i = 0; i < 5; i += 1) outcomes.push((await limited.endpoint.send(bytes('x'))).code ?? 'ok');
  assert.deepEqual(outcomes, ['ok', 'ok', 'ok', 'rate_limited', 'rate_limited']);
  limited.clock.advance(1000);
  assert.equal((await limited.endpoint.send(bytes('x'))).ok, true, 'the window moves on');

  const bytesLimited = await ready({ limits: { sendBytesPerSecond: 10 } });
  assert.equal((await bytesLimited.endpoint.send(new Uint8Array(8))).ok, true);
  assert.equal((await bytesLimited.endpoint.send(new Uint8Array(8))).code, 'rate_limited');
});

test('starting connections too often is refused', () => {
  const ctx = setup();
  const codes = [];
  for (let i = 0; i < 7; i += 1) {
    const r = ctx.endpoint.connect(TARGET);
    codes.push(r.ok ? 'ok' : r.code);
    ctx.endpoint.disconnect();
  }
  assert.deepEqual(codes, ['ok', 'ok', 'ok', 'ok', 'ok', 'rate_limited', 'rate_limited']);
  ctx.clock.advance(10000);
  assert.equal(ctx.endpoint.connect(TARGET).ok, true);
});

test('only one connection at a time', async () => {
  const ctx = await ready();
  assert.deepEqual(ctx.endpoint.connect(TARGET), { ok: false, code: 'busy' });
});

test('disconnect while connecting is a cancellation, not a failure', async () => {
  const ctx = setup({ resolve: () => new Promise(() => {}) });
  ctx.endpoint.connect(TARGET);
  assert.deepEqual(ctx.endpoint.disconnect(), { ok: true });
  assert.equal(ctx.endpoint.getState(), 'closed');
  assert.equal(ctx.facts('connect_fail').length, 0);
  assert.equal(ctx.clock.pendingTimers(), 0);
});

test('disconnect while ready closes the socket and settles on its close event', async () => {
  const ctx = await ready();
  const pendingSend = (() => { ctx.sockets[0].heldSends = []; return ctx.endpoint.send(bytes('x')); })();
  await flush();
  ctx.endpoint.disconnect();
  assert.equal(ctx.endpoint.getState(), 'closing');
  await flush();
  assert.equal(ctx.endpoint.getState(), 'closed');
  assert.equal(ctx.sockets[0].closed, true);
  assert.equal(ctx.clock.pendingTimers(), 0);
  assert.equal((await pendingSend).ok, false, 'a send waiting for its callback is settled');
  assert.deepEqual(ctx.endpoint.disconnect(), { ok: true }, 'idempotent');
});

test('if the socket never reports close, the grace timer settles the state', async () => {
  const ctx = await ready();
  ctx.sockets[0].close = () => { ctx.sockets[0].closed = true; }; // never emits 'close'
  ctx.endpoint.disconnect();
  assert.equal(ctx.endpoint.getState(), 'closing');
  ctx.clock.advance(1000);
  assert.equal(ctx.endpoint.getState(), 'closed');
});

test('an unexpected socket error or close is reported as socket_closed, once', async () => {
  let ctx = await ready();
  ctx.sockets[0].emit('error', Object.assign(new Error('boom'), { code: 'ECONNRESET' }));
  await flush();
  assert.equal(ctx.endpoint.getState(), 'closed');
  assert.deepEqual(ctx.facts('socket_closed').map((e) => e.code), ['ECONNRESET']);
  ctx.sockets[0].emit('close');
  assert.equal(ctx.facts('socket_closed').length, 1);

  ctx = await ready();
  ctx.sockets[0].emit('close');
  assert.equal(ctx.endpoint.getState(), 'closed');
  assert.equal(ctx.facts('socket_closed')[0].code, null);
});

test('events of an old connection never touch a new one', async () => {
  const ctx = await ready();
  const old = ctx.sockets[0];
  ctx.endpoint.disconnect();
  await flush();
  assert.equal(ctx.endpoint.connect(TARGET).ok, true);
  await flush();
  assert.equal(ctx.endpoint.getId(), 2);
  old.emit('message', Buffer.from('late'), { address: '10.0.0.20', port: 5000 });
  old.emit('error', new Error('late'));
  old.emit('close');
  assert.equal(ctx.endpoint.getState(), 'connected');
  assert.equal(ctx.facts('recv').length, 0);
});

test('keepalive is not available for UDP; getId and history follow the connection', async () => {
  const ctx = await ready();
  assert.deepEqual(ctx.endpoint.setKeepAlive(true, 1000), { ok: false, code: 'unsupported' });
  assert.equal(ctx.endpoint.getId(), 1);
  assert.equal(ctx.endpoint.getHistory().every((e) => e.transport === 'udp'), true);
  ctx.endpoint.disconnect();
  await flush();
  ctx.endpoint.connect(TARGET);
  assert.equal(ctx.endpoint.getHistory().length, 0, 'a new connection starts a new history');
});

test('a throwing event listener cannot break the endpoint', async () => {
  const errors = [];
  const clock = createFakeClock();
  const sockets = [];
  const endpoint = createUdpEndpoint({
    createSocket: () => { const s = new FakeUdp(); sockets.push(s); return s; },
    resolveHost: (h) => [h],
    getInterfaces: () => INTERFACES,
    scheduler: clock.scheduler,
    now: clock.now,
    onEvent: () => { throw new Error('boom'); },
    onListenerError: (e) => errors.push(e),
  });
  endpoint.connect(TARGET);
  await flush();
  assert.equal(endpoint.getState(), 'connected');
  assert.equal((await endpoint.send(bytes('x'))).ok, true);
  assert.ok(errors.length > 0);
});

test('a loopback target is reached through a bind to 127.0.0.1; a LAN target binds all interfaces', async () => {
  const loop = await ready({}, { host: '127.0.0.1' });
  assert.equal(loop.sockets[0].bindArgs.address, '127.0.0.1');
  const other = await ready({}, { host: '127.5.5.5' });
  assert.equal(other.sockets[0].bindArgs.address, '127.0.0.1');
  const lan = await ready();
  assert.equal(lan.sockets[0].bindArgs.address, '0.0.0.0');
});

test('the result of a send that finishes after a reconnect is not reported to the new connection', async () => {
  const ctx = await ready();
  ctx.sockets[0].heldSends = [];
  const late = ctx.endpoint.send(bytes('old'));
  await flush();
  ctx.endpoint.disconnect();
  await flush();
  assert.equal(ctx.endpoint.connect(TARGET).ok, true);
  await flush();
  // The old socket now reports an error for the datagram it was sending.
  ctx.sockets[0].heldSends.shift()(Object.assign(new Error('x'), { code: 'EMSGSIZE' }));
  assert.equal((await late).ok, false);
  assert.equal(ctx.facts('send_error').length, 0, 'nothing leaks into the history or the events');
  assert.equal(ctx.endpoint.getHistory().some((e) => e.type === 'send_error'), false);
});

test('rates are measured over a sliding window: a burst split across a second boundary does not pass twice the limit', async () => {
  const ctx = await ready({ limits: { sendsPerSecond: 3 } });
  ctx.clock.advance(999);
  const first = [];
  for (let i = 0; i < 3; i += 1) first.push((await ctx.endpoint.send(bytes('x'))).ok);
  ctx.clock.advance(2); // just past the second a fixed window would restart at
  assert.deepEqual(first, [true, true, true]);
  assert.equal((await ctx.endpoint.send(bytes('x'))).code, 'rate_limited');
  ctx.clock.advance(998); // the first three are now a full second old
  assert.equal((await ctx.endpoint.send(bytes('x'))).ok, true);

  const recv = await ready({ limits: { recvPerSecond: 3 } });
  recv.clock.advance(999);
  for (let i = 0; i < 3; i += 1) recv.sockets[0].emit('message', Buffer.from('a'), { address: '10.0.0.20', port: 5000 });
  recv.clock.advance(2);
  for (let i = 0; i < 3; i += 1) recv.sockets[0].emit('message', Buffer.from('b'), { address: '10.0.0.20', port: 5000 });
  assert.equal(recv.facts('recv').length, 3, 'the second burst is still inside the window');
});

test('received bytes are limited too, before anything is copied', async () => {
  const ctx = await ready({ limits: { recvBytesPerSecond: 100 } });
  const big = Buffer.alloc(60, 1);
  ctx.sockets[0].emit('message', big, { address: '10.0.0.20', port: 5000 });
  ctx.sockets[0].emit('message', big, { address: '10.0.0.20', port: 5000 });
  assert.equal(ctx.facts('recv').length, 1, 'the second 60 bytes exceed 100 bytes per second');
  ctx.clock.advance(1000);
  ctx.sockets[0].emit('message', big, { address: '10.0.0.20', port: 5000 });
  assert.equal(ctx.facts('recv').length, 2);
  assert.equal(ctx.facts('recv_flood')[0].dropped, 1);
});

