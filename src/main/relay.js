// The relay role: a transparent TCP proxy between a controller and a real device that records
// both directions.
//
// Rules (see the Phase 3 plan, sections 4 and 13):
//  - Bytes are forwarded unchanged and in order, per direction. Chunk boundaries and timing are NOT
//    promised (TCP does not keep them); the recording is what THE RELAY observed.
//  - Both sockets of a pair are half-open capable. Each direction has its own state (FIN seen, FIN
//    forwarded, bytes waiting to be written, paused source), so one slow direction never blocks the
//    other and a FIN is only forwarded after everything before it was written.
//  - The upstream address is resolved ONCE, checked (loopback or private LAN only, never the relay
//    itself) and pinned: a hostile name cannot turn the relay into a tool against other networks.
//  - Data the client sends while the upstream connection is still being made is held (bounded) and
//    written first once it is open; a FIN in that window is forwarded after it.
//  - The first terminal cause of a pair wins and is reported once. Every socket gets an 'error'
//    listener before anything else (an unhandled 'error' would crash the main process).
//  - Start/stop carry a generation id; a stop during a start cancels it and waits for the port.
// Sockets, the server factory, DNS, the list of local addresses, the clock and the scheduler are
// injected so every path can be tested without a network.
const net = require('node:net');
const dns = require('node:dns');
const os = require('node:os');
const { classifyAddress, canonicalAddress } = require('../core/address-policy');

const ALLOWED_LISTEN_HOSTS = ['127.0.0.1', '0.0.0.0'];

const DEFAULT_LIMITS = {
  maxPairs: 8,
  acceptsPerSecond: 10,
  resolveTimeoutMs: 5000,
  connectTimeoutMs: 5000,
  // Safety limit, not part of "transparency": a peer that does not read for this long is cut off.
  writeTimeoutMs: 10000,
  // Client bytes held while the upstream connection is being made.
  preConnectMaxBytes: 64 * 1024,
  // Unwritten bytes per direction: pause the source here, cut the pair off at the maximum.
  pauseAtBytes: 256 * 1024,
  maxPendingBytes: 1024 * 1024,
  // After both FINs were forwarded the sockets should close by themselves.
  closeGraceMs: 5000,
  // The device closed its side but the client never closed its own (an idle slot would stay taken).
  halfOpenMs: 60000,
};

const isValidPort = (port) => Number.isInteger(port) && (port === 0 || (port >= 1024 && port <= 65535));

function defaultLocalAddresses() {
  const out = ['127.0.0.1', '::1'];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const entry of list || []) out.push(entry.address.split('%')[0]);
  }
  return out;
}

async function defaultResolve(host) {
  if (net.isIP(host)) return [host];
  const found = await dns.promises.lookup(host, { all: true, verbatim: true });
  return found.map((entry) => entry.address);
}

const HOST_PATTERN = /^[A-Za-z0-9._:-]+$/;

