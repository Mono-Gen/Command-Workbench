// Relay tests with fake sockets and a fake clock: every path is driven by the test, nothing waits.
const test = require('node:test');
const assert = require('node:assert/strict');

const { createRelay, classifyAddress } = require('../../src/main/relay');
const { createRecorder } = require('../../src/core/recording');
const { createFakeClock, FakeSocket, flush } = require('../helpers/fakes');
const { FakeServer } = require('../helpers/fake-server');

// A socket where end() only half-closes (like a real one with allowHalfOpen); destroy() closes.
class Sock extends FakeSocket {
  constructor() {
    super();
    this.paused = false;
    this.pauseCalls = 0;
    this.resumeCalls = 0;
    this.heldCallbacks = null; // when an array, write callbacks wait here instead of firing
  }

  write(buffer, callback) {
    this.written.push(Uint8Array.from(buffer));
    if (this.heldCallbacks) this.heldCallbacks.push(callback);
    else queueMicrotask(() => callback(this.writeError));
    return true;
  }

  end() { this.ended = true; }

  pause() { this.paused = true; this.pauseCalls += 1; }

  resume() { this.paused = false; this.resumeCalls += 1; }

  setNoDelay() {}
}

const bytes = (text) => Uint8Array.from(Buffer.from(text, 'latin1'));
const text = (u8) => Buffer.from(u8).toString('latin1');
const concat = (list) => text(Buffer.concat(list.map((u) => Buffer.from(u))));

function setup({ resolve, limits = {}, locals = ['10.0.0.5'], serverOptions = {}, recorderLimits } = {}) {
  const clock = createFakeClock();
  const events = [];
  const servers = [];
  const upstreams = [];
  const resolveCalls = [];
  const recorder = createRecorder({ now: clock.now, limits: recorderLimits });
  const relay = createRelay({
    createServer: (handler) => { const s = new FakeServer(handler, serverOptions); servers.push(s); return s; },
    createUpstreamSocket: () => { const s = new Sock(); upstreams.push(s); return s; },
    resolveHost: (host) => { resolveCalls.push(host); return resolve ? resolve(host) : ['10.0.0.20']; },
    localAddresses: () => locals,
    recorder,
    scheduler: clock.scheduler,
    now: clock.now,
    onEvent: (e) => events.push(e),
    limits,
  });
  const accept = () => {
    const client = servers[0].accept();
    // FakeServer builds a FakeSocket; give it the half-open behavior of a real one.
    return client;
  };
  return { relay, clock, events, servers, upstreams, recorder, resolveCalls, accept };
}

const OPTIONS = { listenHost: '127.0.0.1', listenPort: 0, upstreamHost: '10.0.0.20', upstreamPort: 5000 };

async function started(options = {}) {
  const env = setup(options);
  const result = await env.relay.start(OPTIONS);
  assert.equal(result.ok, true, JSON.stringify(result));
  return env;
}

// Replaces the server's socket factory so accepted client sockets are Sock instances.
function connectPair(env) {
  const client = new Sock();
  client.remoteAddress = '10.0.0.99';
  client.remotePort = 41000;
  env.servers[0].handler(client);
  const upstream = env.upstreams.at(-1);
  return { client, upstream };
}

test('classifyAddress allows only loopback and private LAN addresses', () => {
  const allowed = {
    '127.0.0.1': 'loopback', '127.9.9.9': 'loopback', '::1': 'loopback', '::ffff:127.0.0.1': 'loopback',
    '10.0.0.3': 'private', '172.16.0.1': 'private', '172.31.255.255': 'private', '192.168.0.1': 'private', // scan-ok: the 192.168/16 range itself is under test
    'fd12:3456::1': 'private', 'fc00::1': 'private', '::ffff:10.0.0.1': 'private', '::ffff:c0a8:0101': 'private',
  };
  for (const [ip, kind] of Object.entries(allowed)) assert.equal(classifyAddress(ip), kind, ip);
  const refused = ['8.8.8.8', '172.15.0.1', '172.32.0.1', '169.254.169.254', '0.0.0.0', '224.0.0.1',
    '255.255.255.255', '192.169.0.1', '::', 'fe80::1', 'ff02::1', '2001:db8::1', '::ffff:8.8.8.8',
    '::ffff:a9fe:a9fe', 'fe80::1%eth0', 'example.com', '', null, 5];
  for (const ip of refused) assert.equal(classifyAddress(ip), null, String(ip));
});

