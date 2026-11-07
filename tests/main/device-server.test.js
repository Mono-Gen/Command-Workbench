// Tests for the device server with a fake server, fake sockets and a manual clock.
// Expected behavior comes from the Phase 2 plan (sections 5.5 and 6).
const test = require('node:test');
const assert = require('node:assert/strict');

const { createDeviceServer } = require('../../src/main/device-server');
const { validateDefinition } = require('../../src/core/device-definition');
const { createFakeClock, flush } = require('../helpers/fakes');
const { FakeServer } = require('../helpers/fake-server');

const CR = 0x0d;
const bytesOf = (text) => Uint8Array.from(Buffer.from(text, 'utf8'));
const withCr = (text) => Uint8Array.from([...Buffer.from(text, 'utf8'), CR]);
const textOf = (bytes) => Buffer.from(bytes).toString('utf8').split(String.fromCharCode(13)).join('<CR>');

function sampleDefinition(connection = {}) {
  const input = {
    schemaVersion: 1,
    name: 'Sample matrix',
    framing: { terminator: 'cr' },
    greeting: 'READY[CR]',
    connection,
    variables: {
      power: { type: 'enum', values: ['standby', 'on'], initial: 'standby' },
      input: { type: 'int', min: 1, max: 8, initial: 1 },
    },
    commands: [
      { pattern: 'PWR ?', reply: 'PWR={var.power}[CR]' },
      { pattern: 'PWR {state}', capture: { state: { map: { 0: 'standby', 1: 'on' } } }, do: { set: { power: '{capture.state}' } }, reply: null, invalid: { reply: 'ERR 1[CR]' } },
      { pattern: 'SLOW ?', delayMs: 500, reply: 'SLOW[CR]' },
      { pattern: 'FAST ?', reply: 'FAST[CR]' },
    ],
    notifications: [{ when: { var: 'power', changes: true }, send: 'EVT POWER={var.power}[CR]' }],
    unknown: { reply: 'ERR 2[CR]' },
  };
  const result = validateDefinition(input);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  return result.definition;
}

function setup({ connection = {}, limits = {}, serverOptions = {} } = {}) {
  const clock = createFakeClock();
  const events = [];
  let fakeServer;
  const server = createDeviceServer({
    createServer: (handler) => { fakeServer = new FakeServer(handler, serverOptions); return fakeServer; },
    scheduler: clock.scheduler,
    now: clock.now,
    onEvent: (e) => events.push(e),
    limits,
  });
  const definition = sampleDefinition(connection);
  return { server, clock, events, definition, fake: () => fakeServer };
}

async function started(ctx, host = '127.0.0.1', port = 0) {
  const result = await ctx.server.start({ definition: ctx.definition, host, port });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}

const written = (socket) => socket.written.map(textOf);
const send = (socket, bytes) => socket.emit('data', Buffer.from(bytes));

// ---- start / stop --------------------------------------------------------------------------

test('start: validates host, port and definition before listening', async () => {
  const ctx = setup();
  assert.deepEqual(await ctx.server.start({ definition: ctx.definition, host: '192.0.2.1', port: 0 }), { ok: false, code: 'invalid_host' });
  assert.deepEqual(await ctx.server.start({ definition: ctx.definition, host: 'localhost', port: 0 }), { ok: false, code: 'invalid_host' });
  for (const port of [-1, 65536, 1.5, '80', null]) {
    assert.deepEqual(await ctx.server.start({ definition: ctx.definition, host: '127.0.0.1', port }), { ok: false, code: 'invalid_port' });
  }
  assert.deepEqual(await ctx.server.start({ definition: {}, host: '127.0.0.1', port: 0 }), { ok: false, code: 'invalid_definition' });
  assert.equal(ctx.fake(), undefined, 'no server was created for invalid input');
});

test('start: listens on the requested host and reports the real port and a generation', async () => {
  const ctx = setup({ serverOptions: { port: 6000 } });
  const result = await started(ctx, '127.0.0.1', 0);
  assert.deepEqual(result, { ok: true, host: '127.0.0.1', port: 6000, generation: 1 });
  assert.deepEqual(ctx.fake().listenOptions, { host: '127.0.0.1', port: 0 });
  assert.equal(ctx.events.find((e) => e.type === 'listening').port, 6000);
  assert.deepEqual(await ctx.server.start({ definition: ctx.definition, host: '127.0.0.1', port: 0 }), { ok: false, code: 'already_running' });
});