function createRelay({
  createServer = (handler) => net.createServer({ allowHalfOpen: true }, handler),
  createUpstreamSocket = () => new net.Socket({ allowHalfOpen: true }),
  resolveHost = defaultResolve,
  localAddresses = defaultLocalAddresses,
  recorder,
  scheduler = { setTimeout, clearTimeout },
  now = Date.now,
  onEvent = () => {},
  onListenerError = (error) => console.error('[relay] event listener failed:', error),
  limits = {},
} = {}) {
  if (!recorder || typeof recorder.addChunk !== 'function') throw new TypeError('recorder is required');
  const lim = { ...DEFAULT_LIMITS, ...limits };
  let generation = 0;
  let lifecycle = 'idle'; // idle | starting | running | stopping
  let run = null;
  let startingRun = null;
  let stopPromise = null;
  // Pair ids belong to the relay; the recorder's ids only name connections inside one recording.
  let nextPairId = 1;

  function emit(event) {
    try {
      onEvent({ t: now(), generation: run ? run.generation : generation, ...event });
    } catch (error) {
      onListenerError(error);
    }
  }

  const clear = (timer) => { if (timer) scheduler.clearTimeout(timer); };

  // ---- pairs ----------------------------------------------------------------------------

  const newDirection = () => ({
    finSeen: false, finForwarded: false, pending: 0, blocked: false, writeTimer: null, bytes: 0,
  });
  const srcOf = (pair, name) => (name === 'up' ? pair.client : pair.upstream);
  const dstOf = (pair, name) => (name === 'up' ? pair.upstream : pair.client);

  // The first terminal cause wins.
  function settle(pair, cause, detail) {
    if (pair.cause === null) {
      pair.cause = cause;
      pair.detail = detail ?? null;
    }
  }

  function destroySocket(socket) {
    try { socket.destroy(); } catch { /* already gone */ }
  }

  function teardown(pair, cause, detail) {
    settle(pair, cause, detail);
    pair.torn = true;
    clear(pair.connectTimer);
    clear(pair.graceTimer);
    pair.connectTimer = null;
    pair.graceTimer = null;
    for (const name of ['up', 'down']) {
      clear(pair.dir[name].writeTimer);
      pair.dir[name].writeTimer = null;
    }
    pair.pre.length = 0;
    destroySocket(pair.client);
    destroySocket(pair.upstream);
  }

  // The recording may have been cleared while a pair lives: its old id must not touch the new one.
  const isRecordable = (pair) => pair.rid !== null && pair.epoch === recorder.epoch();

  // Tells the user once per recording that nothing more is being recorded; forwarding goes on.
  function reportIfFull(r) {
    const stats = recorder.stats();
    if (stats.truncated && r.fullReportedEpoch !== recorder.epoch()) {
      r.fullReportedEpoch = recorder.epoch();
      emit({ type: 'recording_full', reason: stats.truncatedReason });
    }
  }

  function finalize(pair) {
    if (pair.finalized) return;
    pair.finalized = true;
    pair.torn = true;
    clear(pair.connectTimer);
    clear(pair.graceTimer);
    for (const name of ['up', 'down']) clear(pair.dir[name].writeTimer);
    pair.run.pairs.delete(pair.id);
    const cause = pair.cause ?? 'error';
    // The recording format has a fixed list of reasons; write_timeout is a kind of limit.
    if (isRecordable(pair)) recorder.closeConnection(pair.rid, pair.detail === 'write_timeout' ? 'limit' : cause);
    emit({
      type: 'connection_closed',
      connectionId: pair.id,
      reason: cause,
      detail: pair.detail,
      upBytes: pair.dir.up.bytes,
      downBytes: pair.dir.down.bytes,
    });
  }

  function onSocketClosed(pair, which) {
    pair.closed[which] = true;
    settle(pair, which === 'client' ? 'client_closed' : (pair.state === 'connecting' ? 'upstream_failed' : 'upstream_closed'));
    // A socket that is gone cannot carry the other direction any more.
    if (!pair.closed.client) destroySocket(pair.client);
    if (!pair.closed.upstream) destroySocket(pair.upstream);
    if (pair.closed.client && pair.closed.upstream) finalize(pair);
  }

  function maybeForwardFin(pair, name) {
    const d = pair.dir[name];
    if (pair.torn || pair.state !== 'open' || !d.finSeen || d.finForwarded || d.pending > 0) return;
    d.finForwarded = true;
    try { dstOf(pair, name).end(); } catch { /* already gone */ }
    // Both sides finished: they should close by themselves soon. Only the device having finished
    // (client still open) is bounded too; a client that finished first may legitimately keep reading.
    const both = pair.dir.up.finForwarded && pair.dir.down.finForwarded;
    if (both || name === 'down') {
      clear(pair.graceTimer);
      pair.graceTimer = scheduler.setTimeout(
        () => teardown(pair, 'error', 'close_timeout'),
        both ? lim.closeGraceMs : lim.halfOpenMs,
      );
    }
  }

  function forward(pair, name, bytes) {
    const d = pair.dir[name];
    const dst = dstOf(pair, name);
    d.pending += bytes.length;
    if (d.pending > lim.maxPendingBytes) {
      teardown(pair, 'limit', 'backlog');
      return;
    }
    if (!d.writeTimer) {
      d.writeTimer = scheduler.setTimeout(() => teardown(pair, 'limit', 'write_timeout'), lim.writeTimeoutMs);
    }
    dst.write(Buffer.from(bytes), (error) => {
      if (pair.torn) return;
      d.pending -= bytes.length;
      clear(d.writeTimer);
      d.writeTimer = null;
      if (error) {
        teardown(pair, 'error', 'write_error');
        return;
      }
      // Progress was made: the deadline restarts only if more is still waiting.
      if (d.pending > 0) {
        d.writeTimer = scheduler.setTimeout(() => teardown(pair, 'limit', 'write_timeout'), lim.writeTimeoutMs);
      }
      if (d.blocked && d.pending < lim.pauseAtBytes) {
        d.blocked = false;
        srcOf(pair, name).resume();
      }
      maybeForwardFin(pair, name);
    });
    if (d.pending >= lim.pauseAtBytes && !d.blocked) {
      d.blocked = true;
      srcOf(pair, name).pause();
    }
  }

  function onData(pair, name, chunk) {
    if (pair.torn) return;
    const bytes = Uint8Array.from(chunk);
    pair.dir[name].bytes += bytes.length;
    if (isRecordable(pair) && recorder.addChunk(pair.rid, name, bytes) === false) reportIfFull(pair.run);
    // Observers get their own copy: they must not be able to change what is forwarded.
    emit({ type: 'data', connectionId: pair.id, dir: name, bytes: bytes.slice() });

    if (name === 'up' && pair.state === 'connecting') {
      pair.pre.push(bytes);
      pair.preBytes += bytes.length;
      if (pair.preBytes >= lim.preConnectMaxBytes && !pair.clientPaused) {
        pair.clientPaused = true;
        pair.client.pause();
      }
      return;
    }
    forward(pair, name, bytes);
  }

  function onEnd(pair, name) {
    if (pair.torn) return;
    pair.dir[name].finSeen = true;
    settle(pair, name === 'up' ? 'client_closed' : 'upstream_closed');
    emit({ type: 'fin', connectionId: pair.id, dir: name });
    maybeForwardFin(pair, name);
  }

  function onUpstreamConnect(pair) {
    if (pair.torn) return;
    clear(pair.connectTimer);
    pair.connectTimer = null;
    pair.state = 'open';
    if (typeof pair.upstream.setNoDelay === 'function') pair.upstream.setNoDelay(true);
    emit({ type: 'upstream_open', connectionId: pair.id });
    const held = pair.pre.splice(0);
    for (const bytes of held) {
      if (pair.torn) return;
      forward(pair, 'up', bytes);
    }
    if (pair.torn) return;
    if (pair.clientPaused) {
      pair.clientPaused = false;
      if (!pair.dir.up.blocked) pair.client.resume();
    }
    maybeForwardFin(pair, 'up');
  }

  function openPair(r, client) {
    const upstream = createUpstreamSocket();
    // First of all: an 'error' without a listener would be an uncaught exception.
    upstream.on('error', () => {});
    const rid = recorder.openConnection();
    const pair = {
      id: nextPairId++,
      rid,
      epoch: recorder.epoch(),
      run: r,
      client,
      upstream,
      state: 'connecting',
      cause: null,
      detail: null,
      torn: false,
      finalized: false,
      closed: { client: false, upstream: false },
      pre: [],
      preBytes: 0,
      clientPaused: false,
      dir: { up: newDirection(), down: newDirection() },
      connectTimer: null,
      graceTimer: null,
      openedAt: now(),
      remote: `${client.remoteAddress ?? ''}:${client.remotePort ?? ''}`,
    };
    r.pairs.set(pair.id, pair);
    if (rid === null) reportIfFull(r);
    if (typeof client.setNoDelay === 'function') client.setNoDelay(true);
    emit({ type: 'connection_opened', connectionId: pair.id, remote: pair.remote });

    client.on('data', (chunk) => onData(pair, 'up', chunk));
    upstream.on('data', (chunk) => onData(pair, 'down', chunk));
    client.on('end', () => onEnd(pair, 'up'));
    upstream.on('end', () => onEnd(pair, 'down'));
    client.on('error', () => { settle(pair, 'error', 'client_error'); teardown(pair, 'error', 'client_error'); });
    upstream.on('error', (error) => {
      const cause = pair.state === 'connecting' ? 'upstream_failed' : 'error';
      teardown(pair, cause, error && error.code ? String(error.code) : 'upstream_error');
    });
    client.on('close', () => onSocketClosed(pair, 'client'));
    upstream.on('close', () => onSocketClosed(pair, 'upstream'));
    upstream.on('connect', () => onUpstreamConnect(pair));

    pair.connectTimer = scheduler.setTimeout(() => teardown(pair, 'upstream_failed', 'connect_timeout'), lim.connectTimeoutMs);
    upstream.connect({ host: r.upstreamAddress, port: r.upstreamPort });
  }

  function onSocket(r, client) {
    client.on('error', () => {});
    if (run !== r || lifecycle !== 'running') {
      client.destroy();
      return;
    }
    const t = now();
    // A fixed window with a counter: constant memory and time per connection.
    if (t - r.acceptWindowStart >= 1000) {
      r.acceptWindowStart = t;
      r.acceptCount = 0;
      r.acceptLimitReported = false;
    }
    r.acceptCount += 1;
    if (r.acceptCount > lim.acceptsPerSecond) {
      client.destroy();
      if (!r.acceptLimitReported) {
        r.acceptLimitReported = true;
        emit({ type: 'refused', reason: 'rate_limit' });
      }
      return;
    }
    if (r.pairs.size >= lim.maxPairs) {
      client.destroy();
      emit({ type: 'refused', reason: 'limit' });
      return;
    }
    openPair(r, client);
  }

  // ---- public API -----------------------------------------------------------------------

  function validate(options) {
    if (options === null || typeof options !== 'object') return 'invalid_arguments';
    if (!ALLOWED_LISTEN_HOSTS.includes(options.listenHost)) return 'invalid_host';
    if (!isValidPort(options.listenPort)) return 'invalid_port';
    const host = options.upstreamHost;
    if (typeof host !== 'string' || host.length < 1 || host.length > 253 || !HOST_PATTERN.test(host)) return 'invalid_upstream_host';
    if (!Number.isInteger(options.upstreamPort) || options.upstreamPort < 1 || options.upstreamPort > 65535) return 'invalid_upstream_port';
    return null;
  }

  function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
      const timer = scheduler.setTimeout(() => reject(new Error('timeout')), ms);
      promise.then((value) => { scheduler.clearTimeout(timer); resolve(value); },
        (error) => { scheduler.clearTimeout(timer); reject(error); });
    });
  }

  // hooks.beforeListen({ upstreamAddress, upstreamPort }) runs after the target was resolved and
  // approved by the address policy, before anything listens, and only when listening on all
  // interfaces: the caller can show the REAL target to the user and refuse.
  async function start(options, hooks = {}) {
    if (lifecycle !== 'idle') return { ok: false, code: lifecycle === 'running' ? 'already_running' : 'busy' };
    const problem = validate(options);
    if (problem) return { ok: false, code: problem };

    lifecycle = 'starting';
    generation += 1;
    const r = {
      generation,
      listenHost: options.listenHost,
      listenPort: options.listenPort,
      upstreamHost: options.upstreamHost,
      upstreamAddress: null,
      upstreamPort: options.upstreamPort,
      lan: options.listenHost === '0.0.0.0',
      pairs: new Map(),
      acceptWindowStart: 0,
      acceptCount: 0,
      acceptLimitReported: false,
      fullReportedEpoch: -1,
      server: null,
      cancelRequested: false,
      stopPromise: null,
      onStartFinished: null,
    };
    startingRun = r;

    const finish = (result) => {
      startingRun = null;
      if (!result.ok) lifecycle = 'idle';
      if (r.onStartFinished) r.onStartFinished();
      return result;
    };

    // 1. Resolve once and pin the address.
    let addresses;
    try {
      addresses = await withTimeout(Promise.resolve().then(() => resolveHost(options.upstreamHost)), lim.resolveTimeoutMs);
    } catch {
      return finish({ ok: false, code: 'upstream_unresolved' });
    }
    if (r.cancelRequested) return finish({ ok: false, code: 'cancelled' });
    if (!Array.isArray(addresses) || addresses.length === 0) return finish({ ok: false, code: 'upstream_unresolved' });
    // Every answer must be allowed, not only the one that will be used.
    if (!addresses.every((address) => classifyAddress(address) !== null)) {
      return finish({ ok: false, code: 'upstream_not_allowed' });
    }
    r.upstreamAddress = addresses[0];

    if (r.lan) {
      // No way to ask means no consent: never listen on all interfaces without the question.
      if (typeof hooks.beforeListen !== 'function') return finish({ ok: false, code: 'confirmation_required' });
      let accepted = false;
      try {
        accepted = (await hooks.beforeListen({ upstreamAddress: r.upstreamAddress, upstreamPort: r.upstreamPort })) === true;
      } catch {
        accepted = false;
      }
      if (r.cancelRequested) return finish({ ok: false, code: 'cancelled' });
      if (!accepted) return finish({ ok: false, code: 'cancelled' });
    }

    // 2. Listen.
    r.server = createServer((socket) => onSocket(r, socket));
    const listened = await new Promise((resolve) => {
      const onListenError = (error) => resolve({ ok: false, errno: error && error.code });
      r.server.once('error', onListenError);
      r.server.listen({ host: r.listenHost, port: r.listenPort }, () => {
        r.server.removeListener('error', onListenError);
        resolve({ ok: true });
      });
    });
    if (!listened.ok) return finish({ ok: false, code: 'listen_failed', errno: listened.errno });

    const releaseAndFail = (code) => new Promise((resolve) => {
      r.server.close(() => resolve(finish({ ok: false, code })));
    });
    if (r.cancelRequested) return releaseAndFail('cancelled');

    // 3. The relay must never connect to itself (any local address with the real listening port).
    const port = r.server.address().port;
    const locals = new Set(localAddresses().map(canonicalAddress));
    if (classifyAddress(r.upstreamAddress) === 'loopback' || locals.has(canonicalAddress(r.upstreamAddress))) {
      if (port === r.upstreamPort) return releaseAndFail('loop');
    }

    r.server.on('error', (error) => {
      if (run !== r) return;
      emit({ type: 'server_error', errno: error && error.code });
      stop();
    });
    r.port = port;
    run = r;
    lifecycle = 'running';
    emit({ type: 'listening', host: r.listenHost, port });
    return finish({
      ok: true, host: r.listenHost, port, generation: r.generation, upstreamAddress: r.upstreamAddress, lan: r.lan,
    });
  }

  function stop() {
    if (lifecycle === 'idle') return Promise.resolve({ ok: true });
    if (lifecycle === 'stopping') return stopPromise;
    if (lifecycle === 'starting') {
      // Every caller gets the same promise: a second stop must not replace the first one's callback.
      const pending = startingRun;
      pending.cancelRequested = true;
      if (!pending.stopPromise) {
        pending.stopPromise = new Promise((resolve) => { pending.onStartFinished = () => resolve({ ok: true }); });
      }
      return pending.stopPromise;
    }

    lifecycle = 'stopping';
    const r = run;
    for (const pair of [...r.pairs.values()]) teardown(pair, 'stop');
    stopPromise = new Promise((resolve) => {
      r.server.close(() => {
        run = null;
        lifecycle = 'idle';
        stopPromise = null;
        emit({ type: 'stopped', generation: r.generation });
        resolve({ ok: true });
      });
    });
    return stopPromise;
  }

  function getState() {
    if (lifecycle !== 'running') return { running: false, lifecycle, connections: [] };
    return {
      running: true,
      lifecycle,
      host: run.listenHost,
      port: run.port,
      generation: run.generation,
      lan: run.lan,
      upstream: { host: run.upstreamHost, address: run.upstreamAddress, port: run.upstreamPort },
      connections: [...run.pairs.values()].map((p) => ({
        id: p.id,
        remote: p.remote,
        openedAt: p.openedAt,
        state: p.state,
        upBytes: p.dir.up.bytes,
        downBytes: p.dir.down.bytes,
      })),
    };
  }

  return { start, stop, getState };
}

module.exports = {
  createRelay, classifyAddress, canonicalAddress, ALLOWED_LISTEN_HOSTS, DEFAULT_LIMITS, isValidPort,
};