test('start validates its arguments', async () => {
  const bad = [
    [{ ...OPTIONS, listenHost: 'localhost' }, 'invalid_host'],
    [{ ...OPTIONS, listenPort: 80 }, 'invalid_port'],
    [{ ...OPTIONS, listenPort: 70000 }, 'invalid_port'],
    [{ ...OPTIONS, upstreamHost: '' }, 'invalid_upstream_host'],
    [{ ...OPTIONS, upstreamHost: 'a b' }, 'invalid_upstream_host'],
    [{ ...OPTIONS, upstreamHost: 'x'.repeat(254) }, 'invalid_upstream_host'],
    [{ ...OPTIONS, upstreamHost: 'a\nb' }, 'invalid_upstream_host'],
    [{ ...OPTIONS, upstreamPort: 0 }, 'invalid_upstream_port'],
    [{ ...OPTIONS, upstreamPort: 65536 }, 'invalid_upstream_port'],
    [null, 'invalid_arguments'],
  ];
  for (const [options, code] of bad) {
    const { relay } = setup();
    assert.deepEqual(await relay.start(options), { ok: false, code });
  }
});

test('the upstream is resolved once, pinned, and every answer must be allowed', async () => {
  let env = setup({ resolve: () => ['10.0.0.20', '10.0.0.7'] });
  let result = await env.relay.start({ ...OPTIONS, upstreamHost: 'player.local' });
  assert.equal(result.ok, true);
  assert.equal(result.upstreamAddress, '10.0.0.20');
  const { upstream } = connectPair(env);
  assert.deepEqual(upstream.connectArgs, { host: '10.0.0.20', port: 5000 });
  connectPair(env);
  assert.equal(env.resolveCalls.length, 1, 'no re-resolution per connection');

  env = setup({ resolve: () => ['10.0.0.20', '8.8.8.8'] });
  result = await env.relay.start({ ...OPTIONS, upstreamHost: 'mixed.example' });
  assert.deepEqual(result, { ok: false, code: 'upstream_not_allowed' });
  assert.equal(env.servers.length, 0, 'nothing is opened for a refused target');

  for (const answers of [['169.254.169.254'], ['93.184.216.34'], [], 'nope']) {
    env = setup({ resolve: () => answers });
    result = await env.relay.start(OPTIONS);
    assert.equal(result.ok, false);
    assert.match(result.code, /upstream_(not_allowed|unresolved)/);
  }

  env = setup({ resolve: () => { throw new Error('nxdomain'); } });
  assert.deepEqual(await env.relay.start(OPTIONS), { ok: false, code: 'upstream_unresolved' });
  env = setup({ resolve: () => new Promise(() => {}) });
  const pending = env.relay.start(OPTIONS);
  await flush();
  env.clock.advance(5000);
  assert.deepEqual(await pending, { ok: false, code: 'upstream_unresolved' });
  assert.equal(env.relay.getState().running, false);
});

test('the relay refuses to forward to itself', async () => {
  // The fake server reports port 5555 as the real listening port (like port 0 resolved by the OS).
  for (const upstreamHost of ['127.0.0.1', '10.0.0.5']) {
    const env = setup({ serverOptions: { port: 5555 }, resolve: (h) => [h] });
    const result = await env.relay.start({ ...OPTIONS, upstreamHost, upstreamPort: 5555 });
    assert.deepEqual(result, { ok: false, code: 'loop' }, upstreamHost);
    assert.equal(env.servers[0].closed, true, 'the port is released again');
    assert.equal(env.relay.getState().running, false);
  }
  // Same host, different port: fine. Another machine on the same port: fine.
  let env = setup({ serverOptions: { port: 5555 }, resolve: (h) => [h] });
  assert.equal((await env.relay.start({ ...OPTIONS, upstreamHost: '127.0.0.1', upstreamPort: 5556 })).ok, true);
  env = setup({ serverOptions: { port: 5555 }, resolve: (h) => [h] });
  assert.equal((await env.relay.start({ ...OPTIONS, upstreamHost: '10.0.0.20', upstreamPort: 5555 })).ok, true);
  // IPv4-mapped IPv6 spelling of a local address is the same address.
  env = setup({ serverOptions: { port: 5555 }, resolve: () => ['::ffff:10.0.0.5'] });
  assert.deepEqual(await env.relay.start({ ...OPTIONS, upstreamHost: 'x.local', upstreamPort: 5555 }), { ok: false, code: 'loop' });
});