test('start: a listen failure (port in use) is reported and the server can be started again', async () => {
  const ctx = setup({ serverOptions: { failWith: 'EADDRINUSE' } });
  assert.deepEqual(await ctx.server.start({ definition: ctx.definition, host: '127.0.0.1', port: 5000 }), { ok: false, code: 'listen_failed', errno: 'EADDRINUSE' });
  assert.equal(ctx.server.getState().running, false);
  ctx.fake().failWith = null;
  // A new server object is created for the retry, without the failure.
  const again = createDeviceServer({ createServer: (h) => new FakeServer(h), scheduler: ctx.clock.scheduler, now: ctx.clock.now });
  assert.equal((await again.start({ definition: ctx.definition, host: '127.0.0.1', port: 0 })).ok, true);
});

test('stop: closes every connection, waits for the port to be released, then allows a restart with a new generation', async () => {
  const ctx = setup();
  await started(ctx);
  const socket = ctx.fake().accept();
  await flush();
  ctx.fake().autoClose = false;

  let stopped = false;
  const stopping = ctx.server.stop().then((r) => { stopped = true; return r; });
  await flush();
  assert.equal(socket.destroyed, true, 'connections are closed at once');
  assert.equal(stopped, false, 'stop() waits for the server to report it is closed');
  assert.deepEqual(await ctx.server.start({ definition: ctx.definition, host: '127.0.0.1', port: 0 }), { ok: false, code: 'busy' }, 'no start while stopping');

  ctx.fake().closeCallback();
  assert.deepEqual(await stopping, { ok: true });
  assert.equal(ctx.server.getState().running, false);

  const again = await ctx.server.start({ definition: ctx.definition, host: '127.0.0.1', port: 0 });
  assert.equal(again.generation, 2);
  assert.ok(ctx.events.some((e) => e.type === 'stopped' && e.generation === 1));
});

test('stop when not running is a no-op; stop leaves no timers behind', async () => {
  const ctx = setup({ connection: { idleTimeoutMs: 5000 } });
  assert.deepEqual(await ctx.server.stop(), { ok: true });
  await started(ctx);
  ctx.fake().accept();
  ctx.fake().accept();
  await ctx.server.stop();
  assert.equal(ctx.clock.pendingTimers(), 0);
});

test('connections arriving after stop() began are destroyed', async () => {
  const ctx = setup();
  await started(ctx);
  ctx.fake().autoClose = false;
  const stopping = ctx.server.stop();
  const late = ctx.fake().accept();
  assert.equal(late.destroyed, true);
  ctx.fake().closeCallback();
  await stopping;
});

// ---- greeting, replies, notifications -----------------------------------------------------

test('a new connection gets the greeting', async () => {
  const ctx = setup();
  await started(ctx);
  const socket = ctx.fake().accept();
  await flush();
  assert.deepEqual(written(socket), ['READY<CR>']);
  assert.ok(ctx.events.some((e) => e.type === 'connection_opened' && e.remote === '192.0.2.50:40000'));
});

test('a query is answered; a silent set writes nothing; unknown commands get the unknown reply', async () => {
  const ctx = setup();
  await started(ctx);
  const socket = ctx.fake().accept();
  await flush();
  socket.written.length = 0;

  send(socket, withCr('PWR ?'));
  await flush();
  assert.deepEqual(written(socket), ['PWR=standby<CR>']);

  socket.written.length = 0;
  send(socket, withCr('FOO'));
  await flush();
  assert.deepEqual(written(socket), ['ERR 2<CR>']);
});

test('merged and split data are framed correctly', async () => {
  const ctx = setup();
  await started(ctx);
  const socket = ctx.fake().accept();
  await flush();
  socket.written.length = 0;

  send(socket, Uint8Array.from([...withCr('PWR ?'), ...withCr('FAST ?')]));
  await flush();
  assert.deepEqual(written(socket), ['PWR=standby<CR>', 'FAST<CR>']);

  socket.written.length = 0;
  send(socket, bytesOf('PW'));
  send(socket, bytesOf('R ?'));
  assert.equal(socket.written.length, 0, 'nothing until the terminator arrives');
  send(socket, Uint8Array.of(CR));
  await flush();
  assert.deepEqual(written(socket), ['PWR=standby<CR>']);
});

