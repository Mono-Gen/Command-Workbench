// The device role: a TCP server that behaves according to a device definition.
//
// This module only does the "plumbing" (sockets, timers, queues, limits). What the device says
// and how its state changes is decided by the pure engine in core/device-engine.js, which returns
// "effects" (bytes to send, to whom, after what delay). The server turns effects into writes.
//
// Rules (see the Phase 2 plan, sections 5.5 and 6):
//  - Each connection has its own FIFO send queue; a delayed reply holds the queue, so later
//    replies never overtake it (like a device that handles one thing at a time).
//  - Idle time is measured per connection from the last COMPLETE message (TCP keepalive, half
//    received and oversized messages do not count).
//  - "Refusing" a connection is accept-then-close: a listening TCP port cannot refuse selectively.
//  - Start/stop carry a generation id; stopping waits for the listening socket to be released
//    before a new start is allowed (otherwise the port may still be busy). A stop during a start
//    cancels the start.
//  - Silence ("stopped responding") and the mute fault are checked again at WRITE time, so a reply
//    that was queued earlier cannot slip out afterwards.
//  - Every socket gets an 'error' listener first of all (an unhandled 'error' event would crash the
//    main process), including sockets that are refused at once.
//  - Limits protect the host, especially when listening on all interfaces.
// Sockets, the server factory, the clock and the scheduler are injected so every path can be tested.
const net = require('node:net');
const { createFramer } = require('../core/framing');
const { createDeviceEngine } = require('../core/device-engine');

const ALLOWED_HOSTS = ['127.0.0.1', '0.0.0.0'];

const DEFAULT_LIMITS = {
  maxQueueItems: 1000,
  maxQueueBytes: 1024 * 1024,
  acceptsPerSecond: 20,
  // A write that is not completed in this time closes the connection (a peer that never reads).
  writeTimeoutMs: 10000,
  // Bytes received without ever completing a message (hostile or broken peer).
  maxUnterminatedBytes: 64 * 1024,
  // Only when listening on all interfaces (a LAN peer is not trusted):
  lanMessagesPerSecond: 200,
  lanFirstMessageMs: 30000,
  closeGraceMs: 500,
};

// Port 0 asks the OS for a free port. Ports below 1024 need elevated rights on some systems and
// are never useful for a practice device.
const isValidPort = (port) => Number.isInteger(port) && (port === 0 || (port >= 1024 && port <= 65535));