test('bytes are forwarded unchanged in both directions and recorded', async () => {
  const env = await started();
  const { client, upstream } = connectPair(env);
  upstream.emit('connect');
  client.emit('data', Buffer.from('PWR ?\r'));
  await flush();
  assert.equal(concat(upstream.written), 'PWR ?\r');
  upstream.emit('data', Buffer.from('PWR 0\r'));
  upstream.emit('data', Buffer.from([0x00, 0xff, 0x80]));
  await flush();
  assert.equal(concat(client.written), 'PWR 0\r\x00\xff\x80');
  const snapshot = env.recorder.snapshot();
  assert.deepEqual(snapshot.events.map((e) => [e.d, text(e.bytes)]), [
    ['up', 'PWR ?\r'], ['down', 'PWR 0\r'], ['down', '\x00\xff\x80'],
  ]);
  assert.equal(env.relay.getState().connections.length, 1);
  assert.equal(env.relay.getState().connections[0].state, 'open');
});

test('data sent before the upstream is open is held and written first, in order', async () => {
  const env = await started();
  const { client, upstream } = connectPair(env);
  client.emit('data', Buffer.from('A'));
  client.emit('data', Buffer.from('B'));
  await flush();
  assert.equal(upstream.written.length, 0);
  assert.equal(env.relay.getState().connections[0].state, 'connecting');
  upstream.emit('connect');
  client.emit('data', Buffer.from('C'));
  await flush();
  assert.equal(concat(upstream.written), 'ABC');
});

test('a client that floods before the upstream opens is paused, then resumed', async () => {
  const env = await started();
  const { client, upstream } = connectPair(env);
  client.emit('data', Buffer.alloc(64 * 1024, 0x41));
  assert.equal(client.paused, true);
  assert.equal(client.pauseCalls, 1);
  upstream.emit('connect');
  await flush();
  assert.equal(upstream.written.reduce((n, u) => n + u.length, 0), 64 * 1024);
  assert.equal(client.paused, false);
});

test('a FIN before the upstream opens is forwarded after the held data', async () => {
  const env = await started();
  const { client, upstream } = connectPair(env);
  client.emit('data', Buffer.from('LAST\r'));
  client.emit('end');
  assert.equal(upstream.ended, false);
  upstream.emit('connect');
  assert.equal(upstream.ended, false, 'not until the held write completed');
  await flush();
  assert.equal(concat(upstream.written), 'LAST\r');
  assert.equal(upstream.ended, true);
});

test('half close: the reply still reaches a client that already sent its FIN', async () => {
  const env = await started();
  const { client, upstream } = connectPair(env);
  upstream.emit('connect');
  client.emit('data', Buffer.from('GET\r'));
  client.emit('end');
  await flush();
  assert.equal(upstream.ended, true);
  assert.equal(client.destroyed, false, 'the client side stays usable for the reply');
  upstream.emit('data', Buffer.from('VAL\r'));
  upstream.emit('end');
  await flush();
  assert.equal(concat(client.written), 'VAL\r');
  assert.equal(client.ended, true);
  client.emit('close');
  upstream.emit('close');
  await flush();
  const closed = env.events.find((e) => e.type === 'connection_closed');
  assert.equal(closed.reason, 'client_closed');
  assert.equal(env.relay.getState().connections.length, 0);
  assert.equal(env.recorder.snapshot().connections[0].closeReason, 'client_closed');
  assert.equal(env.clock.pendingTimers(), 0);
});

test('a FIN waits for earlier writes of the same direction', async () => {
  const env = await started();
  const { client, upstream } = connectPair(env);
  upstream.emit('connect');
  upstream.heldCallbacks = [];
  client.emit('data', Buffer.from('X\r'));
  client.emit('end');
  assert.equal(upstream.ended, false);
  upstream.heldCallbacks.shift()(null);
  assert.equal(upstream.ended, true);
});

