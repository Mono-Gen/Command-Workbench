// Tests for the UDP relay with fake sockets, a real recorder and a manual clock.
// Expected behavior comes from the Phase 4 plan (5.4, 12.5), not from the code.
const test = require('node:test');
const assert = require('node:assert/strict');

const { createUdpRelay } = require('../../src/main/relay-udp');
const { createRecorder } = require('../../src/core/recording');
const { createFakeClock, flush } = require('../helpers/fakes');
const { FakeUdp } = require('../helpers/fake-udp');

const enc = (text) => Buffer.from(text, 'latin1');
const textOf = (bytes) => Buffer.from(bytes).toString('latin1');
const A = { address: '10.0.0.7', port: 50001, family: 'IPv4' };
const B = { address: '10.0.0.8', port: 50002, family: 'IPv4' };
const IFACES = [{ address: '10.0.0.5', netmask: '255.255.255.0' }, { address: '127.0.0.1', netmask: '255.0.0.0' }];

function setup({ limits = {}, resolve = async () => ['10.0.0.20'], bindError = null } = {}) {
  const clock = createFakeClock();
  const events = [];
  const sockets = [];
  const recorder = createRecorder({ now: clock.now, transport: 'udp' });
  const relay = createUdpRelay({
    createSocket: () => {
      const s = new FakeUdp(sockets.length === 0 && bindError ? { bindError } : {});
      s.localPort = 6000 + sockets.length;
      sockets.push(s);
      return s;
    },
    resolveHost: resolve,
    localAddresses: () => ['127.0.0.1', '10.0.0.5'],
    getInterfaces: () => IFACES,
    recorder,
    scheduler: clock.scheduler,
    now: clock.now,
    onEvent: (e) => events.push(e),
    limits,
  });
  return {
    relay, recorder, clock, events, sockets, listener: () => sockets[0], session: (n = 1) => sockets[n],
  };
}

const OPTIONS = { listenHost: '127.0.0.1', listenPort: 0, upstreamHost: 'device.test', upstreamPort: 7000 };

async function started(ctx, options = OPTIONS, hooks = {}) {
  const result = await ctx.relay.start(options, hooks);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}

async function fromClient(ctx, text, from = A) {
  ctx.listener().emit('message', enc(text), from);
  await flush();
}

const ofType = (ctx, type) => ctx.events.filter((e) => e.type === type);
const recorded = (ctx) => ctx.recorder.snapshot().events.map((e) => `${e.c}${e.d}:${textOf(e.bytes)}`);

test('start resolves once, pins an approved IPv4 address and reports it', async () => {
  const ctx = setup();
  const result = await started(ctx);
  assert.equal(result.upstreamAddress, '10.0.0.20');
  assert.deepEqual(ctx.listener().bindArgs, { address: '127.0.0.1', port: 0 });
  assert.equal(ctx.relay.getState().transport, 'udp');
});

test('validation and address policy: nothing listens for a refused target', async () => {
  const ctx = setup();
  assert.equal((await ctx.relay.start({ ...OPTIONS, listenHost: '192.0.2.1' })).code, 'invalid_host');
  assert.equal((await ctx.relay.start({ ...OPTIONS, listenPort: 80 })).code, 'invalid_port');
  assert.equal((await ctx.relay.start({ ...OPTIONS, upstreamHost: 'bad host' })).code, 'invalid_upstream_host');
  assert.equal((await ctx.relay.start({ ...OPTIONS, upstreamPort: 0 })).code, 'invalid_upstream_port');
  for (const address of ['8.8.8.8', '224.0.0.1', '255.255.255.255', '10.0.0.255', '0.0.0.0', '::1', '169.254.1.1']) {
    const c = setup({ resolve: async () => [address] });
    assert.equal((await c.relay.start(OPTIONS)).code, 'upstream_not_allowed', address);
    assert.equal(c.sockets.length, 0, 'no socket for a refused target');
  }
  const mixed = setup({ resolve: async () => ['10.0.0.20', '8.8.8.8'] });
  assert.equal((await mixed.relay.start(OPTIONS)).code, 'upstream_not_allowed', 'every answer must be allowed');
  const none = setup({ resolve: async () => { throw new Error('dns'); } });
  assert.equal((await none.relay.start(OPTIONS)).code, 'upstream_unresolved');
});

