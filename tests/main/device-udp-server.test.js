// Tests for the UDP device server with a fake socket and a manual clock.
// Expected behavior comes from the Phase 4 plan (5.3, 12.4) and core_spec.md, not from the code.
const test = require('node:test');
const assert = require('node:assert/strict');

const { createDeviceUdpServer } = require('../../src/main/device-udp-server');
const { validateDefinition } = require('../../src/core/device-definition');
const { createFakeClock, flush } = require('../helpers/fakes');
const { FakeUdp } = require('../helpers/fake-udp');

const CR = 0x0d;
const bytesOf = (text) => Uint8Array.from(Buffer.from(text, 'utf8'));
const textOf = (bytes) => Buffer.from(bytes).toString('utf8').split(String.fromCharCode(13)).join('<CR>');
const A = { address: '10.0.0.7', port: 50001, family: 'IPv4' };
const B = { address: '10.0.0.8', port: 50002, family: 'IPv4' };

function sampleDefinition(connection = {}, extra = {}) {
  const input = {
    schemaVersion: 1,
    transport: 'udp',
    name: 'Sample udp device',
    framing: { terminator: 'cr' },
    connection,
    variables: {
      power: { type: 'enum', values: ['standby', 'on'], initial: 'standby' },
    },
    commands: [
      { pattern: 'PWR ?', reply: 'PWR={var.power}[CR]' },
      { pattern: 'PWR {state}', capture: { state: { map: { 0: 'standby', 1: 'on' } } }, do: { set: { power: '{capture.state}' } }, reply: null, invalid: { reply: 'ERR 1[CR]' } },
      { pattern: 'SLOW ?', delayMs: 500, reply: 'SLOW[CR]' },
      { pattern: 'FAST ?', reply: 'FAST[CR]' },
      { pattern: 'BIG ?', reply: ['BIG', 'x'.repeat(1000), 'x'.repeat(1000), 'x'.repeat(1000), '[CR]'] },
    ],
    notifications: [{ when: { var: 'power', changes: true }, send: 'EVT POWER={var.power}[CR]' }],
    unknown: { reply: 'ERR 2[CR]' },
    ...extra,
  };
  const result = validateDefinition(input);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  return result.definition;
}

function setup({ connection = {}, limits = {}, socketOptions = {} } = {}) {
  const clock = createFakeClock();
  const events = [];
  const sockets = [];
  const server = createDeviceUdpServer({
    createSocket: () => { const s = new FakeUdp(socketOptions); sockets.push(s); return s; },
    scheduler: clock.scheduler,
    now: clock.now,
    onEvent: (e) => events.push(e),
    limits,
  });
  return { server, clock, events, sockets, definition: sampleDefinition(connection), socket: () => sockets.at(-1) };
}

async function started(ctx, host = '127.0.0.1', port = 0) {
  const result = await ctx.server.start({ definition: ctx.definition, host, port });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}

const send = (ctx, text, from = A, terminated = true) => {
  const body = bytesOf(text);
  ctx.socket().emit('message', Buffer.from(terminated ? [...body, CR] : body), from);
};
const sentTexts = (ctx) => ctx.socket().sent.map((s) => textOf(s.bytes));
const ofType = (ctx, type) => ctx.events.filter((e) => e.type === type);

test('start binds the requested address and reports the real port', async () => {
  const ctx = setup();
  const result = await started(ctx, '127.0.0.1', 0);
  assert.deepEqual(ctx.socket().bindArgs, { address: '127.0.0.1', port: 0 });
  assert.equal(result.port, 41000);
  assert.equal(ctx.server.getState().transport, 'udp');
  assert.equal(ofType(ctx, 'listening').length, 1);
});

test('start validates host and port and refuses a second start', async () => {
  const ctx = setup();
  assert.equal((await ctx.server.start({ definition: ctx.definition, host: '192.0.2.1', port: 0 })).code, 'invalid_host');
  assert.equal((await ctx.server.start({ definition: ctx.definition, host: '127.0.0.1', port: 80 })).code, 'invalid_port');
  assert.equal((await ctx.server.start({ definition: {}, host: '127.0.0.1', port: 0 })).code, 'invalid_definition');
  await started(ctx);
  assert.equal((await ctx.server.start({ definition: ctx.definition, host: '127.0.0.1', port: 0 })).code, 'already_running');
});

