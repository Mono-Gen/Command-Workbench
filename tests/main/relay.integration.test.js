// Real sockets on 127.0.0.1: controller -> relay -> device. Ports are chosen by the OS (port 0),
// every wait has a deadline, and everything is closed in finally blocks.
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { performance } = require('node:perf_hooks');

const { createRelay } = require('../../src/main/relay');
const { createDeviceServer } = require('../../src/main/device-server');
const { createRecorder, validateRecording } = require('../../src/core/recording');
const { draftDefinition, evaluateHoldout, replayCheck } = require('../../src/core/definition-draft');
const { validateDefinition } = require('../../src/core/device-definition');

const HOST = '127.0.0.1';
const monotonic = () => performance.now();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, label, ms = 4000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(5);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

function definition(extra = {}) {
  const result = validateDefinition({
    schemaVersion: 1,
    name: 'Fixture',
    framing: { terminator: 'cr' },
    greeting: 'READY[CR]',
    connection: { maxConnections: 1, overLimit: 'accept_then_close', idleTimeoutMs: 1000, idleBehavior: 'close' },
    commands: [
      { pattern: 'ID?', reply: 'ID A1[CR]' },
      { pattern: 'VER?', reply: 'VER 2.0[CR][LF]' },
      { pattern: 'SLOW?', delayMs: 300, reply: 'SLOW[CR]' },
      { pattern: 'MUTE 1', reply: null },
    ],
    unknown: { reply: 'ERR[CR]' },
    ...extra,
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  return result.definition;
}

// A client that collects what it receives and can half-close.
function connectClient(port) {
  const client = net.connect({ host: HOST, port, allowHalfOpen: true });
  const state = { data: [], ended: false, closed: false, error: null };
  client.on('data', (c) => state.data.push(Buffer.from(c)));
  client.on('end', () => { state.ended = true; });
  client.on('close', () => { state.closed = true; });
  client.on('error', (e) => { state.error = e; });
  state.socket = client;
  state.text = () => Buffer.concat(state.data).toString('latin1');
  state.send = (s) => new Promise((resolve) => client.write(Buffer.from(s, 'latin1'), resolve));
  return state;
}

async function environment({ deviceDefinition = definition(), upstreamOverride = null, relayLimits = {} } = {}) {
  const device = createDeviceServer({});
  const deviceStart = await device.start({ definition: deviceDefinition, host: HOST, port: 0 });
  assert.equal(deviceStart.ok, true);
  const recorder = createRecorder({ now: monotonic });
  const events = [];
  const relay = createRelay({ recorder, onEvent: (e) => events.push(e), limits: relayLimits });
  const started = await relay.start({
    listenHost: HOST, listenPort: 0, upstreamHost: HOST, upstreamPort: upstreamOverride ?? deviceStart.port,
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  const clients = [];
  return {
    device, relay, recorder, events, relayPort: started.port, devicePort: deviceStart.port,
    connect() { const c = connectClient(started.port); clients.push(c); return c; },
    async close() {
      for (const c of clients) c.socket.destroy();
      await relay.stop();
      await device.stop();
    },
  };
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen({ host: HOST, port: 0 }, resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('greeting, fragmented request and reply pass through unchanged and are recorded', async () => {
  const env = await environment();
  try {
    const c = env.connect();
    await until(() => c.text() === 'READY\r', 'greeting');
    await c.send('ID');
    await sleep(40);
    await c.send('?\r');
    await until(() => c.text() === 'READY\rID A1\r', 'reply');
    const snapshot = env.recorder.snapshot();
    const joined = (dir) => Buffer.concat(snapshot.events.filter((e) => e.d === dir).map((e) => Buffer.from(e.bytes))).toString('latin1');
    assert.equal(joined('up'), 'ID?\r');
    assert.equal(joined('down'), 'READY\rID A1\r');
    assert.equal(validateRecording(JSON.parse(JSON.stringify({
      schemaVersion: 1,
      connections: snapshot.connections,
      events: snapshot.events.map((e) => ({ seq: e.seq, t: e.t, c: e.c, d: e.d, b64: Buffer.from(e.bytes).toString('base64') })),
    }))).ok, true, 'the live recording is a valid recording file');
  } finally {
    await env.close();
  }
});

test('the device behaviors survive the relay: delay, idle close, connection limit', async () => {
  const env = await environment();
  try {
    const first = env.connect();
    await until(() => first.text() === 'READY\r', 'first greeting');
    const sentAt = Date.now();
    await first.send('SLOW?\r');
    await until(() => first.text().endsWith('SLOW\r'), 'slow reply');
    assert.ok(Date.now() - sentAt >= 250, 'the 300 ms delay is not removed by the relay');

    // The device allows one controller: the second is greeted and then closed, as without a relay.
    const second = env.connect();
    await until(() => second.text() === 'READY\r' && second.ended, 'second greeted then closed');

    // Idle: the device closes after 1 s of silence and the relay passes the close on.
    await until(() => first.ended, 'idle close forwarded', 4000);
    first.socket.end();
    second.socket.end();
    await until(() => env.events.filter((e) => e.type === 'connection_closed').length >= 2, 'both pairs finished');
    assert.ok(env.events.some((e) => e.type === 'connection_closed' && e.reason === 'upstream_closed'));
    assert.equal(env.relay.getState().connections.length, 0);
  } finally {
    await env.close();
  }
});

test('a client FIN is passed on and the reply still arrives (half close)', async () => {
  const env = await environment();
  try {
    const c = env.connect();
    await until(() => c.text() === 'READY\r', 'greeting');
    await c.send('ID?\r');
    c.socket.end();
    await until(() => c.text() === 'READY\rID A1\r' && c.ended, 'reply then FIN');
    await until(() => c.closed, 'client socket closed');
  } finally {
    await env.close();
  }
});

test('an unreachable device closes the client and is reported', async () => {
  const dead = await freePort();
  const env = await environment({ upstreamOverride: dead });
  try {
    const c = env.connect();
    await c.send('ID?\r');
    await until(() => c.closed, 'client closed');
    await until(() => env.events.some((e) => e.type === 'connection_closed'), 'event');
    assert.equal(env.events.find((e) => e.type === 'connection_closed').reason, 'upstream_failed');
    assert.equal(env.recorder.snapshot().connections[0].closeReason, 'upstream_failed');
  } finally {
    await env.close();
  }
});

test('stop frees the port, and a relay cannot be pointed at itself', async () => {
  const env = await environment();
  const { relayPort } = env;
  await env.close();
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen({ host: HOST, port: relayPort }, resolve); });
  await new Promise((resolve) => probe.close(resolve));

  const port = await freePort();
  const relay = createRelay({ recorder: createRecorder({ now: monotonic }) });
  assert.deepEqual(
    await relay.start({ listenHost: HOST, listenPort: port, upstreamHost: 'localhost', upstreamPort: port }),
    { ok: false, code: 'loop' },
  );
  // The port was released again after the refused start.
  const check = net.createServer();
  await new Promise((resolve, reject) => { check.once('error', reject); check.listen({ host: HOST, port }, resolve); });
  await new Promise((resolve) => check.close(resolve));
});

// A raw TCP fixture that does not use the project's own device code: echoes, and on its FIN-from-
// the-peer says goodbye before closing (a device that answers after the controller half-closed).
function startEchoFixture() {
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    socket.on('error', () => {});
    socket.on('data', (chunk) => socket.write(chunk));
    socket.on('end', () => socket.end('BYE'));
  });
  return new Promise((resolve) => server.listen({ host: HOST, port: 0 }, () => resolve(server)));
}

test('raw fixture: bytes of 2 MiB come back identical through backpressure, then BYE after FIN', async () => {
  const fixture = await startEchoFixture();
  const recorder = createRecorder({ now: monotonic });
  const relay = createRelay({ recorder });
  const started = await relay.start({ listenHost: HOST, listenPort: 0, upstreamHost: HOST, upstreamPort: fixture.address().port });
  const c = connectClient(started.port);
  try {
    const payload = Buffer.alloc(2 * 1024 * 1024);
    let seed = 12345;
    for (let i = 0; i < payload.length; i += 1) { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; payload[i] = seed >>> 24; }
    await new Promise((resolve) => c.socket.write(payload, resolve));
    await until(() => Buffer.concat(c.data).length >= payload.length, 'echo of 2 MiB', 15000);
    assert.equal(Buffer.compare(Buffer.concat(c.data).subarray(0, payload.length), payload), 0);
    c.socket.end();
    await until(() => c.ended, 'FIN from the device side');
    assert.equal(Buffer.concat(c.data).subarray(payload.length).toString('latin1'), 'BYE');
    const snap = recorder.snapshot();
    const total = (dir) => snap.events.filter((e) => e.d === dir).reduce((n, e) => n + e.bytes.length, 0);
    assert.equal(total('up'), payload.length);
    assert.equal(total('down'), payload.length + 3);
  } finally {
    c.socket.destroy();
    await relay.stop();
    await new Promise((resolve) => fixture.close(resolve));
  }
});

test('one lap: record against device A, draft a definition, run it as device B, compare', async () => {
  const env = await environment();
  const requests = ['ID?', 'VER?', 'MUTE 1', 'ID?', 'VER?'];
  try {
    for (let session = 0; session < 2; session += 1) {
      const c = env.connect();
      await until(() => c.text().startsWith('READY\r'), `greeting ${session}`);
      for (const request of requests) {
        const before = c.text().length;
        await c.send(`${request}\r`);
        if (request !== 'MUTE 1') await until(() => c.text().length > before, `reply to ${request}`);
        await sleep(120); // longer than quietMs below: one request at a time
      }
      c.socket.end();
      await until(() => c.closed, `session ${session} closed`);
      await until(() => env.events.filter((e) => e.type === 'connection_closed').length === session + 1, 'pair finished');
    }
    const recording = validateRecording(JSON.parse(JSON.stringify({
      schemaVersion: 1,
      connections: env.recorder.snapshot().connections,
      events: env.recorder.snapshot().events.map((e) => ({
        seq: e.seq, t: Math.round(e.t), c: e.c, d: e.d, b64: Buffer.from(e.bytes).toString('base64'),
      })),
    })));
    assert.equal(recording.ok, true, JSON.stringify(recording.errors));

    const draft = draftDefinition(recording.recording, { quietMs: 50 });
    assert.deepEqual(draft.json.commands.map((x) => x.pattern).sort(), ['ID?', 'MUTE 1', 'VER?']);
    assert.equal(draft.json.greeting, 'READY[CR]');
    assert.equal(replayCheck(draft, recording.recording).failures.length, 0);
    const holdout = evaluateHoldout(recording.recording, { quietMs: 50 });
    assert.equal(holdout.evaluable, true);
    assert.equal(holdout.rate, 1, JSON.stringify(holdout));

    // Device B runs from the draft; talking to it directly must match what device A said.
    const deviceB = createDeviceServer({});
    const startB = await deviceB.start({ definition: draft.definition, host: HOST, port: 0 });
    assert.equal(startB.ok, true);
    const b = connectClient(startB.port);
    try {
      await until(() => b.text() === 'READY\r', 'B greeting');
      for (const request of ['ID?', 'VER?', 'MUTE 1']) {
        const before = b.text().length;
        await b.send(`${request}\r`);
        await sleep(60);
        const got = b.text().slice(before);
        const expected = { 'ID?': 'ID A1\r', 'VER?': 'VER 2.0\r\n', 'MUTE 1': '' }[request];
        assert.equal(got, expected, request);
      }
    } finally {
      b.socket.destroy();
      await deviceB.stop();
    }
  } finally {
    await env.close();
  }
});

test('raw fixture: a slow reader still gets every byte, then the FIN, in order', async () => {
  const total = 3 * 1024 * 1024;
  const payload = Buffer.alloc(total);
  for (let i = 0; i < total; i += 1) payload[i] = (i * 7 + (i >> 8)) & 0xff;
  // The device sends everything at once and closes: the relay must not drop the tail on FIN.
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    socket.on('error', () => {});
    socket.end(payload);
  });
  await new Promise((resolve) => server.listen({ host: HOST, port: 0 }, resolve));
  const relay = createRelay({ recorder: createRecorder({ now: monotonic }) });
  const started = await relay.start({ listenHost: HOST, listenPort: 0, upstreamHost: HOST, upstreamPort: server.address().port });
  const chunks = [];
  let ended = false;
  const client = net.connect({ host: HOST, port: started.port, allowHalfOpen: true });
  client.pause(); // a reader that is not reading
  client.on('data', (c) => chunks.push(c));
  client.on('end', () => { ended = true; });
  client.on('error', () => {});
  try {
    await sleep(300); // the relay has to hold back: nothing may be lost while the client is paused
    assert.equal(ended, false);
    client.resume();
    await until(() => ended, 'FIN after all data', 15000);
    assert.equal(Buffer.compare(Buffer.concat(chunks), payload), 0, 'all bytes, in order, before the FIN');
  } finally {
    client.destroy();
    await relay.stop();
    await new Promise((resolve) => server.close(resolve));
  }
});