test('forwarding to the relay itself is refused', async () => {
  const ctx = setup({ resolve: async () => ['127.0.0.1'] });
  ctx.listener = () => ctx.sockets[0];
  const result = await ctx.relay.start({ ...OPTIONS, upstreamPort: 6000 });
  assert.equal(result.code, 'loop');
  assert.equal(ctx.sockets[0].closed, true);
  assert.equal(ctx.relay.getState().lifecycle, 'idle');
});

test('listening on all interfaces needs the confirmation hook and its answer', async () => {
  const all = { ...OPTIONS, listenHost: '0.0.0.0' };
  const ctx = setup();
  assert.equal((await ctx.relay.start(all)).code, 'confirmation_required');
  const seen = [];
  assert.equal((await ctx.relay.start(all, { beforeListen: async (info) => { seen.push(info); return false; } })).code, 'cancelled');
  assert.deepEqual(seen[0], { upstreamAddress: '10.0.0.20', upstreamPort: 7000 });
  assert.equal(ctx.sockets.length, 0);
  assert.equal((await ctx.relay.start(all, { beforeListen: async () => true })).ok, true);
});

test('a bind failure is reported and the socket is released', async () => {
  const ctx = setup({ bindError: 'EADDRINUSE' });
  const result = await ctx.relay.start(OPTIONS);
  assert.deepEqual(result, { ok: false, code: 'listen_failed', errno: 'EADDRINUSE' });
  assert.equal(ctx.sockets[0].closed, true);
  assert.equal(ctx.relay.getState().lifecycle, 'idle');
});

test('a datagram is forwarded unchanged with its boundary; the reply goes back to that client', async () => {
  const ctx = setup();
  await started(ctx);
  await fromClient(ctx, 'ID?\r');
  const s = ctx.session();
  assert.deepEqual(s.connectArgs, { port: 7000, address: '10.0.0.20' });
  assert.deepEqual(s.sent.map((x) => textOf(x.bytes)), ['ID?\r']);
  s.emit('message', enc('UNIT\r'), { address: '10.0.0.20', port: 7000, family: 'IPv4' });
  await flush();
  const back = ctx.listener().sent;
  assert.deepEqual(back.map((x) => [textOf(x.bytes), x.target]), [['UNIT\r', { port: A.port, address: A.address }]]);
  assert.deepEqual(recorded(ctx), ['1up:ID?\r', '1down:UNIT\r']);
  assert.deepEqual(ofType(ctx, 'data').map((e) => e.dir), ['up', 'down']);
});

test('several datagrams stay separate in both directions (no merging, no splitting)', async () => {
  const ctx = setup();
  await started(ctx);
  await fromClient(ctx, 'A\rB\r');
  await fromClient(ctx, 'C');
  const s = ctx.session();
  s.emit('message', enc('1'), { address: '10.0.0.20', port: 7000, family: 'IPv4' });
  s.emit('message', enc('2'), { address: '10.0.0.20', port: 7000, family: 'IPv4' });
  await flush();
  assert.deepEqual(s.sent.map((x) => textOf(x.bytes)), ['A\rB\r', 'C']);
  assert.deepEqual(ctx.listener().sent.map((x) => textOf(x.bytes)), ['1', '2']);
  assert.deepEqual(recorded(ctx), ['1up:A\rB\r', '1up:C', '1down:1', '1down:2']);
});

test('datagrams that arrive before the device-side socket is connected are held in order', async () => {
  const ctx = setup();
  await started(ctx);
  ctx.listener().emit('message', enc('first'), A);
  ctx.listener().emit('message', enc('second'), A);
  assert.equal(ctx.session().sent.length, 0, 'not sent before connect');
  await flush();
  assert.deepEqual(ctx.session().sent.map((x) => textOf(x.bytes)), ['first', 'second']);
});

