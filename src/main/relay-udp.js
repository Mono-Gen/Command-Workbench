// The relay role over UDP: a transparent datagram proxy between a controller and a real device
// that records both directions.
//
// A sibling of relay.js with the SAME outward shape (start / stop / getState, the same event
// types), so relay-service.js can pick either. What is different (Phase 4 plan, 5.4 and 12.5):
//  - A "session" is one client source (address:port). Each session owns a UDP socket that is
//    connect()ed to the device, so the operating system drops datagrams from anything else. A
//    datagram from the client goes out through its session socket; a datagram from the device goes
//    back to that client through the listening socket.
//  - Datagram boundaries are kept: one in, one out, unchanged. The recording gets one event per
//    datagram (an empty datagram is forwarded but never recorded). The client's address is not
//    saved in the recording, only the session number.
//  - A session expires 60 s after the CLIENT last sent something (traffic from the device does not
//    extend it) and in any case after one hour. Closing always releases the device-side socket
//    first and then removes the session from the table; a late datagram of a removed session is
//    dropped, never handed to a newer session with the same client address.
//  - New sessions are limited in number and in rate BEFORE any socket is created.
//  - The device address is resolved once (IPv4), approved by the UDP address policy (loopback and
//    private networks only; never broadcast or multicast) and pinned. The relay never forwards to
//    itself.
//  - Source addresses can be forged. Listening on all interfaces therefore also limits what is
//    sent back (byte buckets) and what is received (sliding windows); this reduces reflected
//    traffic, it cannot remove it.
// Sockets, DNS, the interface list, the clock and the scheduler are injected for tests.
const dgram = require('node:dgram');
const os = require('node:os');
const { classifyAddress, canonicalAddress, classifyUdpTarget } = require('../core/address-policy');
const { MAX_DATAGRAM_BYTES } = require('../core/datagram');
const { createWindowLimiter, createBucket } = require('./rate-limit');
const { defaultInterfaces, defaultResolve, releaseThen, createNoticeThrottle } = require('./udp-net');

const ALLOWED_LISTEN_HOSTS = ['127.0.0.1', '0.0.0.0'];

const DEFAULT_LIMITS = {
  maxSessions: 8,
  newSessionsPerSecond: 10,
  resolveTimeoutMs: 5000,
  // Time without anything from the client, and the absolute lifetime of a session.
  sessionIdleMs: 60000,
  sessionMaxMs: 60 * 60 * 1000,
  // Datagrams held while the device-side socket is being connected.
  preConnectMaxItems: 16,
  preConnectMaxBytes: 256 * 1024,
  // Datagrams / bytes per second in each direction (sliding window).
  recvPerSecond: 2000,
  recvBytesPerSecond: 4 * 1024 * 1024,
  lanRecvPerSecond: 200,
  lanRecvBytesPerSecond: 256 * 1024,
  // Bytes per second sent back to clients (token buckets). On loopback the whole-relay bucket can
  // hold one largest datagram. On the whole network every bucket holds one second's worth, so a reply
  // larger than the per-session rate is not relayed (reported as refused).
  replyBytesPerSecond: 4 * 1024 * 1024,
  replyBytesPerSecondPerSession: 1024 * 1024,
  lanReplyBytesPerSecond: 32 * 1024,
  lanReplyBytesPerSecondPerSession: 8 * 1024,
  reportIntervalMs: 1000,
};

const isValidPort = (port) => Number.isInteger(port) && (port === 0 || (port >= 1024 && port <= 65535));
const HOST_PATTERN = /^[A-Za-z0-9._:-]+$/;

function defaultLocalAddresses() {
  const out = ['127.0.0.1', '::1'];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const entry of list || []) out.push(entry.address.split('%')[0]);
  }
  return out;
}

