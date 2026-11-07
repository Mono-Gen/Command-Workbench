// The device role over UDP: one datagram socket that behaves according to a device definition.
//
// A sibling of device-server.js with the SAME outward shape (start / stop / setFault /
// closeAllConnections / getState and the same event types), so device-service.js can pick either
// by the definition's `transport`. What is different (see the Phase 4 plan, 5.3 and 12.4):
//  - There is no connection. A "peer" is a source (address:port) that sent us a datagram. Peers
//    are tracked only to give each one its own reply queue, minimum interval and expiry. Every
//    peer has a FINITE lifetime (idleTimeoutMs, or 300 s when that is 0); both idle behaviors end
//    with "forget the peer", so no peer is ever silenced forever.
//  - One datagram is one message (a single trailing terminator is stripped, see core/datagram.js).
//  - The engine state (variables) is shared by all peers, like all connections of a TCP device.
//  - A notification (`to: all`) goes to the peers that exist when the effect is produced; a delayed
//    reply waits in its peer's FIFO queue, so later replies never overtake it.
//  - Source addresses can be forged. When listening on all interfaces a forged source could make
//    this device send replies to a third party, so replies are limited by byte token buckets
//    (whole device and per peer), and everything received is limited BEFORE a peer is registered,
//    the engine runs or anything is logged. This reduces the reflected traffic; it cannot remove it.
//  - A reply to a datagram is sent from the bound socket, so the peer sees our port as the source.
// Start/stop carry a generation id; a stop during a start cancels the start; stopping waits for
// the socket's 'close' event so the port is free before a new start is allowed. The socket
// factory, the clock and the scheduler are injected so every path can be tested.
const dgram = require('node:dgram');
const { toMessage } = require('../core/datagram');
const { createDeviceEngine } = require('../core/device-engine');
const { createWindowLimiter, createBucket } = require('./rate-limit');
const { releaseThen, createNoticeThrottle } = require('./udp-net');

const ALLOWED_HOSTS = ['127.0.0.1', '0.0.0.0'];

const DEFAULT_LIMITS = {
  maxQueueItems: 1000,
  maxQueueBytes: 1024 * 1024,
  // A datagram longer than this cannot be matched (same limit as a TCP message).
  maxMessageBytes: 4096,
  // Received datagrams / bytes per second, checked first of all (sliding window).
  recvPerSecond: 2000,
  recvBytesPerSecond: 4 * 1024 * 1024,
  lanRecvPerSecond: 200,
  lanRecvBytesPerSecond: 256 * 1024,
  // Reply bytes per second (token buckets with one second of burst).
  replyBytesPerSecond: 1024 * 1024,
  replyBytesPerSecondPerPeer: 256 * 1024,
  lanReplyBytesPerSecond: 32 * 1024,
  lanReplyBytesPerSecondPerPeer: 8 * 1024,
  // A peer that never has idleTimeoutMs set still expires.
  defaultPeerLifetimeMs: 300000,
  // The same kind of notice (refused, send_error ...) is reported at most this often.
  reportIntervalMs: 1000,
};

// Port 0 asks the OS for a free port; ports below 1024 are never useful for a practice device.
const isValidPort = (port) => Number.isInteger(port) && (port === 0 || (port >= 1024 && port <= 65535));

