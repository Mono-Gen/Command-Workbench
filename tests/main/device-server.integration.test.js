// Controller <-> device round trips over real sockets on 127.0.0.1: the existing client
// (src/main/connection.js) talks to the new device server. Real timers and generous deadlines;
// every test has a hard deadline and cleans up after itself. Time boundaries are covered with a
// fake clock in device-server.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');

const { createDeviceServer } = require('../../src/main/device-server');
const { createConnection } = require('../../src/main/connection');
const { validateDefinition } = require('../../src/core/device-definition');

const DEADLINE_MS = 15000;
const CR = String.fromCharCode(13);

function definition(connection = {}) {
  const result = validateDefinition({
    schemaVersion: 1,
    name: 'Sample matrix',
    framing: { terminator: 'cr' },
    greeting: 'READY[CR]',
    connection,
    variables: { power: { type: 'enum', values: ['standby', 'on'], initial: 'standby' } },
    commands: [
      { pattern: 'PWR ?', reply: 'PWR={var.power}[CR]' },
      { pattern: 'PWR {state}', capture: { state: { map: { 0: 'standby', 1: 'on' } } }, do: { set: { power: '{capture.state}' } }, reply: null, invalid: { reply: 'ERR 1[CR]' } },
    ],
    notifications: [{ when: { var: 'power', changes: true }, send: 'EVT POWER={var.power}[CR]' }],
    unknown: { reply: 'ERR 2[CR]' },
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  return result.definition;
}

async function startDevice(t, connection, serverOptions = {}) {
  const server = createDeviceServer(serverOptions);
  t.after(() => server.stop());
  const result = await server.start({ definition: definition(connection), host: '127.0.0.1', port: 0 });
  assert.equal(result.ok, true, JSON.stringify(result));
  return { server, port: result.port };
}

function client(t) {
  const events = [];
  const connection = createConnection({ onEvent: (e) => events.push(e) });
  t.after(() => connection.disconnect());
  const received = () => events.filter((e) => e.type === 'recv').map((e) => Buffer.from(e.bytes).toString('utf8').split(CR).join('<CR>'));
  return { connection, events, received };
}

async function waitFor(condition, description) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > DEADLINE_MS - 3000) assert.fail(`timed out waiting for: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const connect = async (c, port) => {
  assert.equal(c.connection.connect({ host: '127.0.0.1', port }).ok, true);
  await waitFor(() => c.connection.getState() === 'connected', 'connected');
};
const sendText = (c, text) => c.connection.send(Uint8Array.from(Buffer.from(`${text}${CR}`, 'utf8')), { expectsReply: true });
const terminated = (c) => c.events.find((e) => e.type === 'terminated');

test('greeting, query, silent set with notification, unknown command', { timeout: DEADLINE_MS }, async (t) => {
  const { port } = await startDevice(t, { maxConnections: 2 });
  const c = client(t);
  await connect(c, port);
  await waitFor(() => c.received().length === 1, 'greeting');
  assert.deepEqual(c.received(), ['READY<CR>']);

  await sendText(c, 'PWR ?');
  await waitFor(() => c.received().length === 2, 'query reply');
  assert.equal(c.received()[1], 'PWR=standby<CR>');

  await sendText(c, 'PWR 1');
  await waitFor(() => c.received().length === 3, 'notification');
  assert.equal(c.received()[2], 'EVT POWER=on<CR>');

  await sendText(c, 'PWR ?');
  await waitFor(() => c.received().length === 4, 'state-dependent reply');
  assert.equal(c.received()[3], 'PWR=on<CR>');

  await sendText(c, 'NOPE');
  await waitFor(() => c.received().length === 5, 'unknown reply');
  assert.equal(c.received()[4], 'ERR 2<CR>');
});

test('a notification reaches a second controller connected to the same device', { timeout: DEADLINE_MS }, async (t) => {
  const { port } = await startDevice(t, { maxConnections: 2 });
  const a = client(t);
  const b = client(t);
  await connect(a, port);
  await connect(b, port);
  await waitFor(() => a.received().length === 1 && b.received().length === 1, 'both greeted');
  await sendText(a, 'PWR 1');
  await waitFor(() => b.received().length === 2, 'notification at b');
  assert.equal(b.received()[1], 'EVT POWER=on<CR>');
});

test('over the connection limit the second controller is closed at once', { timeout: DEADLINE_MS }, async (t) => {
  const { port } = await startDevice(t, { maxConnections: 1, overLimit: 'refuse' });
  const first = client(t);
  const second = client(t);
  await connect(first, port);
  await waitFor(() => first.received().length === 1, 'first greeted');

  assert.equal(second.connection.connect({ host: '127.0.0.1', port }).ok, true);
  await waitFor(() => second.connection.getState() === 'closed', 'second closed');
  assert.deepEqual(second.received(), [], 'no greeting for the refused connection');
  assert.equal(first.connection.getState(), 'connected');
});

test('over the limit with accept_then_close the second controller sees a greeting and then a close', { timeout: DEADLINE_MS }, async (t) => {
  const { port } = await startDevice(t, { maxConnections: 1, overLimit: 'accept_then_close' });
  const first = client(t);
  const second = client(t);
  await connect(first, port);
  // The second connection is greeted and closed within a few milliseconds, so "connected" may never
  // be observed by polling; wait for the close itself.
  assert.equal(second.connection.connect({ host: '127.0.0.1', port }).ok, true);
  await waitFor(() => second.connection.getState() === 'closed', 'second closed after the greeting');
  assert.ok(second.events.some((e) => e.type === 'connect_ok'), 'it did connect');
  assert.deepEqual(second.received(), ['READY<CR>']);
  assert.equal(terminated(second).initiator, 'peer');
  assert.equal(first.connection.getState(), 'connected');
});

test('idle close: the controller sees the device close the connection (and keepalive does not prevent it)', { timeout: DEADLINE_MS }, async (t) => {
  const { port } = await startDevice(t, { idleTimeoutMs: 1000, idleBehavior: 'close' });
  const c = client(t);
  c.connection.connect({ host: '127.0.0.1', port, keepAlive: { enabled: true, initialDelayMs: 1000 } });
  await waitFor(() => c.connection.getState() === 'connected', 'connected');
  const started = Date.now();
  await waitFor(() => c.connection.getState() === 'closed', 'closed by the device');
  const waited = Date.now() - started;
  assert.ok(waited >= 800 && waited < 5000, `closed after about one second (was ${waited} ms)`);
  const end = terminated(c);
  assert.deepEqual({ initiator: end.initiator, finSeen: end.finSeen, userRequested: end.userRequested }, { initiator: 'peer', finSeen: true, userRequested: false });
});

test('idle stop_responding: the connection stays open but the device goes silent', { timeout: DEADLINE_MS }, async (t) => {
  const { port } = await startDevice(t, { idleTimeoutMs: 1000, idleBehavior: 'stop_responding' });
  const c = client(t);
  await connect(c, port);
  await waitFor(() => c.received().length === 1, 'greeting');
  await new Promise((resolve) => setTimeout(resolve, 1300));
  await sendText(c, 'PWR ?');
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(c.connection.getState(), 'connected');
  assert.deepEqual(c.received(), ['READY<CR>'], 'no reply after the device stopped responding');
});

test('startup quiet period: connections made too early are closed without a greeting, later ones work', { timeout: DEADLINE_MS }, async (t) => {
  const { port } = await startDevice(t, { startupQuietMs: 700 });
  const early = client(t);
  assert.equal(early.connection.connect({ host: '127.0.0.1', port }).ok, true);
  await waitFor(() => early.connection.getState() === 'closed', 'early connection closed');
  assert.deepEqual(early.received(), []);

  await new Promise((resolve) => setTimeout(resolve, 800));
  const later = client(t);
  await connect(later, port);
  await waitFor(() => later.received().length === 1, 'greeting after the quiet period');
});

test('stop() closes controllers and frees the port: the same port can be used again at once', { timeout: DEADLINE_MS }, async (t) => {
  const first = createDeviceServer();
  t.after(() => first.stop());
  const started = await first.start({ definition: definition(), host: '127.0.0.1', port: 0 });
  const c = client(t);
  await connect(c, started.port);
  await waitFor(() => c.received().length === 1, 'greeting');

  assert.deepEqual(await first.stop(), { ok: true });
  await waitFor(() => c.connection.getState() === 'closed', 'controller sees the close');

  // Rebinding the same port right after stop (TIME_WAIT must not get in the way).
  const again = await first.start({ definition: definition(), host: '127.0.0.1', port: started.port });
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.port, started.port);
  assert.equal(again.generation, 2);
  const c2 = client(t);
  await connect(c2, started.port);
  await waitFor(() => c2.received().length === 1, 'greeting after restart');
});

test('start on a port that is in use reports the error and leaves the server stopped', { timeout: DEADLINE_MS }, async (t) => {
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => blocker.close(resolve)));

  const server = createDeviceServer();
  const result = await server.start({ definition: definition(), host: '127.0.0.1', port: blocker.address().port });
  assert.deepEqual(result, { ok: false, code: 'listen_failed', errno: 'EADDRINUSE' });
  assert.equal(server.getState().running, false);
});

test('faults work end to end: dropped reply, delayed reply, close all', { timeout: DEADLINE_MS }, async (t) => {
  const { server, port } = await startDevice(t);
  const c = client(t);
  await connect(c, port);
  await waitFor(() => c.received().length === 1, 'greeting');

  server.setFault({ dropNextReplies: 1 });
  await sendText(c, 'PWR ?');
  await sendText(c, 'PWR ?');
  await waitFor(() => c.received().length === 2, 'the second reply');
  assert.equal(c.received().length, 2, 'only one of the two replies arrived');

  server.setFault({ extraDelayMs: 400 });
  const before = Date.now();
  await sendText(c, 'PWR ?');
  await waitFor(() => c.received().length === 3, 'delayed reply');
  assert.ok(Date.now() - before >= 350);

  assert.equal(server.closeAllConnections().closed, 1);
  await waitFor(() => c.connection.getState() === 'closed', 'closed by the fault');
});

test('the device state is visible while connected', { timeout: DEADLINE_MS }, async (t) => {
  const { server, port } = await startDevice(t, { idleTimeoutMs: 5000 });
  const c = client(t);
  await connect(c, port);
  await sendText(c, 'PWR 1');
  await waitFor(() => server.getState().variables.power === 'on', 'state updated');
  const state = server.getState();
  assert.equal(state.connections.length, 1);
  assert.ok(state.connections[0].idleInMs > 0 && state.connections[0].idleInMs <= 5000);
});
