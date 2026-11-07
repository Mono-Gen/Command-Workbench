// One TCP connection as an explicit state machine: idle -> connecting -> connected -> closing -> closed.
//
// Design rules (see the plan, sections 7 and 9.5):
// - Every connection attempt gets an id; events from an older socket are ignored, so a late
//   'close' or 'error' can never corrupt a newer connection.
// - A single deadline timer covers name lookup and connect (socket.setTimeout() would only emit
//   an event and does not cover lookup).
// - "end" and "close" are folded into ONE normalized `terminated` event.
// - Writes are serialized; each waits for the previous write's callback (this also handles
//   backpressure).
// The socket factory, clock and scheduler are injected so every path can be tested.
const net = require('node:net');
const { createWindowLimiter } = require('./rate-limit');

const DEFAULTS = {
  timeoutMs: 5000,
  closeGraceMs: 1000,
  maxHistory: 1000,
  maxQueuedWrites: 1000,
  // A peer that sends faster than this is slowed down (the socket is paused, so the operating
  // system's flow control makes it wait; nothing is dropped): a hostile or broken device must not
  // be able to keep the program busy decoding and drawing data.
  recvChunksPerSecond: 2000,
  recvBytesPerSecond: 4 * 1024 * 1024,
  throttlePauseMs: 200,
};

function isValidTarget(host, port) {
  return typeof host === 'string'
    && host.length >= 1
    && host.length <= 253
    && /^[^\s\u0000-\u001f\u007f]+$/.test(host)
    && Number.isInteger(port)
    && port >= 1
    && port <= 65535;
}

