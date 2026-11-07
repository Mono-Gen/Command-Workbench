// Tests for the connection state machine, using a fake socket and a manual clock.
// Expected behavior comes from the plan (sections 5, 7 and 9.5).
const test = require('node:test');
const assert = require('node:assert/strict');

const { createConnection } = require('../../src/main/connection');
const { createFakeClock, FakeSocket, flush } = require('../helpers/fakes');

function setup(options = {}) {
  const clock = createFakeClock();
  const sockets = [];
  const events = [];
  const connection = createConnection({
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    scheduler: clock.scheduler,
    now: clock.now,
    onEvent: (event) => events.push(event),
    ...options,
  });
  const types = () => events.map((e) => e.type === 'state' ? `state:${e.state}` : e.type);
  return { clock, sockets, events, connection, types };
}

const target = { host: '192.0.2.10', port: 1100 };

async function connected(ctx, extra = {}) {
  const result = ctx.connection.connect({ ...target, ...extra });
  assert.equal(result.ok, true);
  ctx.sockets.at(-1).emit('connect');
  await flush();
  return result.id;
}

test('connect: validates the target before creating a socket', () => {
  const ctx = setup();
  for (const bad of [
    { host: '', port: 23 }, { host: 'a b', port: 23 }, { host: 5, port: 23 },
    { host: 'h', port: 0 }, { host: 'h', port: 65536 }, { host: 'h', port: 1.5 }, { host: 'h', port: '23' },
  ]) {
    assert.deepEqual(ctx.connection.connect(bad), { ok: false, code: 'invalid_target' }, JSON.stringify(bad));
  }
  assert.equal(ctx.sockets.length, 0);
  assert.equal(ctx.connection.getState(), 'idle');
});

test('connect: goes connecting -> connected and records connect_ok', async () => {
  const ctx = setup();
  const id = await connected(ctx);
  assert.deepEqual(ctx.sockets[0].connectArgs, { host: target.host, port: target.port });
  assert.equal(ctx.connection.getState(), 'connected');
  assert.deepEqual(ctx.types(), ['state:connecting', 'state:connected', 'connect_ok']);
  assert.ok(ctx.events.every((e) => e.id === id));
  assert.deepEqual(ctx.connection.getHistory().map((e) => e.type), ['connect_ok']);
});

test('connect: a second connect while connecting or connected is refused', async () => {
  const ctx = setup();
  ctx.connection.connect(target);
  assert.deepEqual(ctx.connection.connect(target), { ok: false, code: 'busy' });
  ctx.sockets[0].emit('connect');
  assert.deepEqual(ctx.connection.connect(target), { ok: false, code: 'busy' });
  assert.equal(ctx.sockets.length, 1);
});

test('connect timeout: one deadline covers lookup and connect, then the socket is destroyed', async () => {
  const ctx = setup();
  ctx.connection.connect({ ...target, timeoutMs: 5000 });
  ctx.clock.advance(4999);
  assert.equal(ctx.connection.getState(), 'connecting');
  ctx.clock.advance(1);
  await flush();

  assert.equal(ctx.connection.getState(), 'closed');
  assert.equal(ctx.sockets[0].destroyed, true);
  const fail = ctx.connection.getHistory().find((e) => e.type === 'connect_fail');
  assert.equal(fail.code, 'CONNECT_TIMEOUT');
  assert.equal(ctx.connection.getHistory().filter((e) => e.type === 'terminated').length, 0, 'no terminated event for a failed connect');
});

test('connect timeout: a late "connect" from the timed-out socket is ignored', async () => {
  const ctx = setup();
  ctx.connection.connect({ ...target, timeoutMs: 1000 });
  ctx.clock.advance(1000);
  ctx.sockets[0].emit('connect');
  await flush();
  assert.equal(ctx.connection.getState(), 'closed');
  assert.equal(ctx.connection.getHistory().filter((e) => e.type === 'connect_ok').length, 0);
});

test('connect error: the error code is recorded once as connect_fail', async () => {
  const ctx = setup();
  ctx.connection.connect(target);
  ctx.sockets[0].emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
  ctx.sockets[0].emit('close', true);
  await flush();
  const history = ctx.connection.getHistory();
  assert.deepEqual(history.map((e) => e.type), ['connect_fail']);
  assert.equal(history[0].code, 'ECONNREFUSED');
  assert.equal(ctx.connection.getState(), 'closed');
  assert.equal(ctx.clock.pendingTimers(), 0, 'the deadline timer is cleared');
});