test('the device closing first is reported as upstream_closed', async () => {
  const env = await started();
  const { client, upstream } = connectPair(env);
  upstream.emit('connect');
  upstream.emit('end');
  await flush();
  assert.equal(client.ended, true);
  upstream.emit('close');
  client.emit('close');
  const closed = env.events.find((e) => e.type === 'connection_closed');
  assert.equal(closed.reason, 'upstream_closed');
});

test('a client that never closes after the device finished does not hold the slot forever', async () => {
  const env = await started();
  const { client, upstream } = connectPair(env);
  upstream.emit('connect');
  upstream.emit('end');
  await flush();
  assert.equal(client.ended, true);
  env.clock.advance(59999);
  assert.equal(client.destroyed, false);
  env.clock.advance(1);
  await flush();
  assert.equal(client.destroyed, true);
  // The first cause (the device closed) stays the reported reason.
  assert.equal(env.events.find((e) => e.type === 'connection_closed').reason, 'upstream_closed');
});

test('a client that finished first may keep reading without a time limit', async () => {
  const env = await started();
  const { client, upstream } = connectPair(env);
  upstream.emit('connect');
  client.emit('end');
  await flush();
  env.clock.advance(10 * 60 * 1000);
  assert.equal(upstream.destroyed, false);
  assert.equal(client.destroyed, false);
});

test('an upstream that cannot be reached closes the client and reports upstream_failed', async () => {
  const env = await started();
  const { client, upstream } = connectPair(env);
  client.emit('data', Buffer.from('HELLO\r'));
  upstream.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
  await flush();
  assert.equal(client.destroyed, true);
  assert.equal(upstream.destroyed, true);
  const closed = env.events.find((e) => e.type === 'connection_closed');
  assert.equal(closed.reason, 'upstream_failed');
  assert.equal(closed.detail, 'ECONNREFUSED');
  assert.equal(env.recorder.snapshot().connections[0].closeReason, 'upstream_failed');
  assert.equal(env.clock.pendingTimers(), 0);
});

test('a slow upstream connection times out', async () => {
  const env = await started();
  const { client } = connectPair(env);
  env.clock.advance(4999);
  assert.equal(client.destroyed, false);
  env.clock.advance(1);
  await flush();
  assert.equal(client.destroyed, true);
  assert.equal(env.events.find((e) => e.type === 'connection_closed').detail, 'connect_timeout');
});

test('an error after the connection is open is reported as error and tears both sides down', async () => {
  const env = await started();
  const { client, upstream } = connectPair(env);
  upstream.emit('connect');
  client.emit('error', Object.assign(new Error('reset'), { code: 'ECONNRESET' }));
  await flush();
  assert.equal(upstream.destroyed, true);
  assert.equal(env.events.find((e) => e.type === 'connection_closed').reason, 'error');
});

test('backpressure is per direction and always released', async () => {
  const env = await started();
  const { client, upstream } = connectPair(env);
  upstream.emit('connect');
  upstream.heldCallbacks = [];
  client.heldCallbacks = [];
  client.emit('data', Buffer.alloc(300 * 1024, 1)); // up is now blocked
  assert.equal(client.paused, true, 'the source of the blocked direction is paused');
  assert.equal(upstream.paused, false, 'the other direction is not');
  upstream.emit('data', Buffer.alloc(300 * 1024, 2)); // down blocked too: no deadlock, both wait
  assert.equal(upstream.paused, true);
  upstream.heldCallbacks.shift()(null); // up drains
  assert.equal(client.paused, false);
  assert.equal(upstream.paused, true, 'down is still blocked');
  client.heldCallbacks.shift()(null);
  assert.equal(upstream.paused, false);
});

test('a backlog over the limit cuts the pair off', async () => {
  const env = await started();
  const { client, upstream } = connectPair(env);
  upstream.emit('connect');
  upstream.heldCallbacks = [];
  for (let i = 0; i < 5; i += 1) client.emit('data', Buffer.alloc(256 * 1024, 1));
  await flush();
  assert.equal(client.destroyed, true);
  const closed = env.events.find((e) => e.type === 'connection_closed');
  assert.equal(closed.reason, 'limit');
  assert.equal(closed.detail, 'backlog');
});