test('two clients get separate sessions and replies are routed to the right one', async () => {
  const ctx = setup();
  await started(ctx);
  await fromClient(ctx, 'a', A);
  await fromClient(ctx, 'b', B);
  assert.equal(ctx.relay.getState().connections.length, 2);
  ctx.session(2).emit('message', enc('for-b'), { address: '10.0.0.20', port: 7000, family: 'IPv4' });
  ctx.session(1).emit('message', enc('for-a'), { address: '10.0.0.20', port: 7000, family: 'IPv4' });
  await flush();
  const byTarget = Object.fromEntries(ctx.listener().sent.map((x) => [`${x.target.address}:${x.target.port}`, textOf(x.bytes)]));
  assert.deepEqual(byTarget, { '10.0.0.8:50002': 'for-b', '10.0.0.7:50001': 'for-a' });
  assert.deepEqual(recorded(ctx).sort(), ['1down:for-a', '1up:a', '2down:for-b', '2up:b']);
});

test('an empty datagram is forwarded but never recorded or shown', async () => {
  const ctx = setup();
  await started(ctx);
  ctx.listener().emit('message', Buffer.alloc(0), A);
  await flush();
  assert.equal(ctx.session().sent.length, 1);
  assert.equal(ctx.session().sent[0].bytes.length, 0);
  assert.deepEqual(recorded(ctx), []);
  assert.equal(ofType(ctx, 'data').length, 0);
  ctx.session().emit('message', Buffer.alloc(0), { address: '10.0.0.20', port: 7000, family: 'IPv4' });
  await flush();
  assert.equal(ctx.listener().sent.length, 1);
  assert.deepEqual(recorded(ctx), []);
});

test('the recording does not contain the client address and is marked udp', async () => {
  const ctx = setup();
  await started(ctx);
  await fromClient(ctx, 'x');
  const snapshot = JSON.stringify({ ...ctx.recorder.snapshot(), events: [] });
  assert.ok(!snapshot.includes('10.0.0.7') && !snapshot.includes('50001'));
  assert.equal(ctx.recorder.snapshot().transport, 'udp');
});

test('a session expires 60 s after the CLIENT last sent; device traffic does not extend it', async () => {
  const ctx = setup();
  await started(ctx);
  await fromClient(ctx, 'x');
  ctx.clock.advance(50000);
  ctx.session().emit('message', enc('r'), { address: '10.0.0.20', port: 7000, family: 'IPv4' });
  ctx.clock.advance(9999);
  assert.equal(ctx.relay.getState().connections.length, 1);
  ctx.clock.advance(1);
  assert.equal(ctx.relay.getState().connections.length, 0);
  assert.equal(ctx.session().closed, true, 'the device-side socket is closed');
  const snapshot = ctx.recorder.snapshot();
  assert.equal(snapshot.connections[0].closeReason, 'idle');
  assert.equal(ofType(ctx, 'connection_closed')[0].reason, 'idle');
});

test('client traffic extends the idle deadline but not the one-hour absolute lifetime', async () => {
  const ctx = setup();
  await started(ctx);
  for (let i = 0; i < 62; i += 1) {
    await fromClient(ctx, 'x');
    ctx.clock.advance(59000);
  }
  assert.equal(ctx.relay.getState().connections.length, 0, 'one hour passed');
  assert.equal(ctx.recorder.snapshot().connections[0].closeReason, 'limit');
});

test('a late datagram of a removed session is dropped, never given to a newer session of the same client', async () => {
  const ctx = setup();
  await started(ctx);
  await fromClient(ctx, 'x');
  const old = ctx.session(1);
  ctx.clock.advance(60000);
  await fromClient(ctx, 'y');
  assert.equal(ctx.relay.getState().connections.length, 1);
  old.emit('message', enc('stale'), { address: '10.0.0.20', port: 7000, family: 'IPv4' });
  await flush();
  assert.deepEqual(ctx.listener().sent.map((x) => textOf(x.bytes)), []);
});

test('session count and creation rate are limited before any socket is created', async () => {
  const ctx = setup({ limits: { maxSessions: 2, newSessionsPerSecond: 3 } });
  await started(ctx);
  for (let i = 0; i < 6; i += 1) ctx.listener().emit('message', enc('x'), { address: '10.0.0.30', port: 5000 + i, family: 'IPv4' });
  await flush();
  assert.equal(ctx.relay.getState().connections.length, 2);
  assert.equal(ctx.sockets.length, 3, 'listener + 2 sessions only');
  assert.equal(ofType(ctx, 'refused')[0].reason, 'limit');
  ctx.clock.advance(1000);
  ctx.relay.getState();
  const c2 = setup({ limits: { maxSessions: 8, newSessionsPerSecond: 2 } });
  await started(c2);
  for (let i = 0; i < 5; i += 1) c2.listener().emit('message', enc('x'), { address: '10.0.0.30', port: 5000 + i, family: 'IPv4' });
  assert.equal(c2.sockets.length, 3);
  assert.equal(ofType(c2, 'refused')[0].reason, 'rate_limit');
});