test('an oversized message gets the unknown reply and framing recovers', async () => {
  const ctx = setup();
  await started(ctx);
  const socket = ctx.fake().accept();
  await flush();
  socket.written.length = 0;
  send(socket, withCr('A'.repeat(5000)));
  send(socket, withCr('PWR ?'));
  await flush();
  assert.deepEqual(written(socket), ['ERR 2<CR>', 'PWR=standby<CR>']);
  assert.ok(ctx.events.some((e) => e.type === 'rx' && e.overflow === true));
});

test('a state change notifies every connection, after the reply', async () => {
  const ctx = setup({ connection: { maxConnections: 2 } });
  await started(ctx);
  const a = ctx.fake().accept();
  const b = ctx.fake().accept();
  await flush();
  a.written.length = 0;
  b.written.length = 0;

  send(a, withCr('PWR 1'));
  await flush();
  assert.deepEqual(written(a), ['EVT POWER=on<CR>'], 'the sender is notified too, and a silent set adds no reply');
  assert.deepEqual(written(b), ['EVT POWER=on<CR>']);

  const variables = ctx.events.find((e) => e.type === 'variables');
  assert.deepEqual(variables.changes, [{ var: 'power', from: 'standby', to: 'on' }]);
  assert.equal(ctx.server.getState().variables.power, 'on');
});

test('a delayed reply holds the queue: a later reply never overtakes it', async () => {
  const ctx = setup();
  await started(ctx);
  const socket = ctx.fake().accept();
  await flush();
  socket.written.length = 0;

  send(socket, withCr('SLOW ?'));
  send(socket, withCr('FAST ?'));
  await flush();
  assert.deepEqual(written(socket), [], 'nothing yet: the first reply is delayed');
  ctx.clock.advance(499);
  await flush();
  assert.deepEqual(written(socket), []);
  ctx.clock.advance(1);
  await flush();
  assert.deepEqual(written(socket), ['SLOW<CR>', 'FAST<CR>']);
});

test('the rx event carries the bytes, outcome and command index', async () => {
  const ctx = setup();
  await started(ctx);
  const socket = ctx.fake().accept();
  send(socket, withCr('PWR ?'));
  const rx = ctx.events.find((e) => e.type === 'rx');
  assert.deepEqual({ outcome: rx.outcome, commandIndex: rx.commandIndex, text: textOf(rx.bytes) }, { outcome: 'matched', commandIndex: 0, text: 'PWR ?' });
});

// ---- connection limits ---------------------------------------------------------------------

test('over the limit with "refuse": the extra connection is closed at once, without a greeting', async () => {
  const ctx = setup({ connection: { maxConnections: 1, overLimit: 'refuse' } });
  await started(ctx);
  const first = ctx.fake().accept();
  await flush();
  const second = ctx.fake().accept();
  await flush();
  assert.equal(second.destroyed, true);
  assert.deepEqual(written(second), []);
  assert.equal(first.destroyed, false);
  assert.deepEqual(ctx.events.find((e) => e.type === 'refused'), { ...ctx.events.find((e) => e.type === 'refused'), reason: 'limit', behavior: 'refuse' });
});

test('over the limit with "accept_then_close": the extra connection is greeted and then closed', async () => {
  const ctx = setup({ connection: { maxConnections: 1, overLimit: 'accept_then_close' } });
  await started(ctx);
  ctx.fake().accept();
  await flush();
  const second = ctx.fake().accept();
  await flush();
  assert.deepEqual(written(second), ['READY<CR>']);
  assert.equal(second.ended, true);
  assert.equal(ctx.clock.pendingTimers(), 0, 'the peer completed the close, so no grace timer is left');
});

test('a closed connection frees its slot', async () => {
  const ctx = setup({ connection: { maxConnections: 1 } });
  await started(ctx);
  const first = ctx.fake().accept();
  first.emit('close', false);
  const second = ctx.fake().accept();
  await flush();
  assert.equal(second.destroyed, false);
  assert.equal(ctx.server.getState().connections.length, 1);
});