test('a bind failure is reported as an event result and the server returns to idle', async () => {
  const ctx = setup({ socketOptions: { bindError: 'EADDRINUSE' } });
  const result = await ctx.server.start({ definition: ctx.definition, host: '127.0.0.1', port: 5000 });
  assert.deepEqual(result, { ok: false, code: 'listen_failed', errno: 'EADDRINUSE' });
  assert.equal(ctx.server.getState().lifecycle, 'idle');
  assert.equal(ctx.socket().closed, true);
});

test('a datagram is one message: reply goes back to the sender from the bound socket', async () => {
  const ctx = setup();
  await started(ctx);
  send(ctx, 'PWR ?');
  await flush();
  assert.deepEqual(sentTexts(ctx), ['PWR=standby<CR>']);
  assert.deepEqual(ctx.socket().sent[0].target, { port: A.port, address: A.address });
  const rx = ofType(ctx, 'rx');
  assert.equal(textOf(rx[0].bytes), 'PWR ?');
  assert.equal(ofType(ctx, 'tx').length, 1);
});

test('a request without a terminator is accepted too (one trailing terminator is optional)', async () => {
  const ctx = setup();
  await started(ctx);
  send(ctx, 'PWR ?', A, false);
  await flush();
  assert.deepEqual(sentTexts(ctx), ['PWR=standby<CR>']);
});

test('only one trailing terminator is stripped and several lines are not split', async () => {
  const ctx = setup();
  await started(ctx);
  ctx.socket().emit('message', Buffer.from('PWR ?\rPWR ?\r'), A);
  await flush();
  // The message is "PWR ?<CR>PWR ?", which matches no command: the unknown reply answers once.
  assert.deepEqual(sentTexts(ctx), ['ERR 2<CR>']);
});

test('an empty datagram is ignored and creates no peer', async () => {
  const ctx = setup();
  await started(ctx);
  ctx.socket().emit('message', Buffer.alloc(0), A);
  await flush();
  assert.equal(ctx.socket().sent.length, 0);
  assert.equal(ctx.server.getState().connections.length, 0);
  assert.equal(ofType(ctx, 'ignored')[0].reason, 'empty');
});

test('a non-IPv4 source is ignored', async () => {
  const ctx = setup();
  await started(ctx);
  ctx.socket().emit('message', Buffer.from('PWR ?\r'), { address: '::1', port: 1, family: 'IPv6' });
  await flush();
  assert.equal(ctx.socket().sent.length, 0);
});

test('an oversized datagram is answered by the unknown handler and does not extend the peer', async () => {
  const ctx = setup({ connection: { idleTimeoutMs: 1000 } });
  await started(ctx);
  send(ctx, 'FAST ?');
  ctx.clock.advance(600);
  ctx.socket().emit('message', Buffer.alloc(5000, 0x41), A);
  await flush();
  assert.equal(ofType(ctx, 'rx').at(-1).overflow, true);
  assert.equal(sentTexts(ctx).at(-1), 'ERR 2<CR>');
  ctx.clock.advance(400);
  assert.equal(ctx.server.getState().connections.length, 0);
});

test('state is shared between peers and notifications reach every current peer', async () => {
  const ctx = setup({ connection: { maxConnections: 4 } });
  await started(ctx);
  send(ctx, 'PWR ?', A);
  send(ctx, 'PWR ?', B);
  await flush();
  ctx.socket().sent.length = 0;
  send(ctx, 'PWR 1', A);
  await flush();
  const targets = ctx.socket().sent.map((s) => `${s.target.address}:${s.target.port}=${textOf(s.bytes)}`).sort();
  assert.deepEqual(targets, ['10.0.0.7:50001=EVT POWER=on<CR>', '10.0.0.8:50002=EVT POWER=on<CR>']);
  ctx.socket().sent.length = 0;
  send(ctx, 'PWR ?', B);
  await flush();
  assert.deepEqual(sentTexts(ctx), ['PWR=on<CR>']);
});

test('a peer beyond maxConnections is ignored whatever overLimit says, and no peer is created', async () => {
  for (const overLimit of ['refuse', 'accept_then_close']) {
    const ctx = setup({ connection: { maxConnections: 1, overLimit } });
    await started(ctx);
    send(ctx, 'FAST ?', A);
    send(ctx, 'FAST ?', B);
    await flush();
    assert.equal(ctx.socket().sent.length, 1);
    assert.equal(ctx.server.getState().connections.length, 1);
    const refused = ofType(ctx, 'refused');
    assert.equal(refused[0].reason, 'limit');
    assert.equal(refused[0].behavior, overLimit);
  }
});