test('connect error without a code is reported as UNKNOWN', async () => {
  const ctx = setup();
  ctx.connection.connect(target);
  ctx.sockets[0].emit('error', new Error('odd'));
  assert.equal(ctx.connection.getHistory()[0].code, 'UNKNOWN');
});

test('a synchronous failure from socket.connect becomes connect_fail', async () => {
  const ctx = setup({
    createSocket: () => {
      const socket = new FakeSocket();
      socket.connect = () => { throw Object.assign(new Error('bad'), { code: 'ERR_SOCKET_BAD_PORT' }); };
      return socket;
    },
  });
  const result = ctx.connection.connect(target);
  assert.equal(result.ok, true);
  assert.equal(ctx.connection.getHistory()[0].code, 'ERR_SOCKET_BAD_PORT');
  assert.equal(ctx.connection.getState(), 'closed');
});

test('can connect again after a failure, and history starts fresh', async () => {
  const ctx = setup();
  ctx.connection.connect(target);
  ctx.sockets[0].emit('error', Object.assign(new Error('x'), { code: 'ECONNREFUSED' }));
  await flush();
  const id2 = await connected(ctx);
  assert.equal(ctx.sockets.length, 2);
  assert.deepEqual(ctx.connection.getHistory().map((e) => e.type), ['connect_ok']);
  assert.equal(ctx.connection.getState(), 'connected');
  assert.ok(id2 > 1);
});

test('events from a superseded socket cannot disturb the new connection', async () => {
  const ctx = setup();
  ctx.connection.connect(target);
  const oldSocket = ctx.sockets[0];
  oldSocket.emit('error', Object.assign(new Error('x'), { code: 'ECONNREFUSED' }));
  await flush();

  await connected(ctx);
  const countBefore = ctx.events.length;
  // Late events from the first socket.
  oldSocket.emit('data', Buffer.from('stale'));
  oldSocket.emit('end');
  oldSocket.emit('close', true);
  oldSocket.emit('connect');
  await flush();

  assert.equal(ctx.connection.getState(), 'connected');
  assert.equal(ctx.events.length, countBefore, 'no event is produced by the stale socket');
});

test('keepalive: applied on connect when requested, and can be changed while connected', async () => {
  const ctx = setup();
  await connected(ctx, { keepAlive: { enabled: true, initialDelayMs: 30000 } });
  assert.deepEqual(ctx.sockets[0].keepAliveCalls, [[true, 30000]]);

  assert.deepEqual(ctx.connection.setKeepAlive(false, 0), { ok: true });
  assert.deepEqual(ctx.sockets[0].keepAliveCalls.at(-1), [false, 0]);
});

test('keepalive: not applied by default, and refused when not connected', async () => {
  const ctx = setup();
  assert.deepEqual(ctx.connection.setKeepAlive(true, 1000), { ok: false, code: 'not_connected' });
  await connected(ctx);
  assert.deepEqual(ctx.sockets[0].keepAliveCalls, []);
});

test('receive: data is copied into a Uint8Array and recorded without the payload in history', async () => {
  const ctx = setup();
  await connected(ctx);
  ctx.clock.advance(10);
  const chunk = Buffer.from([0x41, 0x0d]);
  ctx.sockets[0].emit('data', chunk);
  chunk[0] = 0x00; // later mutation of the source must not change the event
  const recv = ctx.events.find((e) => e.type === 'recv');
  assert.deepEqual(Array.from(recv.bytes), [0x41, 0x0d]);
  assert.equal(recv.t, 10);
  assert.ok(recv.bytes instanceof Uint8Array);
  const recorded = ctx.connection.getHistory().find((e) => e.type === 'recv');
  assert.equal(recorded.bytes, undefined, 'history keeps only the fact of receiving');
});

test('send: writes the bytes and records a send event with the metadata', async () => {
  const ctx = setup();
  await connected(ctx);
  ctx.clock.advance(5);
  const result = await ctx.connection.send(Uint8Array.from([0x40, 0x0d]), { expectsReply: true, endsWithTerminator: true });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(Array.from(ctx.sockets[0].written[0]), [0x40, 0x0d]);
  const send = ctx.connection.getHistory().find((e) => e.type === 'send');
  assert.deepEqual({ t: send.t, expectsReply: send.expectsReply, endsWithTerminator: send.endsWithTerminator }, { t: 5, expectsReply: true, endsWithTerminator: true });
});

test('send: refused when not connected, or when the data is empty or not bytes', async () => {
  const ctx = setup();
  assert.deepEqual(await ctx.connection.send(Uint8Array.from([1])), { ok: false, code: 'not_connected' });
  await connected(ctx);
  assert.deepEqual(await ctx.connection.send(new Uint8Array(0)), { ok: false, code: 'invalid_data' });
  assert.deepEqual(await ctx.connection.send('text'), { ok: false, code: 'invalid_data' });
  assert.deepEqual(await ctx.connection.send(null), { ok: false, code: 'invalid_data' });
  assert.equal(ctx.sockets[0].written.length, 0);
});