test('during the startup quiet period connections are accepted and closed at once', async () => {
  const ctx = setup({ connection: { startupQuietMs: 2000 } });
  await started(ctx);
  const early = ctx.fake().accept();
  assert.equal(early.destroyed, true);
  assert.deepEqual(written(early), [], 'no greeting while starting up');
  assert.equal(ctx.events.find((e) => e.type === 'refused').reason, 'startup');

  ctx.clock.advance(1999);
  assert.equal(ctx.fake().accept().destroyed, true);
  ctx.clock.advance(1);
  assert.equal(ctx.fake().accept().destroyed, false);
});

test('a flood of connections is limited by the accept rate', async () => {
  const ctx = setup({ connection: { maxConnections: 32 }, limits: { acceptsPerSecond: 3 } });
  await started(ctx);
  const sockets = Array.from({ length: 5 }, () => ctx.fake().accept());
  assert.deepEqual(sockets.map((s) => s.destroyed), [false, false, false, true, true]);
  ctx.clock.advance(1000);
  assert.equal(ctx.fake().accept().destroyed, false, 'the window moves on');
});

// ---- idle ----------------------------------------------------------------------------------

test('idle "close": the connection is closed after the idle time, and a message resets the timer', async () => {
  const ctx = setup({ connection: { idleTimeoutMs: 1000, idleBehavior: 'close' } });
  await started(ctx);
  const socket = ctx.fake().accept();
  await flush();

  ctx.clock.advance(900);
  send(socket, withCr('PWR ?'));
  ctx.clock.advance(900);
  assert.equal(socket.ended, false, 'a complete message reset the idle timer');
  ctx.clock.advance(100);
  assert.equal(socket.ended, true);
  assert.deepEqual(ctx.events.find((e) => e.type === 'connection_closed').reason, 'idle');
  assert.equal(ctx.server.getState().connections.length, 0);
});

test('idle: only COMPLETE messages reset it (partial data does not)', async () => {
  const ctx = setup({ connection: { idleTimeoutMs: 1000 } });
  await started(ctx);
  const socket = ctx.fake().accept();
  ctx.clock.advance(900);
  send(socket, bytesOf('PWR'));
  ctx.clock.advance(100);
  assert.equal(socket.ended, true);
});

test('idle: unknown and invalid commands also reset it', async () => {
  const ctx = setup({ connection: { idleTimeoutMs: 1000 } });
  await started(ctx);
  const socket = ctx.fake().accept();
  ctx.clock.advance(900);
  send(socket, withCr('NOPE'));
  ctx.clock.advance(900);
  assert.equal(socket.ended, false);
});

test('idle "stop_responding": the connection stays open but is silent for good, while state still updates', async () => {
  const ctx = setup({ connection: { idleTimeoutMs: 1000, idleBehavior: 'stop_responding' } });
  await started(ctx);
  const socket = ctx.fake().accept();
  await flush();
  assert.deepEqual(written(socket), ['READY<CR>'], 'the greeting came before the idle time');
  socket.written.length = 0;

  ctx.clock.advance(1000);
  assert.equal(socket.ended, false);
  assert.equal(ctx.server.getState().connections[0].silent, true);

  send(socket, withCr('PWR ?'));
  send(socket, withCr('PWR 1'));
  await flush();
  assert.deepEqual(written(socket), [], 'no reply and no notification');
  assert.equal(ctx.server.getState().variables.power, 'on', 'the state is still updated');
  ctx.clock.advance(60000);
  assert.deepEqual(written(socket), [], 'and it does not come back');
});

test('getState reports the time left until the idle behavior', async () => {
  const ctx = setup({ connection: { idleTimeoutMs: 1000 } });
  await started(ctx);
  ctx.fake().accept();
  ctx.clock.advance(400);
  assert.equal(ctx.server.getState().connections[0].idleInMs, 600);
});

// ---- minimum command interval --------------------------------------------------------------

test('commands arriving sooner than the minimum interval are ignored (and still reset idle)', async () => {
  const ctx = setup({ connection: { minCommandIntervalMs: 100, idleTimeoutMs: 1000 } });
  await started(ctx);
  const socket = ctx.fake().accept();
  await flush();
  socket.written.length = 0;

  send(socket, withCr('PWR ?'));
  ctx.clock.advance(50);
  send(socket, withCr('PWR 1'));
  await flush();
  assert.deepEqual(written(socket), ['PWR=standby<CR>']);
  assert.equal(ctx.server.getState().variables.power, 'standby', 'the early command had no effect');
  assert.ok(ctx.events.some((e) => e.type === 'ignored' && e.reason === 'interval'));

  ctx.clock.advance(950);
  assert.equal(socket.ended, false, 'the ignored message still reset the idle timer (it would fire at t=1050)');

  ctx.clock.advance(10);
  socket.written.length = 0;
  send(socket, withCr('PWR 1'));
  await flush();
  assert.equal(ctx.server.getState().variables.power, 'on', 'a command after the interval works');
});