test('receive limit comes first: nothing is created or recorded beyond it', async () => {
  const ctx = setup({ limits: { recvPerSecond: 2 } });
  await started(ctx);
  for (let i = 0; i < 5; i += 1) ctx.listener().emit('message', enc('x'), { address: '10.0.0.30', port: 5000 + i, family: 'IPv4' });
  await flush();
  assert.equal(ctx.relay.getState().connections.length, 2);
  assert.equal(recorded(ctx).length, 2);
});

test('a non-IPv4 source is ignored', async () => {
  const ctx = setup();
  await started(ctx);
  ctx.listener().emit('message', enc('x'), { address: '::1', port: 1, family: 'IPv6' });
  assert.equal(ctx.sockets.length, 1);
});

test('reply budget on the whole network: a reply beyond it is dropped and not recorded', async () => {
  const ctx = setup({ limits: { lanReplyBytesPerSecondPerSession: 100 } });
  await started(ctx, { ...OPTIONS, listenHost: '0.0.0.0' }, { beforeListen: async () => true });
  await fromClient(ctx, 'x');
  const from = { address: '10.0.0.20', port: 7000, family: 'IPv4' };
  ctx.session().emit('message', Buffer.alloc(60, 0x41), from);
  ctx.session().emit('message', Buffer.alloc(60, 0x42), from);
  await flush();
  assert.equal(ctx.listener().sent.length, 1);
  assert.equal(recorded(ctx).filter((r) => r.includes('down')).length, 1);
  assert.equal(ofType(ctx, 'refused').some((e) => e.reason === 'reply_rate_limit'), true);
  ctx.clock.advance(1000);
  ctx.session().emit('message', Buffer.alloc(60, 0x43), from);
  await flush();
  assert.equal(ctx.listener().sent.length, 2, 'refills with time');
});

test('a send error is reported but keeps the session', async () => {
  const ctx = setup();
  await started(ctx);
  await fromClient(ctx, 'x');
  ctx.session().sendError = Object.assign(new Error('x'), { code: 'ENETUNREACH' });
  await fromClient(ctx, 'y');
  assert.equal(ofType(ctx, 'send_error')[0].errno, 'ENETUNREACH');
  assert.equal(ctx.relay.getState().connections.length, 1);
});

test('an error of a session socket ends only that session', async () => {
  const ctx = setup();
  await started(ctx);
  await fromClient(ctx, 'a', A);
  await fromClient(ctx, 'b', B);
  ctx.session(1).emit('error', Object.assign(new Error('x'), { code: 'EIO' }));
  assert.equal(ctx.relay.getState().connections.length, 1);
  assert.equal(ctx.recorder.snapshot().connections[0].closeReason, 'error');
});

test('an error of the listening socket stops the relay and is reported', async () => {
  const ctx = setup();
  await started(ctx);
  await fromClient(ctx, 'a');
  ctx.listener().emit('error', Object.assign(new Error('x'), { code: 'EIO' }));
  await flush();
  assert.equal(ofType(ctx, 'server_error')[0].errno, 'EIO');
  assert.equal(ctx.relay.getState().lifecycle, 'idle');
});

test('stop closes every session (reason stop), clears timers and waits for the close', async () => {
  const ctx = setup();
  await started(ctx);
  await fromClient(ctx, 'a', A);
  await fromClient(ctx, 'b', B);
  const stopping = ctx.relay.stop();
  assert.equal((await ctx.relay.start(OPTIONS)).code, 'busy');
  assert.deepEqual(await stopping, { ok: true });
  assert.equal(ctx.clock.pendingTimers(), 0);
  assert.ok(ctx.sockets.every((s) => s.closed));
  assert.deepEqual(ctx.recorder.snapshot().connections.map((c) => c.closeReason), ['stop', 'stop']);
  assert.equal(ofType(ctx, 'stopped').length, 1);
});