function createDeviceServer({
  createServer = (handler) => net.createServer(handler),
  scheduler = { setTimeout, clearTimeout },
  now = Date.now,
  onEvent = () => {},
  onListenerError = (error) => console.error('[device-server] event listener failed:', error),
  limits = {},
} = {}) {
  const lim = { ...DEFAULT_LIMITS, ...limits };
  let generation = 0;
  let lifecycle = 'idle'; // idle | starting | running | stopping
  let run = null;
  let startingRun = null;
  let stopPromise = null;
  let nextConnectionId = 1;

  function emit(event) {
    try {
      onEvent({ t: now(), generation: run ? run.generation : generation, ...event });
    } catch (error) {
      onListenerError(error);
    }
  }

  // ---- sending ------------------------------------------------------------------------

  function dropQueued(conn, item) {
    conn.queue.shift();
    conn.queueBytes -= item.bytes.length;
    conn.sending = false;
  }

  function pump(conn) {
    if (conn.sending || conn.closed || conn.queue.length === 0) return;
    conn.sending = true;
    const item = conn.queue[0];

    const write = () => {
      conn.delayTimer = null;
      if (conn.closed) return;
      // Conditions may have changed while this item waited (queue, delay): honor them now.
      if (conn.silent || conn.run.faults.muted) {
        dropQueued(conn, item);
        emit({ type: 'muted', connectionId: conn.id, bytes: item.bytes });
        pump(conn);
        return;
      }
      conn.writeTimer = scheduler.setTimeout(() => closeConnection(conn, 'write_timeout'), lim.writeTimeoutMs);
      conn.socket.write(Buffer.from(item.bytes), (error) => {
        if (conn.closed) return;
        scheduler.clearTimeout(conn.writeTimer);
        conn.writeTimer = null;
        dropQueued(conn, item);
        if (error) {
          closeConnection(conn, 'write_error');
          return;
        }
        emit({ type: 'tx', connectionId: conn.id, kind: item.kind, bytes: item.bytes });
        pump(conn);
      });
    };

    if (item.delayMs > 0) {
      conn.delayTimer = scheduler.setTimeout(write, item.delayMs);
    } else {
      write();
    }
  }

  function enqueue(conn, item) {
    conn.queue.push(item);
    conn.queueBytes += item.bytes.length;
    // A peer that never reads must not make us buffer without limit.
    if (conn.queue.length > lim.maxQueueItems || conn.queueBytes > lim.maxQueueBytes) {
      closeConnection(conn, 'queue_overflow');
      return;
    }
    pump(conn);
  }

  // Applies the runtime faults and the per-connection "stopped responding" state, then queues.
  function deliver(r, senderConn, effect) {
    if (effect.kind === 'reply' && r.faults.dropNextReplies > 0) {
      r.faults.dropNextReplies -= 1;
      emit({ type: 'dropped', connectionId: senderConn.id, bytes: effect.bytes });
      return;
    }
    const targets = effect.to === 'sender' ? [senderConn] : [...r.connections.values()];
    for (const target of targets) {
      if (target.closed) continue;
      if (r.faults.muted) {
        emit({ type: 'muted', connectionId: target.id, bytes: effect.bytes });
        continue;
      }
      // After the idle "stop responding" behavior nothing is sent on that connection.
      if (target.silent) continue;
      const delayMs = effect.kind === 'reply' ? effect.delayMs + r.faults.extraDelayMs : 0;
      enqueue(target, { bytes: effect.bytes, delayMs, kind: effect.kind });
    }
  }

  // ---- connection lifecycle -----------------------------------------------------------

  function closeConnection(conn, reason, { graceful = false } = {}) {
    if (conn.closed) return;
    conn.closed = true;
    scheduler.clearTimeout(conn.idleTimer);
    scheduler.clearTimeout(conn.firstMessageTimer);
    scheduler.clearTimeout(conn.delayTimer);
    scheduler.clearTimeout(conn.writeTimer);
    conn.queue.length = 0;
    conn.queueBytes = 0;
    conn.run.connections.delete(conn.id);
    emit({ type: 'connection_closed', connectionId: conn.id, reason });

    if (graceful) {
      try { conn.socket.end(); } catch { /* the socket may already be gone */ }
      // A peer that never completes the close must not keep the socket alive. The timer is cleared
      // as soon as the socket really closes (see openConnection).
      conn.graceTimer = scheduler.setTimeout(() => { try { conn.socket.destroy(); } catch { /* already gone */ } }, lim.closeGraceMs);
    } else {
      try { conn.socket.destroy(); } catch { /* already gone */ }
    }
  }

  function resetIdle(conn) {
    scheduler.clearTimeout(conn.idleTimer);
    conn.idleTimer = null;
    conn.idleAt = null;
    const ms = conn.run.definition.connection.idleTimeoutMs;
    if (ms > 0 && !conn.silent && !conn.closed) {
      conn.idleAt = now() + ms;
      conn.idleTimer = scheduler.setTimeout(() => onIdle(conn), ms);
    }
  }

  function onIdle(conn) {
    if (conn.closed) return;
    const behavior = conn.run.definition.connection.idleBehavior;
    emit({ type: 'idle', connectionId: conn.id, behavior });
    if (behavior === 'close') {
      closeConnection(conn, 'idle', { graceful: true });
    } else {
      // Irreversible for this connection: it stays open but the device no longer answers.
      conn.silent = true;
      conn.idleAt = null;
      conn.idleTimer = null;
    }
  }

  function processMessage(conn, event) {
    const r = conn.run;
    const t = now();
    const overflow = event.type === 'overflow';

    if (r.lan) {
      conn.messageTimes = conn.messageTimes.filter((x) => t - x < 1000);
      conn.messageTimes.push(t);
      if (conn.messageTimes.length > lim.lanMessagesPerSecond) {
        closeConnection(conn, 'rate_limit');
        return;
      }
    }

    // Only a COMPLETE message proves the peer is talking to us; an oversized one is discarded and
    // must not keep the connection alive (it does not reset the deadlines).
    if (!overflow) {
      scheduler.clearTimeout(conn.firstMessageTimer);
      conn.firstMessageTimer = null;
      resetIdle(conn);

      const minInterval = r.definition.connection.minCommandIntervalMs;
      const tooSoon = minInterval > 0 && conn.lastMessageAt !== null && t - conn.lastMessageAt < minInterval;
      conn.lastMessageAt = t;
      if (tooSoon) {
        emit({ type: 'ignored', connectionId: conn.id, reason: 'interval' });
        return;
      }
    }

    // An oversized message cannot be matched; feeding invalid UTF-8 makes the engine answer with
    // its "unknown" handler, which is the specified behavior for it.
    const outcome = r.engine.handleMessage(overflow ? Uint8Array.of(0xff) : event.bytes);
    emit({
      type: 'rx',
      connectionId: conn.id,
      bytes: overflow ? new Uint8Array(0) : event.bytes,
      overflow,
      outcome: outcome.outcome,
      commandIndex: outcome.commandIndex,
    });
    if (outcome.changes.length > 0) {
      emit({ type: 'variables', values: r.engine.getState().values, changes: outcome.changes });
    }
    for (const effect of outcome.effects) deliver(r, conn, effect);
  }

  function openConnection(r, socket) {
    const conn = {
      id: nextConnectionId++,
      run: r,
      socket,
      framer: createFramer({ terminator: r.definition.framing.terminator }),
      queue: [],
      queueBytes: 0,
      sending: false,
      silent: false,
      closed: false,
      connectedAt: now(),
      lastMessageAt: null,
      idleAt: null,
      idleTimer: null,
      firstMessageTimer: null,
      delayTimer: null,
      writeTimer: null,
      graceTimer: null,
      rawSinceMessage: 0,
      messageTimes: [],
      remote: `${socket.remoteAddress ?? ''}:${socket.remotePort ?? ''}`,
    };
    r.connections.set(conn.id, conn);
    if (typeof socket.setNoDelay === 'function') socket.setNoDelay(true);
    emit({ type: 'connection_opened', connectionId: conn.id, remote: conn.remote });

    socket.on('data', (chunk) => {
      if (conn.closed || run !== r) return;
      conn.rawSinceMessage += chunk.length;
      let completed = false;
      for (const event of conn.framer.push(Uint8Array.from(chunk))) {
        if (conn.closed) break;
        if (event.type === 'message') completed = true;
        processMessage(conn, event);
      }
      if (conn.closed) return;
      if (completed) conn.rawSinceMessage = 0;
      // A peer that keeps sending without ever finishing a message is cut off.
      if (conn.rawSinceMessage > lim.maxUnterminatedBytes) closeConnection(conn, 'oversize');
    });
    // A FIN from the peer: no more commands will come, so just finish.
    socket.on('end', () => closeConnection(conn, 'peer'));
    socket.on('error', () => closeConnection(conn, 'error'));
    socket.on('close', () => {
      scheduler.clearTimeout(conn.graceTimer);
      closeConnection(conn, 'peer');
    });

    const greeting = r.engine.greeting();
    if (greeting && !r.faults.muted) enqueue(conn, { bytes: greeting, delayMs: 0, kind: 'greeting' });
    resetIdle(conn);
    if (r.lan) {
      conn.firstMessageTimer = scheduler.setTimeout(() => closeConnection(conn, 'no_message'), lim.lanFirstMessageMs);
    }
    return conn;
  }

  // Closes a refused socket politely (greeting + FIN) or at once, and tracks its grace timer.
  function refuseSocket(socket, { greeting = null } = {}) {
    if (greeting) {
      socket.write(Buffer.from(greeting), () => socket.end());
      const timer = scheduler.setTimeout(() => { try { socket.destroy(); } catch { /* already gone */ } }, lim.closeGraceMs);
      socket.on('close', () => scheduler.clearTimeout(timer));
    } else {
      socket.destroy();
    }
  }

  function onSocket(r, socket) {
    // First of all: without an 'error' listener a reset during a refused connection would be an
    // uncaught exception in the main process.
    socket.on('error', () => {});

    if (run !== r || lifecycle !== 'running') {
      socket.destroy();
      return;
    }
    const t = now();

    // Accept rate: a flood of connections must not exhaust the host. A fixed window with a counter
    // uses constant memory and constant time per connection.
    if (t - r.acceptWindowStart >= 1000) {
      r.acceptWindowStart = t;
      r.acceptCount = 0;
      r.acceptLimitReported = false;
    }
    r.acceptCount += 1;
    if (r.acceptCount > lim.acceptsPerSecond) {
      socket.destroy();
      if (!r.acceptLimitReported) {
        r.acceptLimitReported = true;
        emit({ type: 'refused', reason: 'rate_limit' });
      }
      return;
    }
    // A device that is still starting up: the port is open but nobody answers.
    if (t < r.quietUntil) {
      socket.destroy();
      emit({ type: 'refused', reason: 'startup' });
      return;
    }
    const { maxConnections, overLimit } = r.definition.connection;
    if (r.connections.size >= maxConnections) {
      emit({ type: 'refused', reason: 'limit', behavior: overLimit });
      if (overLimit === 'accept_then_close') {
        // Accepted, greeted, then closed: the controller sees a normal connect followed by a close.
        const greeting = r.engine.greeting();
        refuseSocket(socket, { greeting: greeting && !r.faults.muted ? greeting : null });
        if (!greeting || r.faults.muted) socket.end();
      } else {
        socket.destroy();
      }
      return;
    }
    openConnection(r, socket);
  }

  // ---- public API -----------------------------------------------------------------------

  function start({ definition, host, port }) {
    if (lifecycle !== 'idle') return Promise.resolve({ ok: false, code: lifecycle === 'running' ? 'already_running' : 'busy' });
    if (!ALLOWED_HOSTS.includes(host)) return Promise.resolve({ ok: false, code: 'invalid_host' });
    if (!isValidPort(port)) return Promise.resolve({ ok: false, code: 'invalid_port' });
    let engine;
    try {
      engine = createDeviceEngine(definition);
    } catch {
      return Promise.resolve({ ok: false, code: 'invalid_definition' });
    }

    lifecycle = 'starting';
    generation += 1;
    const r = {
      generation,
      definition,
      engine,
      host,
      port,
      lan: host === '0.0.0.0',
      connections: new Map(),
      acceptWindowStart: 0,
      acceptCount: 0,
      acceptLimitReported: false,
      quietUntil: 0,
      faults: { dropNextReplies: 0, extraDelayMs: 0, muted: false },
      server: null,
      cancelRequested: false,
      onStartFinished: null,
    };
    startingRun = r;
    r.server = createServer((socket) => onSocket(r, socket));

    return new Promise((resolve) => {
      const finish = (result) => {
        startingRun = null;
        resolve(result);
        if (r.onStartFinished) r.onStartFinished();
      };

      const onListenError = (error) => {
        lifecycle = 'idle';
        finish({ ok: false, code: 'listen_failed', errno: error && error.code });
      };
      r.server.once('error', onListenError);
      r.server.listen({ host, port }, () => {
        r.server.removeListener('error', onListenError);
        if (r.cancelRequested) {
          // stop() was called while starting: release the port again and report the cancellation.
          r.server.close(() => {
            lifecycle = 'idle';
            finish({ ok: false, code: 'cancelled' });
          });
          return;
        }
        r.server.on('error', (error) => {
          // Ignore errors of a server that is no longer the current one (a late event of an old run).
          if (run !== r) return;
          emit({ type: 'server_error', errno: error && error.code });
          stop();
        });
        run = r;
        lifecycle = 'running';
        r.port = r.server.address().port;
        r.quietUntil = now() + definition.connection.startupQuietMs;
        emit({ type: 'listening', host, port: r.port });
        finish({ ok: true, host, port: r.port, generation: r.generation });
      });
    });
  }

  function stop() {
    if (lifecycle === 'idle') return Promise.resolve({ ok: true });
    if (lifecycle === 'stopping') return stopPromise;
    if (lifecycle === 'starting') {
      // Cancel the start that is still in progress and wait until the port is released again.
      const pending = startingRun;
      pending.cancelRequested = true;
      return new Promise((resolve) => { pending.onStartFinished = () => resolve({ ok: true }); });
    }

    lifecycle = 'stopping';
    const r = run;
    for (const conn of [...r.connections.values()]) closeConnection(conn, 'stop');
    stopPromise = new Promise((resolve) => {
      // The port is free only after the server reports it is closed.
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

  function setFault(faults) {
    if (lifecycle !== 'running') return { ok: false, code: 'not_running' };
    if (faults === null || typeof faults !== 'object') return { ok: false, code: 'invalid_arguments' };
    const known = ['dropNextReplies', 'extraDelayMs', 'muted'].filter((key) => faults[key] !== undefined);
    // A call that changes nothing is a mistake, not a request.
    if (known.length === 0) return { ok: false, code: 'invalid_arguments' };

    const next = { ...run.faults };
    if (faults.dropNextReplies !== undefined) {
      if (!Number.isInteger(faults.dropNextReplies) || faults.dropNextReplies < 0 || faults.dropNextReplies > 1000) return { ok: false, code: 'invalid_arguments' };
      next.dropNextReplies = faults.dropNextReplies;
    }
    if (faults.extraDelayMs !== undefined) {
      if (!Number.isInteger(faults.extraDelayMs) || faults.extraDelayMs < 0 || faults.extraDelayMs > 60000) return { ok: false, code: 'invalid_arguments' };
      next.extraDelayMs = faults.extraDelayMs;
    }
    if (faults.muted !== undefined) {
      if (typeof faults.muted !== 'boolean') return { ok: false, code: 'invalid_arguments' };
      next.muted = faults.muted;
    }
    run.faults = next;
    emit({ type: 'faults', faults: { ...next } });
    return { ok: true, faults: { ...next } };
  }

  function closeAllConnections() {
    if (lifecycle !== 'running') return { ok: false, code: 'not_running' };
    const all = [...run.connections.values()];
    for (const conn of all) closeConnection(conn, 'fault', { graceful: true });
    return { ok: true, closed: all.length };
  }

  function getState() {
    if (lifecycle !== 'running') return { running: false, lifecycle, connections: [] };
    const t = now();
    return {
      running: true,
      lifecycle,
      host: run.host,
      port: run.port,
      generation: run.generation,
      lan: run.lan,
      variables: run.engine.getState().values,
      faults: { ...run.faults },
      connections: [...run.connections.values()].map((c) => ({
        id: c.id,
        remote: c.remote,
        connectedAt: c.connectedAt,
        lastMessageAt: c.lastMessageAt,
        idleInMs: c.idleAt === null ? null : Math.max(0, c.idleAt - t),
        silent: c.silent,
      })),
    };
  }

  return { start, stop, setFault, closeAllConnections, getState };
}

module.exports = { createDeviceServer, ALLOWED_HOSTS, DEFAULT_LIMITS, isValidPort };