function createUdpRelay({
  createSocket = () => dgram.createSocket({ type: 'udp4' }),
  resolveHost = defaultResolve,
  localAddresses = defaultLocalAddresses,
  getInterfaces = defaultInterfaces,
  recorder,
  scheduler = { setTimeout, clearTimeout },
  now = Date.now,
  onEvent = () => {},
  onListenerError = (error) => console.error('[relay-udp] event listener failed:', error),
  limits = {},
} = {}) {
  if (!recorder || typeof recorder.addChunk !== 'function') throw new TypeError('recorder is required');
  const lim = { ...DEFAULT_LIMITS, ...limits };
  let generation = 0;
  let lifecycle = 'idle'; // idle | starting | running | stopping
  let run = null;
  let startingRun = null;
  let stopPromise = null;
  let nextSessionId = 1;

  function emit(event) {
    try {
      onEvent({ t: now(), generation: run ? run.generation : generation, ...event });
    } catch (error) {
      onListenerError(error);
    }
  }

  const clear = (timer) => { if (timer) scheduler.clearTimeout(timer); };

  // Notices a remote source can provoke at will are reported at most once per interval per kind.
  function report(r, key, event) {
    r.notice(key, () => emit(event));
  }

  const isRecordable = (s) => s.rid !== null && s.epoch === recorder.epoch();

  // The recording connection is created with the first non-empty datagram, so a session that only
  // sent empty datagrams leaves no trace (an "empty" recording must stay switchable and clearable).
  function recordChunk(s, dir, bytes) {
    if (!s.recordingTried) {
      s.recordingTried = true;
      s.rid = recorder.openConnection();
      s.epoch = recorder.epoch();
      if (s.rid === null) reportIfFull(s.run);
    }
    if (isRecordable(s) && recorder.addChunk(s.rid, dir, bytes) === false) reportIfFull(s.run);
  }

  function reportIfFull(r) {
    const stats = recorder.stats();
    if (stats.truncated && r.fullReportedEpoch !== recorder.epoch()) {
      r.fullReportedEpoch = recorder.epoch();
      emit({ type: 'recording_full', reason: stats.truncatedReason });
    }
  }

  // ---- sessions -------------------------------------------------------------------------

  function closeSession(s, cause) {
    if (s.closed) return;
    s.closed = true;
    clear(s.idleTimer);
    clear(s.lifeTimer);
    s.idleTimer = null;
    s.lifeTimer = null;
    s.pending.length = 0;
    s.pendingBytes = 0;
    // The device-side socket goes first, then the table entry (see the header comment). The socket
    // still counts against the session limit, and stop() waits for it, until its 'close' event.
    const closing = new Promise((resolve) => releaseThen(s.socket, resolve));
    s.run.closing.add(closing);
    closing.then(() => s.run.closing.delete(closing));
    if (s.run.sessions.get(s.key) === s) s.run.sessions.delete(s.key);
    if (isRecordable(s)) recorder.closeConnection(s.rid, cause);
    emit({
      type: 'connection_closed',
      connectionId: s.id,
      reason: cause,
      upBytes: s.upBytes,
      downBytes: s.downBytes,
    });
  }

  function armIdle(s) {
    clear(s.idleTimer);
    s.idleTimer = scheduler.setTimeout(() => closeSession(s, 'idle'), lim.sessionIdleMs);
  }

  function sendUp(s, bytes) {
    try {
      s.socket.send(Buffer.from(bytes), (error) => {
        if (s.closed || !error) return;
        report(s.run, 'send_error_up', { type: 'send_error', connectionId: s.id, dir: 'up', errno: error.code });
      });
    } catch (error) {
      report(s.run, 'send_error_up', { type: 'send_error', connectionId: s.id, dir: 'up', errno: error && error.code });
    }
  }

  function onDevice(s, message) {
    const r = s.run;
    if (s.closed || r.sessions.get(s.key) !== s || run !== r) return;
    const t = now();
    if (!r.downLimiter.take(t, message.length)) {
      report(r, 'down_rate_limit', { type: 'refused', reason: 'rate_limit' });
      return;
    }
    const bytes = Uint8Array.from(message);
    if (bytes.length > 0) {
      // Reflection guard: a reply beyond the budget is dropped (and neither recorded nor shown).
      if (!r.replyBucket.has(bytes.length) || !s.replyBucket.has(bytes.length)) {
        report(r, 'reply_rate_limit', { type: 'refused', reason: 'reply_rate_limit' });
        return;
      }
      r.replyBucket.take(bytes.length);
      s.replyBucket.take(bytes.length);
      s.downBytes += bytes.length;
      recordChunk(s, 'down', bytes);
      emit({ type: 'data', connectionId: s.id, dir: 'down', bytes: bytes.slice() });
    }
    try {
      r.socket.send(Buffer.from(bytes), s.clientPort, s.clientAddress, (error) => {
        if (s.closed || !error) return;
        report(r, 'send_error_down', { type: 'send_error', connectionId: s.id, dir: 'down', errno: error.code });
      });
    } catch (error) {
      report(r, 'send_error_down', { type: 'send_error', connectionId: s.id, dir: 'down', errno: error && error.code });
    }
  }

  function openSession(r, rinfo) {
    const socket = createSocket();
    const key = `${rinfo.address}:${rinfo.port}`;
    const s = {
      id: nextSessionId++,
      run: r,
      key,
      clientAddress: rinfo.address,
      clientPort: rinfo.port,
      socket,
      rid: null,
      epoch: -1,
      recordingTried: false,
      state: 'connecting',
      closed: false,
      pending: [],
      pendingBytes: 0,
      upBytes: 0,
      downBytes: 0,
      openedAt: now(),
      idleTimer: null,
      lifeTimer: null,
      replyBucket: createBucket(r.sessionReplyRate, now),
    };
    r.sessions.set(key, s);
    emit({ type: 'connection_opened', connectionId: s.id, remote: key });
    armIdle(s);
    s.lifeTimer = scheduler.setTimeout(() => closeSession(s, 'limit'), lim.sessionMaxMs);

    // First of all: an unhandled 'error' on a socket would crash the main process.
    socket.on('error', () => closeSession(s, 'error'));
    socket.on('close', () => closeSession(s, 'error'));
    socket.on('message', (message) => onDevice(s, message));
    socket.once('connect', () => {
      if (s.closed) return;
      s.state = 'open';
      emit({ type: 'upstream_open', connectionId: s.id });
      const held = s.pending.splice(0);
      s.pendingBytes = 0;
      for (const bytes of held) sendUp(s, bytes);
    });
    try {
      socket.connect(r.upstreamPort, r.upstreamAddress);
    } catch {
      closeSession(s, 'upstream_failed');
    }
    return s;
  }

  function onClient(r, message, rinfo) {
    if (run !== r || lifecycle !== 'running') return;
    const t = now();
    // First of all, before any state is created or anything is shown.
    if (!r.recvLimiter.take(t, message.length)) {
      report(r, 'rate_limit', { type: 'refused', reason: 'rate_limit' });
      return;
    }
    if (!rinfo || rinfo.family !== 'IPv4') return;
    const key = `${rinfo.address}:${rinfo.port}`;
    let s = r.sessions.get(key);
    if (!s) {
      // Limits are decided before a socket is created.
      if (t - r.newWindowStart >= 1000) { r.newWindowStart = t; r.newCount = 0; }
      if (r.newCount >= lim.newSessionsPerSecond) {
        report(r, 'new_rate', { type: 'refused', reason: 'rate_limit' });
        return;
      }
      if (r.sessions.size + r.closing.size >= lim.maxSessions) {
        report(r, 'limit', { type: 'refused', reason: 'limit' });
        return;
      }
      r.newCount += 1;
      s = openSession(r, rinfo);
    } else {
      armIdle(s);
    }
    if (s.closed) return;

    const bytes = Uint8Array.from(message);
    if (s.state === 'connecting'
      && (s.pending.length >= lim.preConnectMaxItems || s.pendingBytes + bytes.length > lim.preConnectMaxBytes)) {
      report(r, 'pending_overflow', { type: 'refused', reason: 'pending_overflow' });
      return;
    }
    if (bytes.length > 0) {
      s.upBytes += bytes.length;
      recordChunk(s, 'up', bytes);
      emit({ type: 'data', connectionId: s.id, dir: 'up', bytes: bytes.slice() });
    }
    if (s.state === 'connecting') {
      s.pending.push(bytes);
      s.pendingBytes += bytes.length;
    } else {
      sendUp(s, bytes);
    }
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

  // hooks.beforeListen({ upstreamAddress, upstreamPort }) works as in relay.js: only when listening
  // on all interfaces, after the target was resolved and approved, before anything listens.
  async function start(options, hooks = {}) {
    if (lifecycle !== 'idle') return { ok: false, code: lifecycle === 'running' ? 'already_running' : 'busy' };
    const problem = validate(options);
    if (problem) return { ok: false, code: problem };

    lifecycle = 'starting';
    generation += 1;
    const lan = options.listenHost === '0.0.0.0';
    const r = {
      generation,
      listenHost: options.listenHost,
      listenPort: options.listenPort,
      upstreamHost: options.upstreamHost,
      upstreamAddress: null,
      upstreamPort: options.upstreamPort,
      lan,
      sessions: new Map(),
      closing: new Set(),
      newWindowStart: 0,
      newCount: 0,
      fullReportedEpoch: -1,
      notice: createNoticeThrottle(now, lim.reportIntervalMs),
      recvLimiter: lan
        ? createWindowLimiter(lim.lanRecvPerSecond, lim.lanRecvBytesPerSecond)
        : createWindowLimiter(lim.recvPerSecond, lim.recvBytesPerSecond),
      downLimiter: lan
        ? createWindowLimiter(lim.lanRecvPerSecond, lim.lanRecvBytesPerSecond)
        : createWindowLimiter(lim.recvPerSecond, lim.recvBytesPerSecond),
      // On the whole network the burst is no larger than one second's budget (a bigger bucket would
      // let forged sources reflect more than the stated rate); loopback may carry a largest datagram.
      replyBucket: lan
        ? createBucket(lim.lanReplyBytesPerSecond, now)
        : createBucket(lim.replyBytesPerSecond, now, MAX_DATAGRAM_BYTES),
      sessionReplyRate: lan ? lim.lanReplyBytesPerSecondPerSession : lim.replyBytesPerSecondPerSession,
      socket: null,
      cancelRequested: false,
      cancelPromise: null,
      onStartFinished: null,
    };
    startingRun = r;

    const finish = (result) => {
      startingRun = null;
      if (!result.ok) lifecycle = 'idle';
      if (r.onStartFinished) r.onStartFinished();
      return result;
    };

    // 1. Resolve once (IPv4) and pin the address.
    let addresses;
    try {
      addresses = await withTimeout(Promise.resolve().then(() => resolveHost(options.upstreamHost)), lim.resolveTimeoutMs);
    } catch {
      return finish({ ok: false, code: 'upstream_unresolved' });
    }
    if (r.cancelRequested) return finish({ ok: false, code: 'cancelled' });
    if (!Array.isArray(addresses) || addresses.length === 0) return finish({ ok: false, code: 'upstream_unresolved' });
    // Every answer must be allowed, not only the one that will be used.
    const interfaces = getInterfaces();
    if (!addresses.every((address) => classifyUdpTarget(address, { interfaces }).ok)) {
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

    // 2. Bind.
    r.socket = createSocket();
    const bound = await new Promise((resolve) => {
      r.socket.on('error', (error) => {
        if (lifecycle === 'starting' && startingRun === r) {
          resolve({ ok: false, errno: error && error.code });
          return;
        }
        if (run !== r) return;
        emit({ type: 'server_error', errno: error && error.code });
        stop();
      });
      r.socket.once('listening', () => resolve({ ok: true }));
      try {
        r.socket.bind({ address: r.listenHost, port: r.listenPort });
      } catch (error) {
        resolve({ ok: false, errno: error && error.code });
      }
    });
    const releaseAndFail = (code, extra = {}) => new Promise((resolve) => {
      releaseThen(r.socket, () => resolve(finish({ ok: false, code, ...extra })));
    });
    if (!bound.ok) return releaseAndFail('listen_failed', { errno: bound.errno });
    if (r.cancelRequested) return releaseAndFail('cancelled');

    // 3. The relay must never forward to itself (any local address with the real listening port).
    const port = r.socket.address().port;
    const locals = new Set(localAddresses().map(canonicalAddress));
    if (classifyAddress(r.upstreamAddress) === 'loopback' || locals.has(canonicalAddress(r.upstreamAddress))) {
      if (port === r.upstreamPort) return releaseAndFail('loop');
    }

    r.socket.on('message', (message, rinfo) => onClient(r, message, rinfo));
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
      if (!pending.cancelPromise) {
        pending.cancelPromise = new Promise((resolve) => { pending.onStartFinished = () => resolve({ ok: true }); });
      }
      return pending.cancelPromise;
    }

    lifecycle = 'stopping';
    const r = run;
    for (const s of [...r.sessions.values()]) closeSession(s, 'stop');
    stopPromise = new Promise((resolve) => {
      const listenerClosed = new Promise((done) => releaseThen(r.socket, done));
      Promise.all([listenerClosed, ...r.closing]).then(() => {
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
    if (lifecycle !== 'running') return { running: false, lifecycle, transport: 'udp', connections: [] };
    return {
      running: true,
      lifecycle,
      transport: 'udp',
      host: run.listenHost,
      port: run.port,
      generation: run.generation,
      lan: run.lan,
      upstream: { host: run.upstreamHost, address: run.upstreamAddress, port: run.upstreamPort },
      connections: [...run.sessions.values()].map((s) => ({
        id: s.id,
        remote: s.key,
        openedAt: s.openedAt,
        state: s.state,
        upBytes: s.upBytes,
        downBytes: s.downBytes,
      })),
    };
  }

  return { start, stop, getState };
}

module.exports = { createUdpRelay, ALLOWED_LISTEN_HOSTS, DEFAULT_LIMITS, isValidPort };