test('a refusal notice is reported at most once per interval', async () => {
  const ctx = setup({ connection: { maxConnections: 1 } });
  await started(ctx);
  send(ctx, 'FAST ?', A);
  for (let i = 0; i < 10; i += 1) send(ctx, 'FAST ?', { address: '10.0.0.9', port: 6000 + i, family: 'IPv4' });
  assert.equal(ofType(ctx, 'refused').length, 1);
  ctx.clock.advance(1000);
  send(ctx, 'FAST ?', { address: '10.0.0.9', port: 7000, family: 'IPv4' });
  assert.equal(ofType(ctx, 'refused').length, 2);
});

test('startup quiet period: no peer, no reply; afterwards it answers', async () => {
  const ctx = setup({ connection: { startupQuietMs: 2000 } });
  await started(ctx);
  send(ctx, 'FAST ?');
  await flush();
  assert.equal(ctx.socket().sent.length, 0);
  assert.equal(ctx.server.getState().connections.length, 0);
  assert.equal(ofType(ctx, 'refused')[0].reason, 'startup');
  ctx.clock.advance(2000);
  send(ctx, 'FAST ?');
  await flush();
  assert.deepEqual(sentTexts(ctx), ['FAST<CR>']);
});

test('delayed reply holds the peer queue so later replies never overtake it', async () => {
  const ctx = setup();
  await started(ctx);
  send(ctx, 'SLOW ?');
  send(ctx, 'FAST ?');
  await flush();
  assert.equal(ctx.socket().sent.length, 0);
  ctx.clock.advance(500);
  await flush();
  assert.deepEqual(sentTexts(ctx), ['SLOW<CR>', 'FAST<CR>']);
});

test('a delayed reply of one peer does not hold another peer', async () => {
  const ctx = setup({ connection: { maxConnections: 2 } });
  await started(ctx);
  send(ctx, 'SLOW ?', A);
  send(ctx, 'FAST ?', B);
  await flush();
  assert.deepEqual(sentTexts(ctx), ['FAST<CR>']);
  ctx.clock.advance(500);
  await flush();
  assert.deepEqual(sentTexts(ctx), ['FAST<CR>', 'SLOW<CR>']);
});

test('minimum command interval is per peer and ignored datagrams get no reply', async () => {
  const ctx = setup({ connection: { maxConnections: 2, minCommandIntervalMs: 100 } });
  await started(ctx);
  send(ctx, 'FAST ?', A);
  ctx.clock.advance(10);
  send(ctx, 'FAST ?', A);
  send(ctx, 'FAST ?', B);
  await flush();
  assert.equal(ctx.socket().sent.length, 2);
  assert.equal(ofType(ctx, 'ignored')[0].reason, 'interval');
  ctx.clock.advance(200);
  send(ctx, 'FAST ?', A);
  await flush();
  assert.equal(ctx.socket().sent.length, 3);
});

test('a peer expires after idleTimeoutMs for both idle behaviors and is simply created again', async () => {
  for (const idleBehavior of ['close', 'stop_responding']) {
    const ctx = setup({ connection: { idleTimeoutMs: 1000, idleBehavior } });
    await started(ctx);
    send(ctx, 'FAST ?');
    await flush();
    ctx.clock.advance(999);
    assert.equal(ctx.server.getState().connections.length, 1);
    ctx.clock.advance(1);
    assert.equal(ctx.server.getState().connections.length, 0);
    assert.equal(ofType(ctx, 'idle')[0].behavior, idleBehavior);
    assert.equal(ofType(ctx, 'connection_closed').at(-1).reason, 'idle');
    send(ctx, 'FAST ?');
    await flush();
    assert.equal(ctx.socket().sent.length, 2, 'the peer is answered again');
  }
});

test('a peer has a finite lifetime of 300 s even when idleTimeoutMs is 0', async () => {
  const ctx = setup();
  await started(ctx);
  send(ctx, 'FAST ?');
  ctx.clock.advance(299999);
  assert.equal(ctx.server.getState().connections.length, 1);
  ctx.clock.advance(1);
  assert.equal(ctx.server.getState().connections.length, 0);
  assert.equal(ofType(ctx, 'connection_closed').at(-1).reason, 'expired');
});

