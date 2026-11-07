// Turns the connection history into diagnostic hint ids. Pure: the caller passes `now`.
// Timing-only conclusions are returned as low confidence because a silent device or a slow
// reply looks the same as a broken connection. See core_spec.md section 3.

// Groups raw socket error codes into the few categories the hints care about.
function normalizeError(code) {
  if (code === 'ECONNREFUSED') {
    return 'refused';
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return 'not_found';
  }
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
    return 'unreachable';
  }
  if (code === 'ETIMEDOUT' || code === 'CONNECT_TIMEOUT') {
    return 'timeout';
  }
  if (code === 'ECONNRESET' || code === 'EPIPE') {
    return 'reset';
  }
  if (code === 'EADDRINUSE' || code === 'EACCES') {
    return 'local_address';
  }
  return 'other';
}

function diagnoseUdp(history, now, replyWaitMs) {
  const categories = new Set(
    history
      .filter((event) => event.type === 'connect_fail')
      .map((event) => normalizeError(event.code)),
  );
  const results = [];
  const add = (id, confidence) => results.push({ id, confidence });
  if (categories.has('not_found')) add('connect_not_found', 'high');
  if (['other', 'reset', 'refused', 'timeout', 'unreachable'].some((item) => categories.has(item))) {
    add('connect_other', 'high');
  }
  if (categories.has('local_address')) add('udp_local_port_busy', 'high');
  if (history.some((event) => event.type === 'send_error' && event.code === 'EMSGSIZE')) {
    add('udp_datagram_too_large', 'high');
  }
  if (history.some((event) => event.type === 'recv' && event.fromTarget === false)) {
    add('udp_other_source', 'high');
  }

  const lastSend = history.filter((event) => event.type === 'send').at(-1);
  const noReply = lastSend !== undefined
    && lastSend.expectsReply === true
    && !history.some((event) => event.type === 'recv' && event.t > lastSend.t)
    && now - lastSend.t >= replyWaitMs;
  if (noReply) add('udp_no_reply', 'low');
  if (noReply && lastSend.endsWithTerminator === false) add('check_terminator', 'low');
  return results;
}

function hasIdlePeerClose(history) {
  const terminations = history.filter((event) => event.type === 'terminated');
  return terminations.some((termination) => {
    if (
      termination.initiator !== 'peer'
      || termination.userRequested !== false
      || termination.hadError !== false
      || termination.finSeen !== true
    ) {
      return false;
    }

    const traffic = history.filter(
      (event) => (event.type === 'send' || event.type === 'recv') && event.t <= termination.t,
    );
    const origins = traffic.length > 0
      ? traffic
      : history.filter((event) => event.type === 'connect_ok' && event.t <= termination.t);
    if (origins.length === 0) {
      return false;
    }
    const lastActivityTime = Math.max(...origins.map((event) => event.t));
    return termination.t - lastActivityTime > 0;
  });
}

function hasPossibleConnectionLimit(history, quickCloseMs) {
  if (history.some((event) => event.type === 'recv')) {
    return false;
  }

  const connectEvents = history.filter((event) => event.type === 'connect_ok');
  return history.some((termination) => {
    if (
      termination.type !== 'terminated'
      || termination.initiator !== 'peer'
      || termination.userRequested !== false
    ) {
      return false;
    }
    return connectEvents.some(
      (connection) => connection.t <= termination.t
        && termination.t - connection.t <= quickCloseMs,
    );
  });
}

function diagnose(history, now, config = {}) {
  if (!Array.isArray(history)) {
    throw new TypeError('history must be an array');
  }

  const replyWaitMs = config.replyWaitMs ?? 3000;
  const quickCloseMs = config.quickCloseMs ?? 1000;
  if (history.some((event) => event.transport === 'udp')) {
    return diagnoseUdp(history, now, replyWaitMs);
  }
  const categories = new Set(
    history
      .filter((event) => event.type === 'connect_fail')
      .map((event) => normalizeError(event.code)),
  );
  const results = [];
  const add = (id, confidence) => results.push({ id, confidence });

  if (categories.has('refused')) {
    add('connect_refused', 'high');
  }
  if (categories.has('not_found')) {
    add('connect_not_found', 'high');
  }
  if (categories.has('unreachable')) {
    add('connect_unreachable', 'high');
  }
  if (categories.has('timeout')) {
    add('connect_timeout', 'high');
  }
  if (categories.has('reset') || categories.has('other') || categories.has('local_address')) {
    add('connect_other', 'high');
  }
  if (categories.has('refused') || categories.has('timeout')) {
    add('maybe_booting', 'low');
  }

  // A disconnect the user asked for says nothing about the device, so give no hints for it.
  const userRequested = history.some(
    (event) => event.type === 'terminated' && event.userRequested === true,
  );
  if (userRequested) {
    return results;
  }

  const terminations = history.filter((event) => event.type === 'terminated');
  const sends = history.filter((event) => event.type === 'send');
  const receives = history.filter((event) => event.type === 'recv');
  const lastSend = sends.at(-1);
  const noReply = lastSend !== undefined
    && lastSend.expectsReply === true
    && !receives.some((event) => event.t > lastSend.t)
    && terminations.length === 0
    && now - lastSend.t >= replyWaitMs;

  if (noReply) {
    add('no_reply', 'low');
  }
  if (noReply && lastSend.endsWithTerminator === false) {
    add('check_terminator', 'low');
  }

  const previousSend = sends.at(-2);
  const silentBreak = previousSend !== undefined
    && lastSend !== undefined
    && previousSend.expectsReply === true
    && lastSend.expectsReply === true
    && receives.some((event) => event.t < previousSend.t)
    && !receives.some((event) => event.t > previousSend.t && event.t < lastSend.t)
    && !receives.some((event) => event.t > lastSend.t && event.t <= now)
    && now - lastSend.t >= replyWaitMs
    && terminations.length === 0;
  if (silentBreak) {
    add('silent_break', 'low');
  }

  if (hasIdlePeerClose(history)) {
    add('peer_closed_idle', 'low');
  }
  if (hasPossibleConnectionLimit(history, quickCloseMs)) {
    add('connection_limit_maybe', 'low');
  }

  return results;
}

module.exports = { normalizeError, diagnose };
