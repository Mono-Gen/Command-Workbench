// UDP endpoint against real sockets on 127.0.0.1. Ports are chosen by the OS, sends are sequential
// (one datagram, then wait for its effect), every wait has a deadline and sockets are closed in
// finally blocks. Delivery order and loss are never assumed beyond what one-at-a-time use needs.
const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');

const { createUdpEndpoint } = require('../../src/main/udp-endpoint');

const HOST = '127.0.0.1';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// How long a test watches for something that must NOT happen (a drop, a missing error). Generous on
// purpose: a short wait would pass on a slow machine even if the behavior were wrong.
const OBSERVE_MS = 800;

async function until(check, label, ms = 4000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(5);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

function bindSocket(port = 0, address = HOST) {
  const socket = dgram.createSocket('udp4');
  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(port, address, () => { socket.removeListener('error', reject); resolve(socket); });
  });
}

const closeSocket = (socket) => new Promise((resolve) => { try { socket.close(resolve); } catch { resolve(); } });

// A device that answers "ECHO:<request>" from its own socket, optionally from another socket.
async function startDevice({ replyFromOther = false, replyToPort = null } = {}) {
  const main = await bindSocket();
  const other = replyFromOther ? await bindSocket() : null;
  const received = [];
  main.on('message', (message, remote) => {
    received.push({ text: message.toString('latin1'), remote });
    const reply = Buffer.from(`ECHO:${message.toString('latin1')}`, 'latin1');
    const from = other ?? main;
    from.send(reply, replyToPort ?? remote.port, HOST);
  });
  return {
    port: main.address().port,
    received,
    async close() { await closeSocket(main); if (other) await closeSocket(other); },
  };
}

function makeEndpoint() {
  const events = [];
  const endpoint = createUdpEndpoint({ onEvent: (e) => events.push(e) });
  const recv = () => events.filter((e) => e.type === 'recv').map((e) => Buffer.from(e.bytes).toString('latin1'));
  return { endpoint, events, recv };
}

async function connected(env, args) {
  assert.equal(env.endpoint.connect(args).ok, true);
  await until(() => env.endpoint.getState() === 'connected', 'ready');
}

async function finish(env) {
  env.endpoint.disconnect();
  await until(() => env.endpoint.getState() === 'closed', 'closed');
}

test('request and reply keep their datagram boundaries, one at a time', async () => {
  const device = await startDevice();
  const env = makeEndpoint();
  try {
    await connected(env, { host: HOST, port: device.port });
    for (const [i, message] of ['A', 'BB\r', 'CCC'].entries()) {
      assert.equal((await env.endpoint.send(Uint8Array.from(Buffer.from(message)), { expectsReply: true })).ok, true);
      await until(() => env.recv().length === i + 1, `reply ${i}`);
    }
    assert.deepEqual(env.recv(), ['ECHO:A', 'ECHO:BB\r', 'ECHO:CCC']);
    assert.deepEqual(device.received.map((r) => r.text), ['A', 'BB\r', 'CCC']);
    assert.ok(env.events.filter((e) => e.type === 'recv').every((e) => e.fromTarget === true));
    assert.equal(env.events.find((e) => e.type === 'connect_ok').transport, 'udp');
  } finally {
    await finish(env);
    await device.close();
  }
});

test('"localhost" is resolved as IPv4', async () => {
  const device = await startDevice();
  const env = makeEndpoint();
  try {
    await connected(env, { host: 'localhost', port: device.port });
    await env.endpoint.send(Uint8Array.from(Buffer.from('x')));
    await until(() => env.recv().length === 1, 'reply through localhost');
  } finally {
    await finish(env);
    await device.close();
  }
});

test('a reply from another port is dropped by default and shown in accept-any mode', async () => {
  const device = await startDevice({ replyFromOther: true });
  let env = makeEndpoint();
  try {
    await connected(env, { host: HOST, port: device.port });
    await env.endpoint.send(Uint8Array.from(Buffer.from('ping')));
    await until(() => device.received.length === 1, 'device got the request');
    await sleep(OBSERVE_MS);
    assert.deepEqual(env.recv(), [], 'the system filters sources other than the target');
    await finish(env);

    env = makeEndpoint();
    await connected(env, { host: HOST, port: device.port, acceptAnySource: true });
    await env.endpoint.send(Uint8Array.from(Buffer.from('ping')));
    await until(() => env.recv().length === 1, 'reply from the other port');
    const fact = env.events.find((e) => e.type === 'recv');
    assert.equal(fact.fromTarget, false);
    assert.notEqual(fact.remote.port, device.port);
    assert.equal(fact.remote.address, HOST);
  } finally {
    await finish(env);
    await device.close();
  }
});