// ---- faults --------------------------------------------------------------------------------

test('fault: drop the next N replies (state still changes; notifications and greetings are not dropped)', async () => {
  const ctx = setup();
  await started(ctx);
  const socket = ctx.fake().accept();
  await flush();
  socket.written.length = 0;

  assert.equal(ctx.server.setFault({ dropNextReplies: 2 }).ok, true);
  send(socket, withCr('PWR ?'));
  send(socket, withCr('PWR 1'));
  send(socket, withCr('PWR ?'));
  await flush();
  // Only command REPLIES count: "PWR ?" (1st) is dropped, "PWR 1" is silent (no reply to drop) and
  // its notification is delivered, the second "PWR ?" (2nd) is dropped.
  assert.deepEqual(written(socket), ['EVT POWER=on<CR>']);
  assert.equal(ctx.events.filter((e) => e.type === 'dropped').length, 2);
  assert.equal(ctx.server.getState().variables.power, 'on', 'the state changed although the replies were dropped');

  send(socket, withCr('PWR ?'));
  await flush();
  assert.deepEqual(written(socket).at(-1), 'PWR=on<CR>', 'after N drops replies come back');
});

test('fault: extra delay is added to replies only', async () => {
  const ctx = setup();
  await started(ctx);
  const socket = ctx.fake().accept();
  await flush();
  socket.written.length = 0;

  ctx.server.setFault({ extraDelayMs: 300 });
  send(socket, withCr('PWR ?'));
  await flush();
  assert.deepEqual(written(socket), []);
  ctx.clock.advance(300);
  await flush();
  assert.deepEqual(written(socket), ['PWR=standby<CR>']);

  ctx.server.setFault({ extraDelayMs: 0 });
  socket.written.length = 0;
  send(socket, withCr('PWR ?'));
  await flush();
  assert.deepEqual(written(socket), ['PWR=standby<CR>'], 'cleared');
});

test('fault: muted drops every send (replies, notifications, greetings) but state still changes, and nothing is resent after unmuting', async () => {
  const ctx = setup();
  await started(ctx);
  const first = ctx.fake().accept();
  await flush();
  first.written.length = 0;

  ctx.server.setFault({ muted: true });
  send(first, withCr('PWR ?'));
  send(first, withCr('PWR 1'));
  const second = ctx.fake().accept();
  await flush();
  assert.deepEqual(written(first), []);
  assert.deepEqual(written(second), [], 'no greeting while muted');
  assert.equal(ctx.server.getState().variables.power, 'on');

  ctx.server.setFault({ muted: false });
  await flush();
  assert.deepEqual(written(first), [], 'nothing is resent');
  send(first, withCr('PWR ?'));
  await flush();
  assert.deepEqual(written(first), ['PWR=on<CR>']);
});

test('fault: validation of values', async () => {
  const ctx = setup();
  assert.deepEqual(ctx.server.setFault({ muted: true }), { ok: false, code: 'not_running' });
  await started(ctx);
  for (const bad of [null, 'x', { dropNextReplies: -1 }, { dropNextReplies: 1001 }, { dropNextReplies: 1.5 }, { extraDelayMs: 60001 }, { extraDelayMs: '5' }, { muted: 'yes' }]) {
    assert.deepEqual(ctx.server.setFault(bad), { ok: false, code: 'invalid_arguments' }, JSON.stringify(bad));
  }
  assert.equal(ctx.server.setFault({ dropNextReplies: 1000, extraDelayMs: 60000, muted: false }).ok, true);
  assert.deepEqual(ctx.server.getState().faults, { dropNextReplies: 1000, extraDelayMs: 60000, muted: false });
});