test('fault: dropNextReplies, extraDelayMs and muted', async () => {
  const ctx = setup();
  await started(ctx);
  assert.equal(ctx.server.setFault({ dropNextReplies: 1 }).ok, true);
  send(ctx, 'FAST ?');
  await flush();
  assert.equal(ctx.socket().sent.length, 0);
  assert.equal(ofType(ctx, 'dropped').length, 1);
  ctx.server.setFault({ extraDelayMs: 300 });
  send(ctx, 'FAST ?');
  await flush();
  assert.equal(ctx.socket().sent.length, 0);
  ctx.clock.advance(300);
  await flush();
  assert.equal(ctx.socket().sent.length, 1);
  ctx.server.setFault({ muted: true });
  send(ctx, 'FAST ?');
  await flush();
  assert.equal(ctx.socket().sent.length, 1);
  assert.equal(ofType(ctx, 'muted').length, 1);
});

test('muting is checked again at send time for a reply that was already queued', async () => {
  const ctx = setup();
  await started(ctx);
  send(ctx, 'SLOW ?');
  await flush();
  ctx.server.setFault({ muted: true });
  ctx.clock.advance(500);
  await flush();
  assert.equal(ctx.socket().sent.length, 0);
  assert.equal(ofType(ctx, 'muted').length, 1);
});

test('setFault validates its arguments', async () => {
  const ctx = setup();
  assert.equal(ctx.server.setFault({ muted: true }).code, 'not_running');
  await started(ctx);
  for (const bad of [null, {}, { muted: 'yes' }, { dropNextReplies: -1 }, { extraDelayMs: 60001 }, { dropNextReplies: 1.5 }]) {
    assert.equal(ctx.server.setFault(bad).ok, false);
  }
});

test('closeAllConnections forgets every peer and cancels their pending replies', async () => {
  const ctx = setup({ connection: { maxConnections: 2 } });
  await started(ctx);
  send(ctx, 'SLOW ?', A);
  send(ctx, 'FAST ?', B);
  await flush();
  assert.deepEqual(ctx.server.closeAllConnections(), { ok: true, closed: 2 });
  assert.equal(ctx.server.getState().connections.length, 0);
  ctx.clock.advance(1000);
  await flush();
  assert.deepEqual(sentTexts(ctx), ['FAST<CR>']);
  assert.equal(ctx.clock.pendingTimers(), 0);
});

test('reply budget: replies beyond the byte budget are discarded and reported', async () => {
  // Per peer 8 KiB/s on the whole network: two 3000-byte replies fit, the third does not.
  const ctx = setup();
  await started(ctx, '0.0.0.0', 0);
  for (let i = 0; i < 3; i += 1) send(ctx, 'BIG ?');
  await flush();
  assert.equal(ctx.socket().sent.length, 2);
  assert.equal(ofType(ctx, 'refused').find((e) => e.reason === 'reply_rate_limit') !== undefined, true);
  ctx.clock.advance(1000);
  send(ctx, 'BIG ?');
  await flush();
  assert.equal(ctx.socket().sent.length, 3, 'the budget refills with time');
});

test('reply budget: the whole-device limit applies across peers', async () => {
  // 32 KiB/s for the device: eleven 3000-byte replies from different peers fit, the twelfth does not.
  const ctx = setup({ connection: { maxConnections: 32 } });
  await started(ctx, '0.0.0.0', 0);
  for (let i = 0; i < 12; i += 1) send(ctx, 'BIG ?', { address: '10.0.0.20', port: 4000 + i, family: 'IPv4' });
  await flush();
  assert.equal(ctx.socket().sent.length, 10);
});

test('receive limit comes first: over-limit datagrams create no peer and run no engine', async () => {
  const ctx = setup({ connection: { maxConnections: 32 }, limits: { lanRecvPerSecond: 3 } });
  await started(ctx, '0.0.0.0', 0);
  for (let i = 0; i < 10; i += 1) send(ctx, 'FAST ?', { address: '10.0.0.30', port: 5000 + i, family: 'IPv4' });
  assert.equal(ctx.server.getState().connections.length, 3);
  assert.equal(ofType(ctx, 'rx').length, 3);
  assert.equal(ofType(ctx, 'refused').filter((e) => e.reason === 'rate_limit').length, 1);
});

