// The controller side of UDP: one UDP socket as a small state machine, with the same outward shape
// as connection.js (connect / send / disconnect / getState / getId / getHistory and the same kind
// of "facts" for the diagnostic rules).
//
// What is different from TCP, and why the code looks different (see the Phase 4 plan, 4 and 12):
//  - There is no connection. "connected" only means "the socket is ready to send"; it says nothing
//    about the device being there. A send to a closed port succeeds (measured on Windows: no ICMP
//    error is reported), so success of a send means "handed to the operating system".
//  - Default mode: bind + connect(). The operating system then drops datagrams from any source
//    other than the target. "Accept any source" mode: bind without connect(), send to an explicit
//    address, and receive from anyone (the source is reported).
//  - The target is resolved ONCE (IPv4 only), checked (loopback / private network only, never
//    broadcast or multicast) and pinned, so a page cannot use this to spray the network.
//  - Facts carry transport: 'udp'. There is no `terminated`; an unexpected socket failure is
//    reported as `socket_closed`.
// The socket factory, DNS, interface list, clock and scheduler are injected so every path can be
// tested without a network.
const dgram = require('node:dgram');
const { classifyUdpTarget } = require('../core/address-policy');
const { checkSendSize } = require('../core/datagram');
const { defaultInterfaces, defaultResolve } = require('./udp-net');

const DEFAULTS = {
  timeoutMs: 5000,
  closeGraceMs: 1000,
  maxHistory: 1000,
  maxQueuedWrites: 1000,
  // Spray protection (the TCP handshake and timeouts used to play this role): enforced here, in
  // the main process, because the page is not trusted.
  connectsPer10s: 5,
  sendsPerSecond: 100,
  sendBytesPerSecond: 256 * 1024,
  // Received datagrams (and bytes) that are turned into events per second: a LAN peer may flood
  // us, so this is checked before anything is copied or shown.
  recvPerSecond: 500,
  recvBytesPerSecond: 1024 * 1024,
};

// At most `maxCount` events and `maxBytes` bytes within any `windowMs`: a real sliding window,
// so a burst split across a boundary cannot pass twice the limit.
function createLimiter(maxCount, maxBytes, windowMs = 1000) {
  const entries = [];
  let bytes = 0;
  return {
    take(t, size) {
      while (entries.length > 0 && t - entries[0].t >= windowMs) bytes -= entries.shift().size;
      if (entries.length + 1 > maxCount || bytes + size > maxBytes) return false;
      entries.push({ t, size });
      bytes += size;
      return true;
    },
  };
}

function isValidTarget(host, port) {
  return typeof host === 'string'
    && host.length >= 1
    && host.length <= 253
    && /^[^\s\u0000-\u001f\u007f]+$/.test(host)
    && Number.isInteger(port)
    && port >= 1
    && port <= 65535;
}

// 0 asks the system for a free port; below 1024 is never needed to receive a device's replies.
const isValidLocalPort = (port) => Number.isInteger(port) && (port === 0 || (port >= 1024 && port <= 65535));