test('a peer that never reads is cut off by the write deadline', async () => {
  const env = await started();
  const { client, upstream } = connectPair(env);
  upstream.emit('connect');
  upstream.heldCallbacks = [];
  client.emit('data', Buffer.from('X'));
  env.clock.advance(10000);
  await flush();
  assert.equal(client.destroyed, true);
  const closed = env.events.find((e) => e.type === 'connection_closed');
  assert.equal(closed.detail, 'write_timeout');
  assert.equal(env.recorder.snapshot().connections[0].closeReason, 'limit', 'recording uses its fixed reason list');
});

test('a write error tears the pair down', async () => {
  const env = await started();
  const { client, upstream } = connectPair(env);
  upstream.emit('connect');
  upstream.writeError = new Error('EPIPE');
  client.emit('data', Buffer.from('X'));
  await flush();
  assert.equal(client.destroyed, true);
  assert.equal(env.events.find((e) => e.type === 'connection_closed').detail, 'write_error');
});

test('both sockets of every pair, and refused sockets, get an error listener at once', async () => {
  const env = await started({ limits: { maxPairs: 1 } });
  const { client, upstream } = connectPair(env);
  assert.ok(client.listenerCount('error') > 0);
  assert.ok(upstream.listenerCount('error') > 0);
  const refused = new Sock();
  env.servers[0].handler(refused);
  assert.ok(refused.listenerCount('error') > 0, 'a refused socket must not crash on a reset');
  assert.equal(refused.destroyed, true);
  assert.doesNotThrow(() => refused.emit('error', new Error('ECONNRESET')));
  assert.doesNotThrow(() => upstream.emit('error', new Error('late')));
});

test('pair and accept-rate limits', async () => {
  let env = await started({ limits: { maxPairs: 2 } });
  connectPair(env);
  connectPair(env);
  const third = new Sock();
  env.servers[0].handler(third);
  assert.equal(third.destroyed, true);
  assert.deepEqual(env.events.filter((e) => e.type === 'refused').map((e) => e.reason), ['limit']);

  env = await started({ limits: { acceptsPerSecond: 3, maxPairs: 100 } });
  for (let i = 0; i < 10; i += 1) env.servers[0].handler(new Sock());
  assert.equal(env.events.filter((e) => e.type === 'refused' && e.reason === 'rate_limit').length, 1, 'reported once per window');
  assert.equal(env.relay.getState().connections.length, 3);
  env.clock.advance(1000);
  env.servers[0].handler(new Sock());
  assert.equal(env.relay.getState().connections.length, 4);
});

test('stop closes every pair, waits for the port, and ignores late events', async () => {
  const env = await started();
  const { client, upstream } = connectPair(env);
  upstream.emit('connect');
  env.servers[0].autoClose = false;
  const stopping = env.relay.stop();
  await flush();
  assert.equal(client.destroyed, true);
  assert.equal(upstream.destroyed, true);
  assert.deepEqual(await Promise.race([stopping, flush().then(() => 'pending')]), 'pending');
  assert.equal((await env.relay.start(OPTIONS)).code, 'busy');
  env.servers[0].closeCallback();
  assert.deepEqual(await stopping, { ok: true });
  assert.doesNotThrow(() => { client.emit('data', Buffer.from('late')); upstream.emit('data', Buffer.from('late')); });
  assert.equal(env.events.find((e) => e.type === 'connection_closed').reason, 'stop');
  assert.equal((await env.relay.start(OPTIONS)).ok, true, 'the port can be used again');
});

test('a stop during a start cancels it and releases the port', async () => {
  let release;
  let calls = 0;
  const env = setup({ resolve: () => (calls++ === 0 ? new Promise((resolve) => { release = resolve; }) : ['10.0.0.20']) });
  const starting = env.relay.start(OPTIONS);
  await flush();
  const stopping = env.relay.stop();
  release(['10.0.0.20']);
  assert.deepEqual(await starting, { ok: false, code: 'cancelled' });
  assert.deepEqual(await stopping, { ok: true });
  assert.equal(env.relay.getState().running, false);
  assert.equal((await env.relay.start(OPTIONS)).ok, true);
});