test('receive limit is a sliding window: a burst split at a boundary cannot pass twice', async () => {
  const ctx = setup({ connection: { maxConnections: 32 }, limits: { recvPerSecond: 3 } });
  await started(ctx);
  ctx.clock.advance(900);
  for (let i = 0; i < 3; i += 1) send(ctx, 'FAST ?', { address: '10.0.0.30', port: 5000 + i, family: 'IPv4' });
  ctx.clock.advance(200);
  for (let i = 0; i < 3; i += 1) send(ctx, 'FAST ?', { address: '10.0.0.31', port: 5000 + i, family: 'IPv4' });
  assert.equal(ofType(ctx, 'rx').length, 3);
});

test('a failed send is reported but does not close the peer or the socket', async () => {
  const ctx = setup();
  await started(ctx);
  ctx.socket().sendError = Object.assign(new Error('x'), { code: 'ENETUNREACH' });
  send(ctx, 'FAST ?');
  await flush();
  assert.equal(ofType(ctx, 'send_error')[0].errno, 'ENETUNREACH');
  assert.equal(ofType(ctx, 'tx').length, 0);
  assert.equal(ctx.server.getState().connections.length, 1);
  assert.equal(ctx.socket().closed, false);
  ctx.socket().sendError = null;
  send(ctx, 'FAST ?');
  await flush();
  assert.equal(ofType(ctx, 'tx').length, 1);
});

test('a synchronous throw from send is handled like a failed send', async () => {
  const ctx = setup();
  await started(ctx);
  ctx.socket().throwOnSend = Object.assign(new Error('x'), { code: 'ERR_SOCKET_BAD_PORT' });
  send(ctx, 'FAST ?');
  await flush();
  assert.equal(ofType(ctx, 'send_error')[0].errno, 'ERR_SOCKET_BAD_PORT');
  ctx.socket().throwOnSend = null;
  send(ctx, 'FAST ?');
  await flush();
  assert.equal(ofType(ctx, 'tx').length, 1, 'the queue is not stuck');
});

test('a late send callback after the peer was forgotten does nothing', async () => {
  const ctx = setup();
  await started(ctx);
  ctx.socket().heldSends = [];
  send(ctx, 'FAST ?');
  await flush();
  ctx.server.closeAllConnections();
  ctx.socket().heldSends[0](null);
  await flush();
  assert.equal(ofType(ctx, 'tx').length, 0);
});

test('a socket error while running stops the server and reports it', async () => {
  const ctx = setup();
  await started(ctx);
  ctx.socket().emit('error', Object.assign(new Error('x'), { code: 'EIO' }));
  await flush();
  assert.equal(ofType(ctx, 'server_error')[0].errno, 'EIO');
  assert.equal(ctx.server.getState().lifecycle, 'idle');
  assert.equal(ofType(ctx, 'stopped').length, 1);
});

test('stop closes the socket, forgets peers, clears timers and waits for the close event', async () => {
  const ctx = setup({ connection: { idleTimeoutMs: 1000 } });
  await started(ctx);
  send(ctx, 'SLOW ?');
  const stopping = ctx.server.stop();
  assert.equal(ctx.server.getState().lifecycle, 'stopping');
  assert.equal((await ctx.server.start({ definition: ctx.definition, host: '127.0.0.1', port: 0 })).code, 'busy');
  assert.deepEqual(await stopping, { ok: true });
  assert.equal(ctx.server.getState().lifecycle, 'idle');
  assert.equal(ctx.clock.pendingTimers(), 0);
  assert.equal(ctx.socket().closed, true);
  assert.equal(ofType(ctx, 'stopped').length, 1);
});

test('datagrams after stop are ignored and a restart works', async () => {
  const ctx = setup();
  await started(ctx);
  const first = ctx.socket();
  await ctx.server.stop();
  first.emit('message', Buffer.from('FAST ?\r'), A);
  assert.equal(first.sent.length, 0);
  const again = await started(ctx);
  assert.equal(again.generation, 2);
  assert.notEqual(ctx.socket(), first);
});

test('a stop during start cancels the start and releases the socket', async () => {
  const ctx = setup();
  const starting = ctx.server.start({ definition: ctx.definition, host: '127.0.0.1', port: 0 });
  const stopping = ctx.server.stop();
  assert.deepEqual(await starting, { ok: false, code: 'cancelled' });
  assert.deepEqual(await stopping, { ok: true });
  assert.equal(ctx.socket().closed, true);
  assert.equal(ctx.server.getState().lifecycle, 'idle');
});