test('fault: close all connections ends them gracefully and reports how many', async () => {
  const ctx = setup({ connection: { maxConnections: 3 } });
  await started(ctx);
  const sockets = [ctx.fake().accept(), ctx.fake().accept()];
  assert.deepEqual(ctx.server.closeAllConnections(), { ok: true, closed: 2 });
  assert.deepEqual(sockets.map((s) => s.ended), [true, true]);
  assert.equal(ctx.server.getState().connections.length, 0);
  assert.equal(ctx.events.filter((e) => e.type === 'connection_closed' && e.reason === 'fault').length, 2);
});

// ---- protection of the host ----------------------------------------------------------------

test('a peer that never reads is cut off when its queue grows too large', async () => {
  const ctx = setup({ limits: { maxQueueItems: 3 } });
  await started(ctx);
  const socket = ctx.fake().accept();
  socket.write = () => true; // the write callback never fires: the peer is not reading
  await flush();
  for (let i = 0; i < 6; i += 1) send(socket, withCr('FAST ?'));
  assert.equal(socket.destroyed, true);
  assert.equal(ctx.events.find((e) => e.type === 'connection_closed' && e.reason === 'queue_overflow') !== undefined, true);
});

test('a write error closes the connection', async () => {
  const ctx = setup();
  await started(ctx);
  const socket = ctx.fake().accept();
  socket.writeError = Object.assign(new Error('pipe'), { code: 'EPIPE' });
  await flush();
  assert.equal(socket.destroyed, true);
  assert.ok(ctx.events.some((e) => e.type === 'connection_closed' && e.reason === 'write_error'));
});

test('on all interfaces, a connection that sends nothing is closed after the first-message deadline', async () => {
  const ctx = setup({ limits: { lanFirstMessageMs: 5000 } });
  await started(ctx, '0.0.0.0');
  const socket = ctx.fake().accept();
  ctx.clock.advance(4999);
  assert.equal(socket.destroyed, false);
  ctx.clock.advance(1);
  assert.equal(socket.destroyed, true);
  assert.ok(ctx.events.some((e) => e.reason === 'no_message'));
});

test('on all interfaces, a connection that sends too many messages per second is closed', async () => {
  const ctx = setup({ limits: { lanMessagesPerSecond: 5 } });
  await started(ctx, '0.0.0.0');
  const socket = ctx.fake().accept();
  await flush();
  for (let i = 0; i < 6; i += 1) send(socket, withCr('FAST ?'));
  assert.equal(socket.destroyed, true);
  assert.ok(ctx.events.some((e) => e.reason === 'rate_limit' && e.type === 'connection_closed'));
});

test('on 127.0.0.1 neither the first-message deadline nor the message rate limit applies', async () => {
  const ctx = setup({ limits: { lanFirstMessageMs: 1000, lanMessagesPerSecond: 2 } });
  await started(ctx, '127.0.0.1');
  const socket = ctx.fake().accept();
  await flush(); // let the greeting finish writing (its write deadline is a separate rule)
  ctx.clock.advance(60000);
  for (let i = 0; i < 20; i += 1) send(socket, withCr('FAST ?'));
  assert.equal(socket.destroyed, false);
});

test('an exception in the event listener does not break the server', async () => {
  const reported = [];
  const clock = createFakeClock();
  let fake;
  const server = createDeviceServer({
    createServer: (h) => { fake = new FakeServer(h); return fake; },
    scheduler: clock.scheduler,
    now: clock.now,
    onEvent: () => { throw new Error('listener bug'); },
    onListenerError: (e) => reported.push(e.message),
  });
  assert.equal((await server.start({ definition: sampleDefinition(), host: '127.0.0.1', port: 0 })).ok, true);
  const socket = fake.accept();
  await flush();
  send(socket, withCr('PWR ?'));
  await flush();
  assert.ok(socket.written.length >= 2, 'greeting and reply were still written');
  assert.ok(reported.length > 0);
});

test('a peer closing the connection removes it and clears its timers', async () => {
  const ctx = setup({ connection: { idleTimeoutMs: 5000 } });
  await started(ctx);
  const socket = ctx.fake().accept();
  socket.emit('end');
  socket.emit('close', false);
  assert.equal(ctx.server.getState().connections.length, 0);
  assert.equal(ctx.events.filter((e) => e.type === 'connection_closed').length, 1, 'reported once');
  assert.equal(ctx.clock.pendingTimers(), 0);
});

test('getState when not running', () => {
  const ctx = setup();
  assert.deepEqual(ctx.server.getState(), { running: false, lifecycle: 'idle', connections: [] });
});