test('send: writes are serialized in call order', async () => {
  const ctx = setup();
  await connected(ctx);
  const results = await Promise.all([1, 2, 3].map((n) => ctx.connection.send(Uint8Array.from([n]))));
  assert.deepEqual(results, [{ ok: true }, { ok: true }, { ok: true }]);
  assert.deepEqual(ctx.sockets[0].written.map((b) => b[0]), [1, 2, 3]);
});

test('send: a write error is reported with its code', async () => {
  const ctx = setup();
  await connected(ctx);
  ctx.sockets[0].writeError = Object.assign(new Error('pipe'), { code: 'EPIPE' });
  assert.deepEqual(await ctx.connection.send(Uint8Array.from([1])), { ok: false, code: 'write_failed', errno: 'EPIPE' });
});

test('send: queued writes fail with not_connected if the connection ends first', async () => {
  const ctx = setup();
  await connected(ctx);
  // Hold the first write open so it is in flight while the second one waits in the queue.
  let finishFirstWrite;
  ctx.sockets[0].write = (buffer, callback) => {
    ctx.sockets[0].written.push(Uint8Array.from(buffer));
    finishFirstWrite = () => callback(null);
    return true;
  };
  const first = ctx.connection.send(Uint8Array.from([1]));
  const second = ctx.connection.send(Uint8Array.from([2]));
  await flush();
  assert.equal(ctx.sockets[0].written.length, 1, 'only the first write has started');

  ctx.sockets[0].emit('end');
  ctx.sockets[0].emit('close', false);
  finishFirstWrite();
  const [r1, r2] = await Promise.all([first, second]);
  // A write that was handed to the socket when the connection closed has an unknown outcome, so
  // it is reported as failed rather than as sent.
  assert.deepEqual(r1, { ok: false, code: 'not_connected' });
  assert.deepEqual(r2, { ok: false, code: 'not_connected' });
  assert.equal(ctx.sockets[0].written.length, 1, 'the queued second write never reached the socket');
});

test('peer closes: one normalized terminated event, even though both "end" and "close" fire', async () => {
  const ctx = setup();
  await connected(ctx);
  ctx.clock.advance(100);
  ctx.sockets[0].emit('end');
  ctx.sockets[0].emit('close', false);
  await flush();
  const terminated = ctx.connection.getHistory().filter((e) => e.type === 'terminated');
  assert.equal(terminated.length, 1);
  assert.deepEqual(
    { initiator: terminated[0].initiator, hadError: terminated[0].hadError, errorCode: terminated[0].errorCode, finSeen: terminated[0].finSeen, userRequested: terminated[0].userRequested, t: terminated[0].t },
    { initiator: 'peer', hadError: false, errorCode: null, finSeen: true, userRequested: false, t: 100 },
  );
  assert.equal(ctx.connection.getState(), 'closed');
});

test('connection error while connected: initiator "error" with the error code', async () => {
  const ctx = setup();
  await connected(ctx);
  ctx.sockets[0].emit('error', Object.assign(new Error('reset'), { code: 'ECONNRESET' }));
  ctx.sockets[0].emit('close', true);
  await flush();
  const terminated = ctx.connection.getHistory().find((e) => e.type === 'terminated');
  assert.deepEqual(
    { initiator: terminated.initiator, hadError: terminated.hadError, errorCode: terminated.errorCode, finSeen: terminated.finSeen },
    { initiator: 'error', hadError: true, errorCode: 'ECONNRESET', finSeen: false },
  );
});

test('disconnect while connected: userRequested, initiator local, and the socket is ended', async () => {
  const ctx = setup();
  await connected(ctx);
  assert.deepEqual(ctx.connection.disconnect(), { ok: true });
  assert.equal(ctx.connection.getState(), 'closing');
  await flush();
  assert.equal(ctx.sockets[0].ended, true);
  const terminated = ctx.connection.getHistory().find((e) => e.type === 'terminated');
  assert.deepEqual({ initiator: terminated.initiator, userRequested: terminated.userRequested }, { initiator: 'local', userRequested: true });
  assert.equal(ctx.connection.getState(), 'closed');
  assert.equal(ctx.clock.pendingTimers(), 0, 'the grace timer is cleared once closed');
});