test('an error of an old socket after a restart does not stop the new run', async () => {
  const ctx = setup();
  await started(ctx);
  const old = ctx.socket();
  await ctx.server.stop();
  await started(ctx);
  old.emit('error', Object.assign(new Error('late'), { code: 'EIO' }));
  assert.equal(ctx.server.getState().running, true);
});

test('a throwing event listener does not break the server', async () => {
  const clock = createFakeClock();
  const reported = [];
  const sockets = [];
  const server = createDeviceUdpServer({
    createSocket: () => { const s = new FakeUdp(); sockets.push(s); return s; },
    scheduler: clock.scheduler,
    now: clock.now,
    onEvent: () => { throw new Error('listener'); },
    onListenerError: (e) => reported.push(e),
  });
  assert.equal((await server.start({ definition: sampleDefinition(), host: '127.0.0.1', port: 0 })).ok, true);
  sockets[0].emit('message', Buffer.from('FAST ?\r'), A);
  await flush();
  assert.equal(sockets[0].sent.length, 1);
  assert.ok(reported.length > 0);
});

test('getState lists peers with their remote address and remaining lifetime', async () => {
  const ctx = setup({ connection: { idleTimeoutMs: 5000 } });
  await started(ctx);
  send(ctx, 'FAST ?');
  ctx.clock.advance(1000);
  const [peer] = ctx.server.getState().connections;
  assert.equal(peer.remote, '10.0.0.7:50001');
  assert.equal(peer.idleInMs, 4000);
  assert.equal(peer.silent, false);
});

test('a queue that grows beyond its limit forgets the peer', async () => {
  const ctx = setup({ limits: { maxQueueItems: 3 } });
  await started(ctx);
  for (let i = 0; i < 4; i += 1) send(ctx, 'SLOW ?');
  assert.equal(ctx.server.getState().connections.length, 0);
  assert.equal(ofType(ctx, 'connection_closed').at(-1).reason, 'queue_overflow');
  assert.equal(ctx.clock.pendingTimers(), 0);
});

test('the interval notice is throttled per peer and leaves no table behind', async () => {
  const ctx = setup({ connection: { minCommandIntervalMs: 100, idleTimeoutMs: 1000 } });
  await started(ctx);
  for (let i = 0; i < 20; i += 1) {
    send(ctx, 'FAST ?', { address: '10.0.0.40', port: 9000 + i, family: 'IPv4' });
    send(ctx, 'FAST ?', { address: '10.0.0.40', port: 9000 + i, family: 'IPv4' });
    ctx.clock.advance(1000);
  }
  assert.equal(ofType(ctx, 'ignored').length, 20, 'one notice per peer');
  assert.equal(ctx.server.getState().connections.length, 0);
});

test('several stop() calls during a start all resolve', async () => {
  const ctx = setup();
  const starting = ctx.server.start({ definition: ctx.definition, host: '127.0.0.1', port: 0 });
  const first = ctx.server.stop();
  const second = ctx.server.stop();
  assert.deepEqual(await starting, { ok: false, code: 'cancelled' });
  assert.deepEqual(await first, { ok: true });
  assert.deepEqual(await second, { ok: true });
});

test('stop during a failing bind waits for the socket to close before it resolves', async () => {
  const ctx = setup({ socketOptions: { bindError: 'EADDRINUSE' } });
  const starting = ctx.server.start({ definition: ctx.definition, host: '127.0.0.1', port: 5000 });
  const sock = ctx.socket();
  const realClose = sock.close.bind(sock);
  let releaseClose;
  sock.close = () => { sock.closed = true; releaseClose = () => sock.emit('close'); };
  let stopped = false;
  const stopping = ctx.server.stop().then((r) => { stopped = true; return r; });
  await flush();
  assert.equal(stopped, false, 'not resolved before the close event');
  assert.equal(ctx.server.getState().lifecycle, 'starting');
  releaseClose();
  assert.equal((await starting).code, 'listen_failed');
  assert.deepEqual(await stopping, { ok: true });
  assert.equal(ctx.server.getState().lifecycle, 'idle');
  assert.ok(realClose);
});
