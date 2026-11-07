// Regression tests for the independent audit of the device server: every path that a hostile or
// broken peer could use to crash, stall or leak must be closed.
const test = require('node:test');
const assert = require('node:assert/strict');

const { createDeviceServer } = require('../../src/main/device-server');
const { validateDefinition } = require('../../src/core/device-definition');
const { createFakeClock, flush } = require('../helpers/fakes');
const { FakeServer } = require('../helpers/fake-server');

const CR = 0x0d;
const withCr = (text) => Uint8Array.from([...Buffer.from(text, 'utf8'), CR]);
const textOf = (bytes) => Buffer.from(bytes).toString('utf8').split(String.fromCharCode(13)).join('<CR>');

function definition(connection = {}) {
  const result = validateDefinition({
    schemaVersion: 1,
    name: 'Sample',
    framing: { terminator: 'cr' },
    greeting: 'READY[CR]',
    connection,
    variables: { power: { type: 'enum', values: ['standby', 'on'], initial: 'standby' } },
    commands: [
      { pattern: 'PWR ?', reply: 'PWR={var.power}[CR]' },
      { pattern: 'SLOW ?', delayMs: 500, reply: 'SLOW[CR]' },
    ],
    unknown: { reply: 'ERR 2[CR]' },
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  return result.definition;
}

function setup({ connection = {}, limits = {} } = {}) {
  const clock = createFakeClock();
  const events = [];
  const servers = [];
  const server = createDeviceServer({
    createServer: (handler) => { const s = new FakeServer(handler); servers.push(s); return s; },
    scheduler: clock.scheduler,
    now: clock.now,
    onEvent: (e) => events.push(e),
    limits,
  });
  return { server, clock, events, servers, def: definition(connection), fake: () => servers.at(-1) };
}

const start = async (ctx, host = '127.0.0.1', port = 0) => {
  const r = await ctx.server.start({ definition: ctx.def, host, port });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r;
};

// ---- sockets that are refused or limited still need an error listener --------------------------

test('every kind of refused socket has an error listener (an unhandled "error" would crash the main process)', async () => {
  const cases = [
    { name: 'startup quiet', connection: { startupQuietMs: 5000 } },
    { name: 'refuse', connection: { maxConnections: 1, overLimit: 'refuse' }, prefill: 1 },
    { name: 'accept_then_close', connection: { maxConnections: 1, overLimit: 'accept_then_close' }, prefill: 1 },
  ];
  for (const c of cases) {
    const ctx = setup({ connection: c.connection });
    await start(ctx);
    for (let i = 0; i < (c.prefill ?? 0); i += 1) ctx.fake().accept();
    const refused = ctx.fake().accept();
    assert.ok(refused.listenerCount('error') >= 1, `${c.name}: has an error listener`);
    assert.doesNotThrow(() => refused.emit('error', Object.assign(new Error('reset'), { code: 'ECONNRESET' })), c.name);
  }
  const limited = setup({ connection: { maxConnections: 32 }, limits: { acceptsPerSecond: 1 } });
  await start(limited);
  limited.fake().accept();
  const over = limited.fake().accept();
  assert.ok(over.listenerCount('error') >= 1, 'rate-limited socket has an error listener');
  assert.doesNotThrow(() => over.emit('error', new Error('reset')));
});

// ---- accept flood ---------------------------------------------------------------------------

test('a flood of connections is cheap: the window counter is constant-memory and the event is reported once', async () => {
  const ctx = setup({ connection: { maxConnections: 32 }, limits: { acceptsPerSecond: 5 } });
  await start(ctx);
  const sockets = Array.from({ length: 20000 }, () => ctx.fake().accept());
  assert.equal(sockets.filter((s) => !s.destroyed).length, 5);
  assert.equal(ctx.events.filter((e) => e.type === 'refused' && e.reason === 'rate_limit').length, 1, 'one report per window, not one per socket');
  ctx.clock.advance(1000);
  assert.equal(ctx.fake().accept().destroyed, false, 'a new window starts');
});

// ---- unterminated and oversized input ---------------------------------------------------------

test('an oversized message is not a complete message: it does not reset the first-message deadline', async () => {
  const ctx = setup({ limits: { lanFirstMessageMs: 5000 } });
  await start(ctx, '0.0.0.0');
  const socket = ctx.fake().accept();
  await flush();
  socket.emit('data', Buffer.alloc(5000, 0x41)); // 5000 bytes, no terminator
  ctx.clock.advance(4999);
  assert.equal(socket.destroyed, false);
  ctx.clock.advance(1);
  assert.equal(socket.destroyed, true, 'still cut off by the deadline');
  assert.ok(ctx.events.some((e) => e.type === 'connection_closed' && e.reason === 'no_message'));
});

test('an oversized message does not reset the idle timer either', async () => {
  const ctx = setup({ connection: { idleTimeoutMs: 1000 } });
  await start(ctx);
  const socket = ctx.fake().accept();
  ctx.clock.advance(900);
  socket.emit('data', Buffer.alloc(5000, 0x41));
  ctx.clock.advance(100);
  assert.equal(socket.ended, true);
});

test('a peer that never sends a terminator is cut off after 64 KiB', async () => {
  const ctx = setup({ connection: { idleTimeoutMs: 0 } });
  await start(ctx);
  const socket = ctx.fake().accept();
  await flush();
  for (let i = 0; i < 20; i += 1) socket.emit('data', Buffer.alloc(4096, 0x41));
  assert.equal(socket.destroyed, true);
  assert.ok(ctx.events.some((e) => e.type === 'connection_closed' && e.reason === 'oversize'));
});

test('64 KiB of ordinary terminated messages is fine (the counter resets on every complete message)', async () => {
  const ctx = setup({ connection: { idleTimeoutMs: 0 } });
  await start(ctx);
  const socket = ctx.fake().accept();
  await flush();
  for (let i = 0; i < 100; i += 1) socket.emit('data', Buffer.from(withCr('PWR ?')));
  assert.equal(socket.destroyed, false);
});

// ---- generations and lifecycle ----------------------------------------------------------------

test('a late "error" from a previous run does not stop the new run', async () => {
  const ctx = setup();
  await start(ctx);
  const oldServer = ctx.fake();
  await ctx.server.stop();
  const again = await start(ctx);
  assert.equal(again.generation, 2);

  oldServer.emit('error', Object.assign(new Error('late'), { code: 'EIO' }));
  await flush();
  assert.equal(ctx.server.getState().running, true, 'the new run is untouched');
  assert.ok(!ctx.events.some((e) => e.type === 'server_error' && e.generation === 2));
});

test('stop() while the server is still starting cancels the start and releases the port', async () => {
  const ctx = setup();
  const starting = ctx.server.start({ definition: ctx.def, host: '127.0.0.1', port: 0 });
  const stopping = ctx.server.stop();
  assert.deepEqual(await starting, { ok: false, code: 'cancelled' });
  assert.deepEqual(await stopping, { ok: true });
  assert.equal(ctx.fake().closed, true, 'the listening socket was closed');
  assert.equal(ctx.server.getState().running, false);
  assert.equal((await ctx.server.start({ definition: ctx.def, host: '127.0.0.1', port: 0 })).ok, true, 'and it can start again');
});

test('stop() while starting also resolves when the start fails', async () => {
  const clock = createFakeClock();
  const server = createDeviceServer({
    createServer: (h) => new FakeServer(h, { failWith: 'EADDRINUSE' }),
    scheduler: clock.scheduler,
    now: clock.now,
  });
  const starting = server.start({ definition: definition(), host: '127.0.0.1', port: 5000 });
  const stopping = server.stop();
  assert.equal((await starting).ok, false);
  assert.deepEqual(await stopping, { ok: true });
});

test('a retry after a listen failure works on the SAME server instance', async () => {
  const clock = createFakeClock();
  let attempt = 0;
  const server = createDeviceServer({
    createServer: (h) => { attempt += 1; return new FakeServer(h, { failWith: attempt === 1 ? 'EADDRINUSE' : null }); },
    scheduler: clock.scheduler,
    now: clock.now,
  });
  assert.equal((await server.start({ definition: definition(), host: '127.0.0.1', port: 5000 })).code, 'listen_failed');
  assert.equal((await server.start({ definition: definition(), host: '127.0.0.1', port: 5000 })).ok, true);
  assert.equal(server.getState().running, true);
});

// ---- silence and mute apply at write time ------------------------------------------------------

test('a delayed reply that was queued before the mute is dropped when its time comes', async () => {
  const ctx = setup();
  await start(ctx);
  const socket = ctx.fake().accept();
  await flush();
  socket.written.length = 0;

  socket.emit('data', Buffer.from(withCr('SLOW ?')));
  ctx.clock.advance(100);
  ctx.server.setFault({ muted: true });
  ctx.clock.advance(400);
  await flush();
  assert.deepEqual(socket.written.map(textOf), [], 'nothing is written after the mute began');
  assert.ok(ctx.events.some((e) => e.type === 'muted'));
});

test('a reply queued before the connection went silent (idle stop_responding) is dropped too', async () => {
  const ctx = setup({ connection: { idleTimeoutMs: 1000, idleBehavior: 'stop_responding' } });
  await start(ctx);
  ctx.server.setFault({ extraDelayMs: 5000 });
  const socket = ctx.fake().accept();
  await flush();
  socket.written.length = 0;
  socket.emit('data', Buffer.from(withCr('PWR ?')));
  ctx.clock.advance(1000); // idle: the connection becomes silent for good
  ctx.clock.advance(4000);
  await flush();
  assert.deepEqual(socket.written.map(textOf), []);
});

// ---- write deadline and timers -----------------------------------------------------------------

test('a write that never completes closes the connection after the write deadline', async () => {
  const ctx = setup({ limits: { writeTimeoutMs: 3000 } });
  await start(ctx);
  const socket = ctx.fake().accept();
  await flush(); // the greeting is written normally
  socket.write = () => true; // from now on the callback never fires (a peer that does not read)
  socket.emit('data', Buffer.from(withCr('PWR ?')));
  ctx.clock.advance(2999);
  assert.equal(socket.destroyed, false);
  ctx.clock.advance(1);
  assert.equal(socket.destroyed, true);
  assert.ok(ctx.events.some((e) => e.type === 'connection_closed' && e.reason === 'write_timeout'));
});

test('a completed write clears its deadline timer', async () => {
  const ctx = setup({ limits: { writeTimeoutMs: 3000 } });
  await start(ctx);
  ctx.fake().accept();
  await flush();
  assert.equal(ctx.clock.pendingTimers(), 0, 'no deadline timer is left after the greeting was written');
});

test('the grace timer of a gracefully closed connection is cleared when the socket closes', async () => {
  const ctx = setup();
  await start(ctx);
  const socket = ctx.fake().accept();
  await flush();
  ctx.server.closeAllConnections();
  assert.equal(ctx.clock.pendingTimers(), 1, 'the grace timer waits for the peer');
  socket.emit('close', false);
  assert.equal(ctx.clock.pendingTimers(), 0);
});

test('the grace timer of an over-limit connection is cleared when its socket closes', async () => {
  const ctx = setup({ connection: { maxConnections: 1, overLimit: 'accept_then_close' } });
  await start(ctx);
  ctx.fake().accept();
  await flush();
  const extra = ctx.fake().accept();
  extra.autoClose = false; // the peer does not complete the close by itself
  await flush();
  assert.equal(ctx.clock.pendingTimers(), 1);
  extra.emit('close', false);
  assert.equal(ctx.clock.pendingTimers(), 0);
});

// ---- argument rules -----------------------------------------------------------------------------

test('ports: 0 (pick a free one) or 1024-65535 only', async () => {
  const ctx = setup();
  for (const port of [1, 80, 1023]) {
    assert.deepEqual(await ctx.server.start({ definition: ctx.def, host: '127.0.0.1', port }), { ok: false, code: 'invalid_port' }, String(port));
  }
  assert.equal((await ctx.server.start({ definition: ctx.def, host: '127.0.0.1', port: 1024 })).ok, true);
});

test('setFault needs at least one known field', async () => {
  const ctx = setup();
  await start(ctx);
  for (const bad of [{}, { unknown: 1 }, { dropNextReplies: undefined }]) {
    assert.deepEqual(ctx.server.setFault(bad), { ok: false, code: 'invalid_arguments' }, JSON.stringify(bad));
  }
  assert.equal(ctx.events.filter((e) => e.type === 'faults').length, 0, 'no event for a refused call');
});
