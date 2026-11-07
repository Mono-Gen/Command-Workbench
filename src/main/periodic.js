// Sends a harmless query command at a fixed interval (an application-level "keep-alive").
// It is NOT the same as TCP keepalive, and a device may not count it as activity either.
// Safety: only commands classified as queries are accepted, so the timer can never repeat a
// command that changes the device state. The command is copied (and frozen) at start, so
// changing the caller's object later cannot turn it into a different command. The timer is
// always stopped when sending fails, hangs or the connection ends, so it cannot keep running
// in the background.
const { canBePeriodic } = require('../core/safety');

const MIN_INTERVAL_MS = 1000;
const MAX_INTERVAL_MS = 3600000;
const DEFAULT_SEND_TIMEOUT_MS = 10000;

function createPeriodic({
  send,
  scheduler = { setInterval, clearInterval, setTimeout, clearTimeout },
  onStopped = () => {},
  sendTimeoutMs = DEFAULT_SEND_TIMEOUT_MS,
}) {
  // State of the current run, or null. Each start() makes a new object, so a send left over from
  // an earlier run can neither block nor stop a later run.
  let active = null;

  function stop(reason = 'user', detail = null) {
    if (active === null) return;
    scheduler.clearInterval(active.timerId);
    active = null;
    onStopped({ reason, detail });
  }

  async function tick(runState) {
    // Skip instead of queueing: a slow device must not build up a backlog of repeated queries.
    if (runState.inFlight) return;
    runState.inFlight = true;
    let failure = null;
    let timeoutId = null;
    try {
      const timeout = new Promise((resolve) => {
        timeoutId = scheduler.setTimeout(() => resolve({ ok: false, code: 'timeout' }), sendTimeoutMs);
      });
      // Calling send inside .then also turns a synchronous throw into a rejection.
      const result = await Promise.race([Promise.resolve().then(() => send(runState.command)), timeout]);
      if (!result || result.ok !== true) {
        failure = (result && result.code) || 'unknown';
      }
    } catch {
      failure = 'exception';
    } finally {
      scheduler.clearTimeout(timeoutId);
      runState.inFlight = false;
    }
    if (failure !== null && active === runState) {
      stop('send_failed', failure);
    }
  }

  function start(command, intervalMs) {
    if (command === null || typeof command !== 'object') {
      throw new TypeError('command must be an object');
    }
    const snapshot = Object.freeze({ ...command });
    const allowed = canBePeriodic(snapshot);
    if (!allowed.allowed) {
      return { ok: false, code: allowed.reason };
    }
    if (!Number.isInteger(intervalMs) || intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_INTERVAL_MS) {
      return { ok: false, code: 'invalid_interval' };
    }
    if (active !== null) {
      return { ok: false, code: 'already_running' };
    }
    const runState = { command: snapshot, inFlight: false, timerId: null };
    runState.timerId = scheduler.setInterval(() => { tick(runState); }, intervalMs);
    active = runState;
    return { ok: true };
  }

  return { start, stop, isRunning: () => active !== null };
}

module.exports = { createPeriodic, MIN_INTERVAL_MS, MAX_INTERVAL_MS, DEFAULT_SEND_TIMEOUT_MS };