test('a listen failure is reported and does not leave the relay busy', async () => {
  const env = setup({ serverOptions: { failWith: 'EADDRINUSE' } });
  assert.deepEqual(await env.relay.start(OPTIONS), { ok: false, code: 'listen_failed', errno: 'EADDRINUSE' });
  assert.equal(env.relay.getState().lifecycle, 'idle');
});

test('a full recording keeps forwarding and says so once', async () => {
  const env = await started();
  const { client, upstream } = connectPair(env);
  upstream.emit('connect');
  // Fill the recorder (8 MiB) with large chunks that also pass through the relay.
  const chunk = Buffer.alloc(65536, 7);
  for (let i = 0; i < 130; i += 1) {
    client.emit('data', chunk);
    await flush();
  }
  assert.equal(env.events.filter((e) => e.type === 'recording_full').length, 1);
  assert.equal(env.recorder.stats().truncated, true);
  const before = upstream.written.length;
  client.emit('data', Buffer.from('STILL FORWARDED'));
  await flush();
  assert.equal(upstream.written.length, before + 1, 'forwarding is not affected by a full recording');
});

test('a throwing event listener cannot break forwarding', async () => {
  const errors = [];
  const clock = createFakeClock();
  const upstreams = [];
  const servers = [];
  const relay = createRelay({
    createServer: (h) => { const s = new FakeServer(h); servers.push(s); return s; },
    createUpstreamSocket: () => { const s = new Sock(); upstreams.push(s); return s; },
    resolveHost: () => ['10.0.0.20'],
    localAddresses: () => [],
    recorder: createRecorder({ now: clock.now }),
    scheduler: clock.scheduler,
    now: clock.now,
    onEvent: () => { throw new Error('boom'); },
    onListenerError: (e) => errors.push(e),
  });
  assert.equal((await relay.start(OPTIONS)).ok, true);
  const client = new Sock();
  servers[0].handler(client);
  upstreams[0].emit('connect');
  client.emit('data', Buffer.from('X'));
  await flush();
  assert.equal(concat(upstreams[0].written), 'X');
  assert.ok(errors.length > 0);
});

test('clearing the recording while pairs live does not mix up their ids or their data', async () => {
  const env = await started();
  const a = connectPair(env);
  a.upstream.emit('connect');
  a.client.emit('data', Buffer.from('A1'));
  env.recorder.clear();
  const b = connectPair(env); // the recorder hands out id 1 again
  b.upstream.emit('connect');
  a.client.emit('data', Buffer.from('A2'));
  b.client.emit('data', Buffer.from('B1'));
  await flush();
  const state = env.relay.getState().connections;
  assert.equal(new Set(state.map((c) => c.id)).size, 2, 'pair ids are unique');
  assert.deepEqual(env.recorder.snapshot().events.map((e) => text(e.bytes)), ['B1'], 'old pair is not recorded into the new recording');
  a.client.emit('end');
  a.upstream.emit('end');
  a.client.emit('close');
  a.upstream.emit('close');
  await flush();
  assert.equal(env.relay.getState().connections.length, 1, 'the new pair is still listed');
  assert.equal(env.recorder.snapshot().connections[0].closedAt, null, 'the old pair did not close the new connection');
  const stopping = env.relay.stop();
  await flush();
  assert.equal(b.client.destroyed, true, 'stop reaches the remaining pair');
  await stopping;
});

test('an observer cannot change the bytes that are forwarded', async () => {
  const clock = createFakeClock();
  const upstreams = [];
  const servers = [];
  const relay = createRelay({
    createServer: (h) => { const s = new FakeServer(h); servers.push(s); return s; },
    createUpstreamSocket: () => { const s = new Sock(); upstreams.push(s); return s; },
    resolveHost: () => ['10.0.0.20'],
    localAddresses: () => [],
    recorder: createRecorder({ now: clock.now }),
    scheduler: clock.scheduler,
    now: clock.now,
    onEvent: (e) => { if (e.type === 'data') e.bytes[0] = 0x58; },
  });
  await relay.start(OPTIONS);
  const client = new Sock();
  servers[0].handler(client);
  upstreams[0].emit('connect');
  client.emit('data', Buffer.from('ABC'));
  await flush();
  assert.equal(concat(upstreams[0].written), 'ABC');
});