function createUdpEndpoint({
  createSocket = () => dgram.createSocket({ type: 'udp4' }),
  resolveHost = defaultResolve,
  getInterfaces = defaultInterfaces,
  scheduler = { setTimeout, clearTimeout },
  now = Date.now,
  onEvent = () => {},
  limits = {},
  maxHistory = DEFAULTS.maxHistory,
  onListenerError = (error) => console.error('[udp-endpoint] event listener failed:', error),
} = {}) {
  const lim = { ...DEFAULTS, ...limits };
  let nextId = 1;
  let current = null;
  let state = 'idle';
  let history = [];
  let connectTimes = [];

  function notify(stamped) {
    try {
      onEvent(stamped);
    } catch (error) {
      onListenerError(error);
    }
  }

  function emit(event) {
    notify({ t: now(), ...event });
  }

  // Only facts the diagnostic rules need are kept; received payloads are not stored.
  function emitFact(event) {
    const stamped = { t: now(), transport: 'udp', ...event };
    const { bytes, ...fact } = stamped;
    history.push(fact);
    if (history.length > maxHistory) history = history.slice(history.length - maxHistory);
    notify(stamped);
  }

  function setState(connection, next) {
    connection.state = next;
    state = next;
    emit({ type: 'state', id: connection.id, state: next });
  }

  const isCurrent = (connection) => current !== null && current.id === connection.id;

  function clearTimers(connection) {
    for (const key of ['connectTimer', 'graceTimer']) {
      if (connection[key] !== null) {
        scheduler.clearTimeout(connection[key]);
        connection[key] = null;
      }
    }
  }

  function closeQuietly(socket) {
    if (!socket) return;
    try {
      socket.close();
    } catch {
      // Already closed: the socket is being discarded, so nothing else can be done with it.
    }
  }

  function resolvePendingWrites(connection) {
    for (const settle of [...connection.pendingWrites]) settle({ ok: false, code: 'not_connected' });
  }

  function failConnect(connection, code) {
    if (!isCurrent(connection) || connection.state !== 'connecting') return;
    clearTimers(connection);
    connection.settled = true;
    resolvePendingWrites(connection);
    closeQuietly(connection.socket);
    emitFact({ type: 'connect_fail', id: connection.id, code });
    setState(connection, 'closed');
  }

  // The socket is gone without the user asking for it (an error or a close from the system).
  function socketLost(connection, code) {
    if (!isCurrent(connection) || connection.settled) return;
    clearTimers(connection);
    connection.settled = true;
    resolvePendingWrites(connection);
    closeQuietly(connection.socket);
    emitFact({ type: 'socket_closed', id: connection.id, code: code ?? null });
    setState(connection, 'closed');
  }

  function makeReady(connection) {
    if (!isCurrent(connection) || connection.state !== 'connecting') return;
    clearTimers(connection);
    setState(connection, 'connected');
    let localPort = null;
    try {
      localPort = connection.socket.address().port;
    } catch {
      // The port is only informational.
    }
    emitFact({ type: 'connect_ok', id: connection.id, localPort, acceptAnySource: connection.acceptAnySource });
  }

  function onMessage(connection, bytes, remote) {
    if (!isCurrent(connection) || connection.settled || connection.state !== 'connected') return;
    const t = now();
    // Reported at most once per second, on the next datagram after the drops.
    if (connection.recvDropped > 0 && t - connection.lastFloodReport >= 1000) {
      emitFact({ type: 'recv_flood', id: connection.id, dropped: connection.recvDropped });
      connection.recvDropped = 0;
      connection.lastFloodReport = t;
    }
    if (!connection.recvLimiter.take(t, bytes.length)) {
      if (connection.recvDropped === 0) connection.lastFloodReport = t;
      connection.recvDropped += 1;
      return;
    }
    if (bytes.length === 0) {
      emitFact({ type: 'recv_empty', id: connection.id });
      return;
    }
    const fromTarget = !connection.acceptAnySource
      || (remote.address === connection.address && remote.port === connection.port);
    // Copy: the Buffer may be reused by the system.
    emitFact({
      type: 'recv',
      id: connection.id,
      bytes: Uint8Array.from(bytes),
      fromTarget,
      remote: { address: remote.address, port: remote.port },
    });
  }

  function wireSocket(connection) {
    const { socket } = connection;
    // First of all: an 'error' without a listener would be an uncaught exception.
    socket.on('error', (error) => {
      if (!isCurrent(connection) || connection.settled) return;
      const code = (error && error.code) || 'UNKNOWN';
      if (connection.state === 'connecting') failConnect(connection, code);
      else socketLost(connection, code);
    });
    socket.on('message', (bytes, remote) => onMessage(connection, bytes, remote));
    socket.on('close', () => {
      if (!isCurrent(connection) || connection.settled) return;
      if (connection.state === 'closing') {
        clearTimers(connection);
        connection.settled = true;
        setState(connection, 'closed');
      } else if (connection.state === 'connecting') {
        failConnect(connection, 'ECONNRESET');
      } else {
        socketLost(connection, null);
      }
    });
  }

  async function begin(connection, { host, port, localPort }) {
    let answers;
    try {
      answers = await resolveHost(host);
    } catch (error) {
      failConnect(connection, (error && error.code) || 'ENOTFOUND');
      return;
    }
    if (!isCurrent(connection) || connection.state !== 'connecting') return;
    if (!Array.isArray(answers) || answers.length === 0) {
      failConnect(connection, 'ENOTFOUND');
      return;
    }
    // Every answer must be allowed, not only the one that will be used.
    const interfaces = getInterfaces();
    let kind = 'private';
    for (const [index, answer] of answers.entries()) {
      const verdict = classifyUdpTarget(answer, { interfaces });
      if (!verdict.ok) {
        failConnect(connection, verdict.code);
        return;
      }
      if (index === 0) kind = verdict.kind;
    }
    connection.address = answers[0];
    connection.port = port;

    try {
      connection.socket = createSocket();
    } catch (error) {
      failConnect(connection, (error && error.code) || 'UNKNOWN');
      return;
    }
    wireSocket(connection);
    const { socket } = connection;
    try {
      // A loopback target is reached through the loopback address, so bind exactly that (a conflict
      // with another program on the same address is then reported). Otherwise all interfaces: a
      // device may answer to any address of this PC.
      socket.bind({ port: localPort, address: kind === 'loopback' ? '127.0.0.1' : '0.0.0.0' }, () => {
        if (!isCurrent(connection) || connection.state !== 'connecting') return;
        if (connection.acceptAnySource) {
          makeReady(connection);
          return;
        }
        socket.once('connect', () => makeReady(connection));
        try {
          socket.connect(connection.port, connection.address);
        } catch (error) {
          failConnect(connection, (error && error.code) || 'UNKNOWN');
        }
      });
    } catch (error) {
      failConnect(connection, (error && error.code) || 'UNKNOWN');
    }
  }

  function connect({
    host, port, localPort = 0, acceptAnySource = false, timeoutMs = lim.timeoutMs,
  } = {}) {
    // The renderer is not trusted: validate here as well.
    if (!isValidTarget(host, port)) return { ok: false, code: 'invalid_target' };
    if (!isValidLocalPort(localPort)) return { ok: false, code: 'invalid_local_port' };
    if (typeof acceptAnySource !== 'boolean') return { ok: false, code: 'invalid_arguments' };
    if (state === 'connecting' || state === 'connected' || state === 'closing') return { ok: false, code: 'busy' };

    const t = now();
    connectTimes = connectTimes.filter((x) => t - x < 10000);
    if (connectTimes.length >= lim.connectsPer10s) return { ok: false, code: 'rate_limited' };
    connectTimes.push(t);

    const connection = {
      id: nextId++,
      socket: null,
      state: 'idle',
      settled: false,
      userRequested: false,
      acceptAnySource,
      address: null,
      port: null,
      connectTimer: null,
      graceTimer: null,
      writeChain: Promise.resolve(),
      queuedWrites: 0,
      pendingWrites: new Set(),
      sendLimiter: createLimiter(lim.sendsPerSecond, lim.sendBytesPerSecond),
      recvLimiter: createLimiter(lim.recvPerSecond, lim.recvBytesPerSecond),
      recvDropped: 0,
      lastFloodReport: 0,
    };
    current = connection;
    history = [];
    setState(connection, 'connecting');
    // One deadline covers the name lookup and the setup.
    connection.connectTimer = scheduler.setTimeout(() => failConnect(connection, 'CONNECT_TIMEOUT'), timeoutMs);
    begin(connection, { host, port, localPort });
    return { ok: true, id: connection.id };
  }

  const canWrite = (connection) => isCurrent(connection) && connection.state === 'connected' && !connection.settled;

  const sendAllowedNow = (connection, length) => connection.sendLimiter.take(now(), length);

  function writeBytes(connection, bytes, meta) {
    return new Promise((resolve) => {
      let done = false;
      const settle = (result) => {
        if (done) return;
        done = true;
        connection.pendingWrites.delete(settle);
        resolve(result);
      };
      if (!canWrite(connection)) {
        settle({ ok: false, code: 'not_connected' });
        return;
      }
      // The caller's last chance to stop a send whose conditions changed while it waited in the
      // queue (read-only mode, another connection). Checked right before the datagram goes out.
      if (typeof meta.guard === 'function') {
        let allowed = false;
        try {
          allowed = meta.guard() === true;
        } catch {
          allowed = false;
        }
        if (!allowed) {
          settle({ ok: false, code: 'blocked', reason: 'changed_before_send' });
          return;
        }
      }
      if (!sendAllowedNow(connection, bytes.length)) {
        settle({ ok: false, code: 'rate_limited' });
        return;
      }
      connection.pendingWrites.add(settle);
      emitFact({
        type: 'send',
        id: connection.id,
        expectsReply: Boolean(meta.expectsReply),
        endsWithTerminator: Boolean(meta.endsWithTerminator),
      });
      const done2 = (error) => {
        // A callback that arrives after the connection ended (or was replaced) reports nothing.
        if (!isCurrent(connection) || connection.settled) {
          settle({ ok: false, code: 'not_connected' });
          return;
        }
        if (error) {
          emitFact({ type: 'send_error', id: connection.id, code: error.code || 'UNKNOWN' });
          settle({ ok: false, code: 'write_failed', errno: error.code });
        } else {
          // "Handed to the operating system", not "received by the device".
          settle({ ok: true });
        }
      };
      try {
        if (connection.acceptAnySource) connection.socket.send(Buffer.from(bytes), connection.port, connection.address, done2);
        else connection.socket.send(Buffer.from(bytes), done2);
      } catch (error) {
        done2(error);
      }
    });
  }

  function send(bytes, meta = {}) {
    if (!(bytes instanceof Uint8Array) || bytes.length === 0) return Promise.resolve({ ok: false, code: 'invalid_data' });
    const size = checkSendSize(bytes.length);
    if (!size.ok) return Promise.resolve({ ok: false, code: size.code });
    const connection = current;
    if (connection === null || !canWrite(connection)) return Promise.resolve({ ok: false, code: 'not_connected' });
    if (connection.queuedWrites >= lim.maxQueuedWrites) return Promise.resolve({ ok: false, code: 'queue_full' });
    connection.queuedWrites += 1;
    const result = connection.writeChain
      .then(() => writeBytes(connection, bytes, meta))
      .finally(() => { connection.queuedWrites -= 1; });
    connection.writeChain = result.catch(() => ({ ok: false, code: 'write_failed' }));
    return result;
  }

  function disconnect() {
    const connection = current;
    if (connection === null || connection.state === 'closed' || connection.state === 'closing') return { ok: true };
    connection.userRequested = true;

    if (connection.state === 'connecting') {
      // Cancelled by the user: not a failure, so no connect_fail event.
      clearTimers(connection);
      connection.settled = true;
      resolvePendingWrites(connection);
      closeQuietly(connection.socket);
      setState(connection, 'closed');
      return { ok: true };
    }

    setState(connection, 'closing');
    resolvePendingWrites(connection);
    closeQuietly(connection.socket);
    // The socket reports 'close' shortly; if it never does, settle anyway.
    connection.graceTimer = scheduler.setTimeout(() => {
      connection.graceTimer = null;
      if (!isCurrent(connection) || connection.settled) return;
      connection.settled = true;
      setState(connection, 'closed');
    }, lim.closeGraceMs);
    return { ok: true };
  }

  // There is no connection to keep alive.
  const setKeepAlive = () => ({ ok: false, code: 'unsupported' });

  return {
    connect,
    send,
    disconnect,
    setKeepAlive,
    getState: () => state,
    getId: () => (current === null ? null : current.id),
    getHistory: () => history.slice(),
  };
}

module.exports = { createUdpEndpoint, DEFAULTS, isValidLocalPort };