test('stop during a start cancels it; several stops all resolve', async () => {
  const ctx = setup();
  const starting = ctx.relay.start(OPTIONS);
  const first = ctx.relay.stop();
  const second = ctx.relay.stop();
  assert.deepEqual(await starting, { ok: false, code: 'cancelled' });
  assert.deepEqual(await first, { ok: true });
  assert.deepEqual(await second, { ok: true });
  assert.ok(ctx.sockets.every((s) => s.closed));
});

test('clearing the recording while a session lives does not touch the new recording', async () => {
  const ctx = setup();
  await started(ctx);
  await fromClient(ctx, 'old');
  ctx.recorder.clear();
  await fromClient(ctx, 'newer');
  assert.deepEqual(recorded(ctx), []);
  ctx.clock.advance(60000);
  assert.equal(ctx.recorder.snapshot().connections.length, 0);
});

test('a throwing listener does not break the relay', async () => {
  const clock = createFakeClock();
  const sockets = [];
  const reported = [];
  const relay = createUdpRelay({
    createSocket: () => { const s = new FakeUdp(); sockets.push(s); return s; },
    resolveHost: async () => ['10.0.0.20'],
    getInterfaces: () => IFACES,
    localAddresses: () => [],
    recorder: createRecorder({ now: clock.now, transport: 'udp' }),
    scheduler: clock.scheduler,
    now: clock.now,
    onEvent: () => { throw new Error('listener'); },
    onListenerError: (e) => reported.push(e),
  });
  assert.equal((await relay.start(OPTIONS)).ok, true);
  sockets[0].emit('message', enc('x'), A);
  await flush();
  assert.equal(sockets[1].sent.length, 1);
  assert.ok(reported.length > 0);
});

test('on the whole network the reply burst is capped at one second of the global budget', async () => {
  // 32 KiB/s globally: eight sessions asking for 8000-byte replies at once get four through at most.
  const ctx = setup({ limits: { maxSessions: 8, newSessionsPerSecond: 20, lanRecvPerSecond: 100 } });
  await started(ctx, { ...OPTIONS, listenHost: '0.0.0.0' }, { beforeListen: async () => true });
  const from = { address: '10.0.0.20', port: 7000, family: 'IPv4' };
  for (let i = 0; i < 8; i += 1) ctx.listener().emit('message', enc('x'), { address: '10.0.0.30', port: 5000 + i, family: 'IPv4' });
  await flush();
  for (let i = 1; i <= 8; i += 1) ctx.session(i).emit('message', Buffer.alloc(7000, 0x41), from);
  await flush();
  const sentBytes = ctx.listener().sent.reduce((n, x) => n + x.bytes.length, 0);
  assert.ok(sentBytes <= 32 * 1024, `sent ${sentBytes}`);
  assert.ok(ctx.listener().sent.length >= 1);
});

test('a session socket that is slow to close still counts against the limit and delays stop', async () => {
  const ctx = setup({ limits: { maxSessions: 1 } });
  await started(ctx);
  await fromClient(ctx, 'a', A);
  const s = ctx.session(1);
  let release;
  s.close = () => { s.closed = true; release = () => s.emit('close'); };
  ctx.clock.advance(60000); // the session expires; its socket has not reported 'close' yet
  assert.equal(ctx.relay.getState().connections.length, 0);
  await fromClient(ctx, 'b', B);
  assert.equal(ctx.sockets.length, 2, 'no new socket while the old one is still closing');
  assert.equal(ofType(ctx, 'refused').at(-1).reason, 'limit');
  let stopped = false;
  const stopping = ctx.relay.stop().then((r) => { stopped = true; return r; });
  await flush();
  assert.equal(stopped, false, 'stop waits for the session socket');
  release();
  assert.deepEqual(await stopping, { ok: true });
});

test('a session that only sent empty datagrams leaves no recording trace', async () => {
  const ctx = setup();
  await started(ctx);
  ctx.listener().emit('message', Buffer.alloc(0), A);
  await flush();
  assert.equal(ctx.recorder.snapshot().connections.length, 0);
  assert.equal(ctx.recorder.setTransport('tcp'), true, 'the recording is still switchable');
  ctx.recorder.setTransport('udp');
  await fromClient(ctx, 'x');
  assert.equal(ctx.recorder.snapshot().connections.length, 1, 'created with the first non-empty datagram');
});