function createConnection({
  createSocket = () => new net.Socket(),
  scheduler = { setTimeout, clearTimeout },
  now = Date.now,
  onEvent = () => {},
  closeGraceMs = DEFAULTS.closeGraceMs,
  recvChunksPerSecond = DEFAULTS.recvChunksPerSecond,
  recvBytesPerSecond = DEFAULTS.recvBytesPerSecond,
  throttlePauseMs = DEFAULTS.throttlePauseMs,
  maxHistory = DEFAULTS.maxHistory,
  maxQueuedWrites = DEFAULTS.maxQueuedWrites,
  // A bug in an event listener must not break socket handling or the write chain; it is
  // reported here instead of being swallowed.
  onListenerError = (error) => console.error('[connection] event listener failed:', error),
} = {}) {
  let nextId = 1;
  let current = null;
  let state = 'idle';
  let history = [];

  function notify(stamped) {
    try {
      onEvent(stamped);
    } catch (error) {
      onListenerError(error);
    }
  }

  function emit(event) {
    const stamped = { t: now(), ...event };
    notify(stamped);
    return stamped;
  }

  // Only facts the diagnostic rules need are kept; received payloads are not stored.
  function record(event) {
    const { bytes, ...fact } = event;
    history.push(fact);
    if (history.length > maxHistory) {
      history = history.slice(history.length - maxHistory);
    }
  }

  // Record first, then notify: a listener that reads getHistory() (to compute hints) must see
  // the event it was just told about.
  function emitFact(event) {
    const stamped = { t: now(), ...event };
    record(stamped);
    notify(stamped);
  }

  function setState(connection, next) {
    connection.state = next;
    state = next;
    emit({ type: 'state', id: connection.id, state: next });
  }

  function isCurrent(connection) {
    return current !== null && current.id === connection.id;
  }

  function clearTimers(connection) {
    if (connection.connectTimer !== null) {
      scheduler.clearTimeout(connection.connectTimer);
      connection.connectTimer = null;
    }
    if (connection.graceTimer !== null) {
      scheduler.clearTimeout(connection.graceTimer);
      connection.graceTimer = null;
    }
    if (connection.resumeTimer !== null) {
      scheduler.clearTimeout(connection.resumeTimer);
      connection.resumeTimer = null;
    }
  }

  function destroyQuietly(socket) {
    try {
      socket.destroy();
    } catch {
      // The socket is being discarded; a failure to destroy changes nothing we can act on.
    }
  }

  // Resolves every write that has not finished. A real socket reports an error for such writes
  // when destroyed, but we must not depend on that: a pending promise would keep the whole
  // queue (and the buffers it holds) alive.
  function resolvePendingWrites(connection) {
    for (const settle of [...connection.pendingWrites]) {
      settle({ ok: false, code: 'not_connected' });
    }
  }

  function failConnect(connection, code) {
    if (!isCurrent(connection) || connection.state !== 'connecting') return;
    clearTimers(connection);
    // Mark as settled first so the 'close' that follows destroy() is not reported as a termination.
    connection.settled = true;
    resolvePendingWrites(connection);
    destroyQuietly(connection.socket);
    emitFact({ type: 'connect_fail', id: connection.id, code });
    setState(connection, 'closed');
  }

  function handleClose(connection, hadError) {
    if (!isCurrent(connection) || connection.settled) return;
    clearTimers(connection);
    if (connection.state === 'connecting') {
      // Closed before connecting without an 'error' event: still a failed connect.
      failConnect(connection, connection.lastErrorCode ?? 'ECONNRESET');
      return;
    }
    connection.settled = true;
    resolvePendingWrites(connection);
    let initiator;
    if (connection.userRequested) {
      initiator = 'local';
    } else if (hadError || connection.lastErrorCode !== null) {
      initiator = 'error';
    } else {
      initiator = 'peer';
    }
    emitFact({
      type: 'terminated',
      id: connection.id,
      initiator,
      hadError: Boolean(hadError),
      errorCode: connection.lastErrorCode,
      finSeen: connection.finSeen,
      userRequested: connection.userRequested,
    });
    setState(connection, 'closed');
  }

  function wireSocket(connection, keepAlive) {
    const { socket } = connection;

    socket.on('connect', () => {
      if (!isCurrent(connection) || connection.state !== 'connecting') return;
      clearTimers(connection);
      if (keepAlive.enabled) {
        socket.setKeepAlive(true, keepAlive.initialDelayMs);
      }
      setState(connection, 'connected');
      emitFact({ type: 'connect_ok', id: connection.id });
    });

    socket.on('data', (chunk) => {
      if (!isCurrent(connection) || connection.settled) return;
      if (connection.state !== 'connected' && connection.state !== 'closing') return;
      // Copy: the Buffer may be reused or mutated by the caller of this event.
      emitFact({ type: 'recv', id: connection.id, bytes: Uint8Array.from(chunk) });
      // Too much at once: stop reading for a moment (the data stays in the operating system).
      if (!connection.recvLimiter.take(now(), chunk.length) && !connection.recvPaused) {
        connection.recvPaused = true;
        socket.pause();
        // Told to the user at most once a second, however often the pause repeats.
        if (now() - connection.lastThrottleReportAt >= 1000) {
          connection.lastThrottleReportAt = now();
          emitFact({ type: 'recv_throttled', id: connection.id });
        }
        connection.resumeTimer = scheduler.setTimeout(() => {
          connection.resumeTimer = null;
          connection.recvPaused = false;
          if (isCurrent(connection) && !connection.settled) socket.resume();
        }, throttlePauseMs);
      }
    });

    socket.on('end', () => {
      if (!isCurrent(connection)) return;
      connection.finSeen = true;
    });

    socket.on('error', (error) => {
      if (!isCurrent(connection) || connection.settled) return;
      connection.lastErrorCode = (error && error.code) || 'UNKNOWN';
      if (connection.state === 'connecting') {
        failConnect(connection, connection.lastErrorCode);
      }
      // After connecting, 'close' follows and reports the termination once.
    });

    socket.on('close', (hadError) => handleClose(connection, hadError));
  }

  function connect({ host, port, timeoutMs = DEFAULTS.timeoutMs, keepAlive } = {}) {
    // The renderer is not trusted: validate the target here as well.
    if (!isValidTarget(host, port)) {
      return { ok: false, code: 'invalid_target' };
    }
    if (state === 'connecting' || state === 'connected' || state === 'closing') {
      return { ok: false, code: 'busy' };
    }

    const connection = {
      id: nextId++,
      socket: createSocket(),
      state: 'idle',
      settled: false,
      userRequested: false,
      finSeen: false,
      lastErrorCode: null,
      connectTimer: null,
      graceTimer: null,
      writeChain: Promise.resolve(),
      // Writes accepted by send() but not finished yet (queued or in flight).
      queuedWrites: 0,
      pendingWrites: new Set(),
      recvLimiter: createWindowLimiter(recvChunksPerSecond, recvBytesPerSecond),
      recvPaused: false,
      resumeTimer: null,
      lastThrottleReportAt: -Infinity,
    };
    current = connection;
    history = [];
    setState(connection, 'connecting');

    wireSocket(connection, {
      enabled: Boolean(keepAlive && keepAlive.enabled),
      initialDelayMs: (keepAlive && keepAlive.initialDelayMs) || 30000,
    });

    // The deadline starts before connect() so name lookup counts against it.
    connection.connectTimer = scheduler.setTimeout(() => failConnect(connection, 'CONNECT_TIMEOUT'), timeoutMs);
    try {
      connection.socket.connect({ host, port });
    } catch (error) {
      failConnect(connection, (error && error.code) || 'UNKNOWN');
    }
    return { ok: true, id: connection.id };
  }

  // After the peer's FIN the socket cannot take new writes (a real socket would fail with EPIPE).
  function canWrite(connection) {
    return isCurrent(connection) && connection.state === 'connected' && !connection.finSeen;
  }

  // Backpressure: only one write is ever outstanding, and the next starts after this one's
  // callback, so the socket's buffer never holds more than one chunk and no 'drain' wait is needed.
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
      // queue (for example read-only mode was switched on). Checked at the moment of writing.
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
      connection.pendingWrites.add(settle);
      emitFact({
        type: 'send',
        id: connection.id,
        expectsReply: Boolean(meta.expectsReply),
        endsWithTerminator: Boolean(meta.endsWithTerminator),
      });
      try {
        connection.socket.write(Buffer.from(bytes), (error) => {
          settle(error ? { ok: false, code: 'write_failed', errno: error.code } : { ok: true });
        });
      } catch (error) {
        settle({ ok: false, code: 'write_failed', errno: error.code });
      }
    });
  }

  function send(bytes, meta = {}) {
    if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
      return Promise.resolve({ ok: false, code: 'invalid_data' });
    }
    const connection = current;
    if (connection === null || !canWrite(connection)) {
      return Promise.resolve({ ok: false, code: 'not_connected' });
    }
    // A stuck device must not let callers pile up unbounded work.
    if (connection.queuedWrites >= maxQueuedWrites) {
      return Promise.resolve({ ok: false, code: 'queue_full' });
    }
    connection.queuedWrites += 1;
    // Chain on the previous write so writes keep their order and never overlap.
    const result = connection.writeChain
      .then(() => writeBytes(connection, bytes, meta))
      .finally(() => { connection.queuedWrites -= 1; });
    // The chain itself never rejects, so one failure cannot block later writes.
    connection.writeChain = result.catch(() => ({ ok: false, code: 'write_failed' }));
    return result;
  }

  function disconnect() {
    const connection = current;
    if (connection === null || connection.state === 'closed' || connection.state === 'closing') {
      return { ok: true };
    }
    connection.userRequested = true;

    if (connection.state === 'connecting') {
      // Cancelled by the user: not a failure, so no connect_fail event.
      clearTimers(connection);
      connection.settled = true;
      resolvePendingWrites(connection);
      destroyQuietly(connection.socket);
      setState(connection, 'closed');
      return { ok: true };
    }

    setState(connection, 'closing');
    connection.socket.end();
    // If the peer never completes the close, force it.
    connection.graceTimer = scheduler.setTimeout(() => destroyQuietly(connection.socket), closeGraceMs);
    return { ok: true };
  }

  function setKeepAlive(enabled, initialDelayMs) {
    if (current === null || current.state !== 'connected') {
      return { ok: false, code: 'not_connected' };
    }
    current.socket.setKeepAlive(Boolean(enabled), initialDelayMs);
    return { ok: true };
  }

  return {
    connect,
    send,
    disconnect,
    setKeepAlive,
    getState: () => state,
    // Identifies the current connection attempt; a confirmation dialog pins it so an approval
    // given for one connection cannot be used on another.
    getId: () => (current === null ? null : current.id),
    getHistory: () => history.slice(),
  };
}

module.exports = { createConnection, DEFAULTS };
