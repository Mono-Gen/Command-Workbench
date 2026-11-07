// Integration tests against real sockets on 127.0.0.1. Servers use port 0 (the OS picks a free
// port), every accepted socket is destroyed on cleanup, and every test has a hard deadline.
// Timeouts and DNS failures are not tested here (they cannot be reproduced reliably on
// localhost); they are covered with fake sockets in connection.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');

const { createConnection } = require('../../src/main/connection');

const DEADLINE_MS = 10000;

async function startServer(t, onConnection) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    onConnection(socket);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return server.address().port;
}

function startClient(t) {
  const events = [];
  const connection = createConnection({ onEvent: (event) => events.push(event) });
  t.after(() => connection.disconnect());
  return { connection, events };
}

// Polls until the condition is true; fails with a clear message instead of hanging.
async function waitFor(condition, description) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > DEADLINE_MS - 2000) {
      assert.fail(`timed out waiting for: ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const lastEvent = (events, type) => events.filter((e) => e.type === type).at(-1);

test('echo round trip, then a user disconnect is reported as local', { timeout: DEADLINE_MS }, async (t) => {
  const port = await startServer(t, (socket) => socket.pipe(socket));
  const { connection, events } = startClient(t);

  assert.equal(connection.connect({ host: '127.0.0.1', port }).ok, true);
  await waitFor(() => connection.getState() === 'connected', 'connected');

  const sent = await connection.send(Uint8Array.from([0x50, 0x49, 0x4e, 0x47, 0x0d]), { expectsReply: true, endsWithTerminator: true });
  assert.deepEqual(sent, { ok: true });
  await waitFor(() => lastEvent(events, 'recv'), 'echoed data');
  assert.deepEqual(Array.from(lastEvent(events, 'recv').bytes), [0x50, 0x49, 0x4e, 0x47, 0x0d]);

  connection.disconnect();
  await waitFor(() => connection.getState() === 'closed', 'closed');
  const terminated = lastEvent(events, 'terminated');
  assert.equal(terminated.initiator, 'local');
  assert.equal(terminated.userRequested, true);
  assert.equal(events.filter((e) => e.type === 'terminated').length, 1);
});

test('the server closing the connection is reported once, as the peer', { timeout: DEADLINE_MS }, async (t) => {
  const port = await startServer(t, (socket) => { setTimeout(() => socket.end(), 20); });
  const { connection, events } = startClient(t);

  connection.connect({ host: '127.0.0.1', port });
  await waitFor(() => connection.getState() === 'closed', 'closed by the peer');
  const terminated = events.filter((e) => e.type === 'terminated');
  assert.equal(terminated.length, 1);
  assert.deepEqual(
    { initiator: terminated[0].initiator, finSeen: terminated[0].finSeen, userRequested: terminated[0].userRequested, hadError: terminated[0].hadError },
    { initiator: 'peer', finSeen: true, userRequested: false, hadError: false },
  );
});

test('a refused connection is reported as connect_fail ECONNREFUSED', { timeout: DEADLINE_MS }, async (t) => {
  // Find a port that is free right now by opening and closing a server.
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));

  const { connection, events } = startClient(t);
  connection.connect({ host: '127.0.0.1', port });
  await waitFor(() => connection.getState() === 'closed', 'closed after refusal');
  assert.equal(lastEvent(events, 'connect_fail').code, 'ECONNREFUSED');
  assert.equal(events.filter((e) => e.type === 'terminated').length, 0);
});

test('keepalive can be requested on a real socket, and changed while connected', { timeout: DEADLINE_MS }, async (t) => {
  const port = await startServer(t, () => {});
  const { connection } = startClient(t);
  connection.connect({ host: '127.0.0.1', port, keepAlive: { enabled: true, initialDelayMs: 30000 } });
  await waitFor(() => connection.getState() === 'connected', 'connected');
  assert.deepEqual(connection.setKeepAlive(false, 0), { ok: true });
  assert.deepEqual(connection.setKeepAlive(true, 15000), { ok: true });
});

test('can reconnect after the server closed the connection', { timeout: DEADLINE_MS }, async (t) => {
  let accepted = 0;
  const port = await startServer(t, (socket) => {
    accepted += 1;
    if (accepted === 1) setTimeout(() => socket.end(), 10);
  });
  const { connection, events } = startClient(t);

  connection.connect({ host: '127.0.0.1', port });
  await waitFor(() => connection.getState() === 'closed', 'first connection closed');

  const second = connection.connect({ host: '127.0.0.1', port });
  assert.equal(second.ok, true);
  await waitFor(() => connection.getState() === 'connected', 'second connection');
  assert.deepEqual(connection.getHistory().map((e) => e.type), ['connect_ok'], 'history starts fresh');
  assert.equal(events.filter((e) => e.type === 'connect_ok').length, 2);
});

test('a chunk is delivered as bytes even when it is not valid text', { timeout: DEADLINE_MS }, async (t) => {
  const port = await startServer(t, (socket) => { socket.write(Buffer.from([0xff, 0x00, 0x80, 0x0a])); });
  const { connection, events } = startClient(t);
  connection.connect({ host: '127.0.0.1', port });
  await waitFor(() => events.some((e) => e.type === 'recv'), 'binary data');
  const received = events.filter((e) => e.type === 'recv').flatMap((e) => Array.from(e.bytes));
  assert.deepEqual(received, [0xff, 0x00, 0x80, 0x0a]);
});