test('disconnect: destroys the socket if the peer never completes the close', async () => {
  const ctx = setup({ closeGraceMs: 1000 });
  await connected(ctx);
  ctx.sockets[0].autoClose = false;
  ctx.connection.disconnect();
  ctx.clock.advance(999);
  assert.equal(ctx.sockets[0].destroyed, false);
  ctx.clock.advance(1);
  assert.equal(ctx.sockets[0].destroyed, true);
});

test('disconnect while connecting: cancels without connect_fail or terminated', async () => {
  const ctx = setup();
  ctx.connection.connect(target);
  assert.deepEqual(ctx.connection.disconnect(), { ok: true });
  assert.equal(ctx.connection.getState(), 'closed');
  assert.equal(ctx.sockets[0].destroyed, true);
  assert.equal(ctx.clock.pendingTimers(), 0);
  await flush();
  assert.deepEqual(ctx.connection.getHistory(), []);
  // The late "connect" of the cancelled attempt is ignored.
  ctx.sockets[0].emit('connect');
  assert.equal(ctx.connection.getState(), 'closed');
});

test('disconnect when idle or already closed is a no-op success', async () => {
  const ctx = setup();
  assert.deepEqual(ctx.connection.disconnect(), { ok: true });
  await connected(ctx);
  ctx.sockets[0].emit('close', false);
  assert.deepEqual(ctx.connection.disconnect(), { ok: true });
});

test('history is capped, keeping the newest events', async () => {
  const ctx = setup({ maxHistory: 5 });
  await connected(ctx);
  for (let i = 0; i < 10; i += 1) {
    ctx.clock.advance(1);
    ctx.sockets[0].emit('data', Buffer.from([i]));
  }
  const history = ctx.connection.getHistory();
  assert.equal(history.length, 5);
  assert.deepEqual(history.map((e) => e.t), [6, 7, 8, 9, 10]);
});

test('state events carry the connection id and timestamp', async () => {
  const ctx = setup();
  ctx.clock.advance(42);
  const result = ctx.connection.connect(target);
  const state = ctx.events.find((e) => e.type === 'state');
  assert.deepEqual({ id: state.id, state: state.state, t: state.t }, { id: result.id, state: 'connecting', t: 42 });
});

test('receiving too fast pauses the socket for a moment (nothing is dropped) and says so once a second', async () => {
  const ctx = setup({ recvChunksPerSecond: 3, throttlePauseMs: 200 });
  await connected(ctx);
  const socket = ctx.sockets.at(-1);
  for (let i = 0; i < 4; i += 1) socket.emit('data', Buffer.from(`chunk${i}`));
  assert.equal(socket.paused, true, 'reading is paused after the limit');
  assert.equal(ctx.events.filter((e) => e.type === 'recv').length, 4, 'every chunk that arrived is still reported');
  assert.equal(ctx.events.filter((e) => e.type === 'recv_throttled').length, 1);
  ctx.clock.advance(199);
  assert.equal(socket.paused, true);
  ctx.clock.advance(1);
  assert.equal(socket.paused, false, 'reading resumes by itself');
  assert.equal(socket.resumeCalls, 1);
});

test('the throttle notice is repeated at most once a second however often the pause repeats', async () => {
  const ctx = setup({ recvChunksPerSecond: 1, throttlePauseMs: 100 });
  await connected(ctx);
  const socket = ctx.sockets.at(-1);
  for (let round = 0; round < 8; round += 1) {
    socket.emit('data', Buffer.from('a'));
    socket.emit('data', Buffer.from('b'));
    ctx.clock.advance(100);
  }
  const notices = ctx.events.filter((e) => e.type === 'recv_throttled').length;
  assert.ok(notices >= 1 && notices <= 2, `notices: ${notices}`);
});

test('the byte limit also pauses, and a pause timer never outlives the connection', async () => {
  const ctx = setup({ recvBytesPerSecond: 10, throttlePauseMs: 500 });
  await connected(ctx);
  const socket = ctx.sockets.at(-1);
  socket.emit('data', Buffer.alloc(11, 0x41));
  assert.equal(socket.paused, true);
  ctx.connection.disconnect();
  socket.emit('close', false);
  await flush();
  ctx.clock.advance(5000);
  assert.equal(ctx.clock.pendingTimers(), 0);
  assert.equal(socket.resumeCalls ?? 0, 0, 'a closed socket is not resumed');
});

test('normal traffic is never paused', async () => {
  const ctx = setup();
  await connected(ctx);
  const socket = ctx.sockets.at(-1);
  for (let i = 0; i < 100; i += 1) socket.emit('data', Buffer.from('PWR=on\r'));
  assert.equal(socket.paused ?? false, false);
});