function createDeviceUdpServer({
  createSocket = () => dgram.createSocket({ type: 'udp4' }),
  scheduler = { setTimeout, clearTimeout },
  now = Date.now,
  onEvent = () => {},
  onListenerError = (error) => console.error('[device-udp-server] event listener failed:', error),
  limits = {},
} = {}) {
  const lim = { ...DEFAULT_LIMITS, ...limits };
  let generation = 0;
  let lifecycle = 'idle'; // idle | starting | running | stopping
  let run = null;
  let startingRun = null;
  let stopPromise = null;
  let nextPeerId = 1;

  function emit(event) {
    try {
      onEvent({ t: now(), generation: run ? run.generation : generation, ...event });
    } catch (error) {
      onListenerError(error);
    }
  }

  // Notices a remote source can provoke at will are reported at most once per interval per kind.
  function report(r, key, event) {
    r.notice(key, () => emit(event));
  }

  // ---- sending ------------------------------------------------------------------------

  function dropQueued(peer, item) {
    peer.queue.shift();
    peer.queueBytes -= item.bytes.length;
    peer.sending = false;
  }

  function pump(peer) {
    if (peer.sending || peer.closed || peer.queue.length === 0) return;
    peer.sending = true;
    const item = peer.queue[0];
    const r = peer.run;

    const write = () => {
      peer.delayTimer = null;
      if (peer.closed) return;
      // Conditions may have changed while this item waited (queue, delay): honor them now.
      if (r.faults.muted) {
        dropQueued(peer, item);
        emit({ type: 'muted', connectionId: peer.id, bytes: item.bytes });
        pump(peer);
        return;
      }
      // Reflection guard: a reply that does not fit the budget is discarded, not delayed.
      const size = item.bytes.length;
      if (!r.replyBucket.has(size) || !peer.replyBucket.has(size)) {
        dropQueued(peer, item);
        report(r, 'reply_rate_limit', { type: 'refused', reason: 'reply_rate_limit' });
        pump(peer);
        return;
      }
      r.replyBucket.take(size);
      peer.replyBucket.take(size);

      const finish = (error) => {
        if (peer.closed || peer.run !== r) return;
        dropQueued(peer, item);
        if (error) {
          report(r, 'send_error', { type: 'send_error', connectionId: peer.id, errno: error.code });
        } else {
          emit({ type: 'tx', connectionId: peer.id, kind: item.kind, bytes: item.bytes });
        }
        pump(peer);
      };
      try {
        r.socket.send(Buffer.from(item.bytes), peer.port, peer.address, finish);
      } catch (error) {
        finish(error);
      }
    };

    if (item.delayMs > 0) {
      peer.delayTimer = scheduler.setTimeout(write, item.delayMs);
    } else {
      write();
    }
  }

  function enqueue(peer, item) {
    peer.queue.push(item);
    peer.queueBytes += item.bytes.length;
    // Delayed replies pile up only as fast as datagrams are accepted, but the queue is bounded anyway.
    if (peer.queue.length > lim.maxQueueItems || peer.queueBytes > lim.maxQueueBytes) {
      closePeer(peer, 'queue_overflow');
      return;
    }
    pump(peer);
  }

  // Applies the runtime faults, then queues the effect for the right peers.
  function deliver(r, sender, effect) {
    if (effect.kind === 'reply' && r.faults.dropNextReplies > 0) {
      r.faults.dropNextReplies -= 1;
      emit({ type: 'dropped', connectionId: sender.id, bytes: effect.bytes });
      return;
    }
    const targets = effect.to === 'sender' ? [sender] : [...r.peers.values()];
    for (const target of targets) {
      if (target.closed) continue;
      if (r.faults.muted) {
        emit({ type: 'muted', connectionId: target.id, bytes: effect.bytes });
        continue;
      }
      const delayMs = effect.kind === 'reply' ? effect.delayMs + r.faults.extraDelayMs : 0;
      enqueue(target, { bytes: effect.bytes, delayMs, kind: effect.kind });
    }
  }

  // ---- peers ----------------------------------------------------------------------------

  function closePeer(peer, reason) {
    if (peer.closed) return;
    peer.closed = true;
    scheduler.clearTimeout(peer.idleTimer);
    scheduler.clearTimeout(peer.delayTimer);
    peer.idleTimer = null;
    peer.delayTimer = null;
    peer.queue.length = 0;
    peer.queueBytes = 0;
    peer.run.peers.delete(peer.key);
    emit({ type: 'connection_closed', connectionId: peer.id, reason });
  }

  function resetIdle(peer) {
    scheduler.clearTimeout(peer.idleTimer);
    const configured = peer.run.definition.connection.idleTimeoutMs;
    const ms = configured > 0 ? configured : lim.defaultPeerLifetimeMs;
    peer.idleAt = now() + ms;
    peer.idleTimer = scheduler.setTimeout(() => onIdle(peer), ms);
  }

  function onIdle(peer) {
    if (peer.closed) return;
    const connection = peer.run.definition.connection;
    if (connection.idleTimeoutMs > 0) {
      emit({ type: 'idle', connectionId: peer.id, behavior: connection.idleBehavior });
      // Both behaviors forget the peer: there is no connection to keep open, and a peer that is
      // silenced forever would be a trap.
      closePeer(peer, 'idle');
    } else {
      closePeer(peer, 'expired');
    }
  }

  function openPeer(r, rinfo) {
    const peer = {
      id: nextPeerId++,
      run: r,
      key: `${rinfo.address}:${rinfo.port}`,
      address: rinfo.address,
      port: rinfo.port,
      queue: [],
      queueBytes: 0,
      sending: false,
      closed: false,
      connectedAt: now(),
      lastMessageAt: null,
      intervalReportedAt: null,
      idleAt: null,
      idleTimer: null,
      delayTimer: null,
      replyBucket: createBucket(r.peerReplyRate, now),
    };
    r.peers.set(peer.key, peer);
    emit({ type: 'connection_opened', connectionId: peer.id, remote: peer.key });
    resetIdle(peer);
    return peer;
  }

  // ---- receiving ------------------------------------------------------------------------

  function processMessage(peer, datagram) {
    const r = peer.run;
    const t = now();
    const overflow = datagram.length > lim.maxMessageBytes;

    // Only a message we can read proves the peer is talking to us; an oversized datagram is
    // discarded and does not extend the peer's lifetime.
    if (!overflow) {
      resetIdle(peer);
      const minInterval = r.definition.connection.minCommandIntervalMs;
      const tooSoon = minInterval > 0 && peer.lastMessageAt !== null && t - peer.lastMessageAt < minInterval;
      peer.lastMessageAt = t;
      if (tooSoon) {
        // The throttle time lives on the peer, so it disappears with it (no growing table).
        if (peer.intervalReportedAt === null || t - peer.intervalReportedAt >= lim.reportIntervalMs) {
          peer.intervalReportedAt = t;
          emit({ type: 'ignored', connectionId: peer.id, reason: 'interval' });
        }
        return;
      }
    }

    const bytes = overflow ? new Uint8Array(0) : toMessage(datagram, r.definition.framing.terminator);
    // An oversized datagram cannot be matched; invalid UTF-8 makes the engine answer with its
    // "unknown" handler, which is the specified behavior for it.
    const outcome = r.engine.handleMessage(overflow ? Uint8Array.of(0xff) : bytes);
    emit({
      type: 'rx',
      connectionId: peer.id,
      bytes,
      overflow,
      outcome: outcome.outcome,
      commandIndex: outcome.commandIndex,
    });
    if (outcome.changes.length > 0) {
      emit({ type: 'variables', values: r.engine.getState().values, changes: outcome.changes });
    }
    for (const effect of outcome.effects) deliver(r, peer, effect);
  }

  function onDatagram(r, message, rinfo) {
    if (run !== r || lifecycle !== 'running') return;
    const t = now();
    // First of all, before any state is created or anything is shown.
    if (!r.recvLimiter.take(t, message.length)) {
      report(r, 'rate_limit', { type: 'refused', reason: 'rate_limit' });
      return;
    }
    if (!rinfo || rinfo.family !== 'IPv4') return;
    if (t < r.quietUntil) {
      report(r, 'startup', { type: 'refused', reason: 'startup' });
      return;
    }
    if (message.length === 0) {
      report(r, 'empty', { type: 'ignored', reason: 'empty' });
      return;
    }
    const key = `${rinfo.address}:${rinfo.port}`;
    let peer = r.peers.get(key);
    if (!peer) {
      const { maxConnections, overLimit } = r.definition.connection;
      if (r.peers.size >= maxConnections) {
        // Datagrams of a peer beyond the limit are ignored whatever `overLimit` says.
        report(r, 'limit', { type: 'refused', reason: 'limit', behavior: overLimit });
        return;
      }
      peer = openPeer(r, rinfo);
    }
    processMessage(peer, Uint8Array.from(message));
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
    const lan = host === '0.0.0.0';
    const r = {
      generation,
      definition,
      engine,
      host,
      port,
      lan,
      peers: new Map(),
      quietUntil: 0,
      faults: { dropNextReplies: 0, extraDelayMs: 0, muted: false },
      recvLimiter: lan
        ? createWindowLimiter(lim.lanRecvPerSecond, lim.lanRecvBytesPerSecond)
        : createWindowLimiter(lim.recvPerSecond, lim.recvBytesPerSecond),
      replyBucket: createBucket(lan ? lim.lanReplyBytesPerSecond : lim.replyBytesPerSecond, now),
      peerReplyRate: lan ? lim.lanReplyBytesPerSecondPerPeer : lim.replyBytesPerSecondPerPeer,
      notice: createNoticeThrottle(now, lim.reportIntervalMs),
      socket: null,
      cancelRequested: false,
      cancelPromise: null,
      onStartFinished: null,
    };
    startingRun = r;
    r.socket = createSocket();

    return new Promise((resolve) => {
      const finish = (result) => {
        startingRun = null;
        resolve(result);
        if (r.onStartFinished) r.onStartFinished();
      };

      // First of all: an unhandled 'error' event on a socket would crash the main process.
      r.socket.on('error', (error) => {
        if (lifecycle === 'starting' && startingRun === r) {
          // A failed bind (port in use, no right): release the socket, and only then report it
          // (a stop() that is waiting for this start must not return before the close).
          releaseThen(r.socket, () => {
            lifecycle = 'idle';
            finish({ ok: false, code: 'listen_failed', errno: error && error.code });
          });
          return;
        }
        // Ignore errors of a socket that is no longer the current one (a late event of an old run).
        if (run !== r) return;
        emit({ type: 'server_error', errno: error && error.code });
        stop();
      });
      r.socket.once('listening', () => {
        if (r.cancelRequested) {
          // stop() was called while starting: release the port again and report the cancellation.
          releaseThen(r.socket, () => {
            lifecycle = 'idle';
            finish({ ok: false, code: 'cancelled' });
          });
          return;
        }
        r.socket.on('message', (message, rinfo) => onDatagram(r, message, rinfo));
        run = r;
        lifecycle = 'running';
        r.port = r.socket.address().port;
        r.quietUntil = now() + definition.connection.startupQuietMs;
        emit({ type: 'listening', host, port: r.port });
        finish({ ok: true, host, port: r.port, generation: r.generation });
      });
      try {
        r.socket.bind({ address: host, port });
      } catch (error) {
        // Not expected (bind reports problems as 'error' events), but the state must not stay "starting".
        releaseThen(r.socket, () => {
          lifecycle = 'idle';
          finish({ ok: false, code: 'listen_failed', errno: error && error.code });
        });
      }
    });
  }

  function stop() {
    if (lifecycle === 'idle') return Promise.resolve({ ok: true });
    if (lifecycle === 'stopping') return stopPromise;
    if (lifecycle === 'starting') {
      // Cancel the start that is still in progress and wait until the port is released again.
      // Every caller gets the same promise: a second stop() must not replace the first one's callback.
      const pending = startingRun;
      pending.cancelRequested = true;
      if (!pending.cancelPromise) {
        pending.cancelPromise = new Promise((resolve) => { pending.onStartFinished = () => resolve({ ok: true }); });
      }
      return pending.cancelPromise;
    }

    lifecycle = 'stopping';
    const r = run;
    for (const peer of [...r.peers.values()]) closePeer(peer, 'stop');
    stopPromise = new Promise((resolve) => {
      // The port is free only after the socket reports it is closed.
      releaseThen(r.socket, () => {
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

  // "Close all connections" means "forget all peers" here.
  function closeAllConnections() {
    if (lifecycle !== 'running') return { ok: false, code: 'not_running' };
    const all = [...run.peers.values()];
    for (const peer of all) closePeer(peer, 'fault');
    return { ok: true, closed: all.length };
  }

  function getState() {
    if (lifecycle !== 'running') return { running: false, lifecycle, transport: 'udp', connections: [] };
    const t = now();
    return {
      running: true,
      lifecycle,
      transport: 'udp',
      host: run.host,
      port: run.port,
      generation: run.generation,
      lan: run.lan,
      variables: run.engine.getState().values,
      faults: { ...run.faults },
      connections: [...run.peers.values()].map((p) => ({
        id: p.id,
        remote: p.key,
        connectedAt: p.connectedAt,
        lastMessageAt: p.lastMessageAt,
        idleInMs: p.idleAt === null ? null : Math.max(0, p.idleAt - t),
        silent: false,
      })),
    };
  }

  return { start, stop, setFault, closeAllConnections, getState };
}

module.exports = { createDeviceUdpServer, ALLOWED_HOSTS, DEFAULT_LIMITS, isValidPort };