test('a device that replies to a fixed port, not to the sender, works with a chosen local port', async () => {
  const probe = await bindSocket();
  const fixedPort = probe.address().port;
  await closeSocket(probe);
  const received = [];
  const device = await bindSocket();
  device.on('message', (message) => device.send(Buffer.from(`FIXED:${message.toString('latin1')}`), fixedPort, HOST));
  const env = makeEndpoint();
  try {
    await connected(env, { host: HOST, port: device.address().port, localPort: fixedPort });
    assert.equal(env.events.find((e) => e.type === 'connect_ok').localPort, fixedPort);
    await env.endpoint.send(Uint8Array.from(Buffer.from('go')));
    await until(() => env.recv().length === 1, 'reply to the fixed port');
    received.push(env.recv()[0]);
    assert.deepEqual(received, ['FIXED:go']);
  } finally {
    await finish(env);
    await closeSocket(device);
  }
});

// For a loopback target the endpoint binds 127.0.0.1 exactly (on Windows a 0.0.0.0:P socket does
// NOT conflict with a 127.0.0.1:P one: the more specific one wins and would take the replies).
test('a busy local port is reported, and the port is free again after disconnect', async () => {
  const device = await startDevice();
  const holder = await bindSocket(0, HOST);
  const busyPort = holder.address().port;
  let env = makeEndpoint();
  try {
    env.endpoint.connect({ host: HOST, port: device.port, localPort: busyPort });
    await until(() => env.endpoint.getState() === 'closed', 'refused');
    assert.equal(env.events.find((e) => e.type === 'connect_fail').code, 'EADDRINUSE');
    await closeSocket(holder);

    env = makeEndpoint();
    await connected(env, { host: HOST, port: device.port, localPort: busyPort });
    await finish(env);
    const again = await bindSocket(busyPort, HOST); // proves the endpoint released it
    await closeSocket(again);
  } finally {
    env.endpoint.disconnect();
    await closeSocket(holder);
    await device.close();
  }
});

test('targets that must never be sent to are refused without sending anything', async () => {
  for (const host of ['8.8.8.8', '224.0.0.1', '255.255.255.255', '0.0.0.0']) {
    const env = makeEndpoint();
    env.endpoint.connect({ host, port: 5000 });
    await until(() => env.endpoint.getState() === 'closed', `refused ${host}`);
    const fail = env.events.find((e) => e.type === 'connect_fail');
    assert.ok(fail, host);
    assert.equal(env.events.some((e) => e.type === 'send'), false);
  }
});

test('a send to a port nobody listens on succeeds (UDP cannot tell) and no error appears', async () => {
  const probe = await bindSocket();
  const closedPort = probe.address().port;
  await closeSocket(probe);
  const env = makeEndpoint();
  try {
    await connected(env, { host: HOST, port: closedPort });
    assert.deepEqual(await env.endpoint.send(Uint8Array.from(Buffer.from('x')), { expectsReply: true }), { ok: true });
    await sleep(OBSERVE_MS);
    assert.equal(env.endpoint.getState(), 'connected');
    assert.equal(env.events.some((e) => e.type === 'send_error' || e.type === 'socket_closed'), false);
  } finally {
    await finish(env);
  }
});

test('the largest datagram goes through, one byte more is refused', async () => {
  const device = await startDevice();
  const env = makeEndpoint();
  try {
    await connected(env, { host: HOST, port: device.port });
    assert.equal((await env.endpoint.send(new Uint8Array(65507).fill(0x41))).ok, true);
    await until(() => device.received.length === 1, 'big datagram arrived');
    assert.equal(device.received[0].text.length, 65507);
    assert.deepEqual(await env.endpoint.send(new Uint8Array(65508)), { ok: false, code: 'too_large' });
  } finally {
    await finish(env);
    await device.close();
  }
});