test('two stops during a start both finish', async () => {
  let release;
  let calls = 0;
  const env = setup({ resolve: () => (calls++ === 0 ? new Promise((resolve) => { release = resolve; }) : ['10.0.0.20']) });
  const starting = env.relay.start(OPTIONS);
  await flush();
  const first = env.relay.stop();
  const second = env.relay.stop();
  release(['10.0.0.20']);
  assert.deepEqual(await starting, { ok: false, code: 'cancelled' });
  assert.deepEqual(await first, { ok: true });
  assert.deepEqual(await second, { ok: true });
});

test('a recording that stops accepting connections is announced once per recording', async () => {
  const env = await started({ recorderLimits: { MAX_CONNECTIONS: 1 } });
  connectPair(env);
  assert.equal(env.events.filter((e) => e.type === 'recording_full').length, 0);
  const second = connectPair(env); // the recorder refuses a second connection, forwarding still works
  second.upstream.emit('connect');
  second.client.emit('data', Buffer.from('X'));
  await flush();
  assert.equal(concat(second.upstream.written), 'X');
  assert.equal(env.events.filter((e) => e.type === 'recording_full').length, 1);
  connectPair(env);
  assert.equal(env.events.filter((e) => e.type === 'recording_full').length, 1, 'not repeated');
  env.recorder.clear();
  connectPair(env);
  connectPair(env);
  assert.equal(env.events.filter((e) => e.type === 'recording_full').length, 2, 'announced again for the next recording');
});

test('hostnames with hyphens and underscores are accepted', async () => {
  for (const upstreamHost of ['av-receiver.local', 'my_device', 'fd12::1']) {
    const env = setup({ resolve: () => ['10.0.0.20'] });
    assert.equal((await env.relay.start({ ...OPTIONS, upstreamHost })).ok, true, upstreamHost);
  }
});

test('listening on all interfaces asks first, with the pinned target; loopback does not ask', async () => {
  let asked = null;
  let env = setup();
  let result = await env.relay.start({ ...OPTIONS, listenHost: '0.0.0.0' }, {
    beforeListen: async (info) => { asked = info; return true; },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(asked, { upstreamAddress: '10.0.0.20', upstreamPort: 5000 });

  asked = null;
  env = setup();
  result = await env.relay.start(OPTIONS, { beforeListen: async (info) => { asked = info; return true; } });
  assert.equal(result.ok, true);
  assert.equal(asked, null);

  env = setup();
  result = await env.relay.start({ ...OPTIONS, listenHost: '0.0.0.0' }, { beforeListen: async () => false });
  assert.deepEqual(result, { ok: false, code: 'cancelled' });
  assert.equal(env.servers.length, 0, 'nothing listens after a refusal');
  assert.equal(env.relay.getState().lifecycle, 'idle');

  env = setup();
  result = await env.relay.start({ ...OPTIONS, listenHost: '0.0.0.0' }, { beforeListen: async () => { throw new Error('boom'); } });
  assert.deepEqual(result, { ok: false, code: 'cancelled' }, 'a failing hook counts as a refusal');

  // A stop while the question is open cancels the start even if the answer is yes.
  let answer;
  env = setup();
  const starting = env.relay.start({ ...OPTIONS, listenHost: '0.0.0.0' }, { beforeListen: () => new Promise((resolve) => { answer = resolve; }) });
  await flush();
  const stopping = env.relay.stop();
  answer(true);
  assert.deepEqual(await starting, { ok: false, code: 'cancelled' });
  await stopping;
  assert.equal(env.servers.length, 0);
});

test('listening on all interfaces without a way to ask is refused', async () => {
  const env = setup();
  assert.deepEqual(await env.relay.start({ ...OPTIONS, listenHost: '0.0.0.0' }), { ok: false, code: 'confirmation_required' });
  assert.deepEqual(await env.relay.start({ ...OPTIONS, listenHost: '0.0.0.0' }, { beforeListen: 'yes' }), { ok: false, code: 'confirmation_required' });
  assert.equal(env.servers.length, 0);
  assert.equal((await env.relay.start(OPTIONS)).ok, true, 'loopback needs no question');
});
