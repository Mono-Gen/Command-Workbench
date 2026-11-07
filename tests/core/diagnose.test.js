const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeError, diagnose } = require('../../src/core/diagnose');

function ids(history, now = 5000, config) {
  return diagnose(history, now, config).map((item) => item.id);
}

test('normalizes every specified connection error code', () => {
  const cases = [
    ['ECONNREFUSED', 'refused'],
    ['ENOTFOUND', 'not_found'],
    ['EAI_AGAIN', 'not_found'],
    ['EHOSTUNREACH', 'unreachable'],
    ['ENETUNREACH', 'unreachable'],
    ['ETIMEDOUT', 'timeout'],
    ['CONNECT_TIMEOUT', 'timeout'],
    ['ECONNRESET', 'reset'],
    ['EPIPE', 'reset'],
    ['EADDRINUSE', 'local_address'],
    ['EACCES', 'local_address'],
    ['', 'other'],
  ];
  for (const [code, expected] of cases) {
    assert.equal(normalizeError(code), expected, `unexpected category for ${code}`);
  }
});

const udp = (events) => events.map((event) => ({ ...event, transport: 'udp' }));

test('UDP no-reply and terminator hints fire at the exact wait boundary', () => {
  const withTerminator = udp([
    { t: 0, type: 'connect_ok' },
    { t: 100, type: 'send', expectsReply: true, endsWithTerminator: true },
  ]);
  assert.deepEqual(diagnose(withTerminator, 3100), [{ id: 'udp_no_reply', confidence: 'low' }]);
  assert.deepEqual(diagnose(withTerminator, 3099), []);
  const withoutTerminator = udp([
    { t: 0, type: 'connect_ok' },
    { t: 100, type: 'send', expectsReply: true, endsWithTerminator: false },
  ]);
  assert.deepEqual(diagnose(withoutTerminator, 3100), [
    { id: 'udp_no_reply', confidence: 'low' },
    { id: 'check_terminator', confidence: 'low' },
  ]);
});

test('UDP receives suppress no-reply and flag only another source', () => {
  const base = [
    { t: 0, type: 'connect_ok' },
    { t: 100, type: 'send', expectsReply: true, endsWithTerminator: true },
  ];
  assert.deepEqual(diagnose(udp([...base, { t: 200, type: 'recv', fromTarget: true }]), 9999), []);
  assert.deepEqual(diagnose(udp([...base, { t: 200, type: 'recv', fromTarget: false }]), 9999), [
    { id: 'udp_other_source', confidence: 'high' },
  ]);
});

test('UDP connection and send errors use only the specified table ids', () => {
  const cases = [
    ['EADDRINUSE', [{ id: 'udp_local_port_busy', confidence: 'high' }]],
    ['EACCES', [{ id: 'udp_local_port_busy', confidence: 'high' }]],
    ['ENOTFOUND', [{ id: 'connect_not_found', confidence: 'high' }]],
    ['ECONNREFUSED', [{ id: 'connect_other', confidence: 'high' }]],
  ];
  for (const [code, expected] of cases) {
    assert.deepEqual(diagnose(udp([{ t: 0, type: 'connect_fail', code }]), 0), expected, code);
  }
  assert.deepEqual(diagnose(udp([
    { t: 0, type: 'connect_ok' }, { t: 1, type: 'send_error', code: 'EMSGSIZE' },
  ]), 1), [{ id: 'udp_datagram_too_large', confidence: 'high' }]);
  assert.deepEqual(diagnose(udp([
    { t: 0, type: 'connect_ok' }, { t: 1, type: 'send_error', code: 'ENETUNREACH' },
  ]), 1), []);
});

test('UDP ignores terminated events and keeps the specified result order', () => {
  const history = udp([
    { t: 0, type: 'connect_fail', code: 'ECONNREFUSED' },
    { t: 1, type: 'connect_fail', code: 'ENOTFOUND' },
    { t: 2, type: 'connect_fail', code: 'EACCES' },
    { t: 3, type: 'connect_ok' },
    { t: 4, type: 'send_error', code: 'EMSGSIZE' },
    { t: 5, type: 'recv', fromTarget: false },
    { t: 100, type: 'send', expectsReply: true, endsWithTerminator: false },
    { t: 101, type: 'terminated', userRequested: true, initiator: 'peer' },
  ]);
  assert.deepEqual(diagnose(history, 3100), [
    { id: 'connect_not_found', confidence: 'high' },
    { id: 'connect_other', confidence: 'high' },
    { id: 'udp_local_port_busy', confidence: 'high' },
    { id: 'udp_datagram_too_large', confidence: 'high' },
    { id: 'udp_other_source', confidence: 'high' },
    { id: 'udp_no_reply', confidence: 'low' },
    { id: 'check_terminator', confidence: 'low' },
  ]);
});

test('transport mode never leaks ids from the other diagnostic table', () => {
  assert.deepEqual(diagnose([{ t: 0, type: 'connect_fail', code: 'EADDRINUSE' }], 0), [
    { id: 'connect_other', confidence: 'high' },
  ]);
  const tcpIds = ids([
    { t: 0, type: 'connect_ok' },
    { t: 100, type: 'send', expectsReply: true, endsWithTerminator: false },
  ], 3100);
  assert.equal(tcpIds.some((id) => id.startsWith('udp_')), false);

  for (const code of ['ECONNREFUSED', 'EHOSTUNREACH', 'ETIMEDOUT', 'ECONNRESET', 'UNKNOWN']) {
    const udpIds = ids(udp([
      { t: 0, type: 'connect_fail', code },
      { t: 1, type: 'connect_ok' },
      { t: 100, type: 'send', expectsReply: true, endsWithTerminator: false },
      { t: 101, type: 'terminated', initiator: 'peer', userRequested: false, hadError: false, finSeen: true },
    ]), 3100);
    for (const absent of [
      'no_reply', 'silent_break', 'peer_closed_idle', 'connection_limit_maybe', 'maybe_booting',
      'connect_refused', 'connect_unreachable', 'connect_timeout',
    ]) assert.equal(udpIds.includes(absent), false, `${code}: ${absent}`);
  }
});

test('fires each connect-failure diagnosis and maybe-booting only where specified', () => {
  const cases = [
    ['ECONNREFUSED', ['connect_refused', 'maybe_booting']],
    ['ENOTFOUND', ['connect_not_found']],
    ['EHOSTUNREACH', ['connect_unreachable']],
    ['ETIMEDOUT', ['connect_timeout', 'maybe_booting']],
    ['ECONNRESET', ['connect_other']],
    ['EACCES', ['connect_other']],
  ];
  for (const [code, expected] of cases) {
    assert.deepEqual(ids([{ t: 0, type: 'connect_fail', code }]), expected, `unexpected hints for ${code}`);
  }
});

test('does not fire one connect category for another category', () => {
  const result = ids([{ t: 0, type: 'connect_fail', code: 'ENOTFOUND' }]);
  for (const absent of ['connect_refused', 'connect_unreachable', 'connect_timeout', 'connect_other', 'maybe_booting']) {
    assert.equal(result.includes(absent), false, `${absent} must not fire`);
  }
});

test('fires no-reply at the default wait boundary', () => {
  const history = [
    { t: 0, type: 'connect_ok' },
    { t: 2000, type: 'send', expectsReply: true, endsWithTerminator: false },
  ];
  assert.deepEqual(diagnose(history, 5000), [
    { id: 'no_reply', confidence: 'low' },
    { id: 'check_terminator', confidence: 'low' },
  ]);
});

test('does not fire no-reply before the wait, after receive, without expectation, or after termination', () => {
  const baseSend = { t: 2000, type: 'send', expectsReply: true, endsWithTerminator: false };
  const cases = [
    [[baseSend], 4999],
    [[baseSend, { t: 2001, type: 'recv' }], 6000],
    [[{ ...baseSend, expectsReply: false }], 6000],
    [[baseSend, {
      t: 2500, type: 'terminated', initiator: 'error', hadError: true,
      errorCode: 'ECONNRESET', finSeen: false, userRequested: false,
    }], 6000],
  ];
  for (const [history, now] of cases) {
    assert.equal(ids(history, now).includes('no_reply'), false);
  }
});

test('does not fire check-terminator when no-reply is absent or the last send has a terminator', () => {
  const withTerminator = [{ t: 0, type: 'send', expectsReply: true, endsWithTerminator: true }];
  assert.deepEqual(ids(withTerminator, 3000), ['no_reply']);
  assert.equal(ids(withTerminator, 2999).includes('check_terminator'), false);
});

test('fires silent-break after an earlier receive and two unanswered expected sends', () => {
  const history = [
    { t: 100, type: 'recv' },
    { t: 500, type: 'send', expectsReply: true, endsWithTerminator: true },
    { t: 1000, type: 'send', expectsReply: true, endsWithTerminator: true },
  ];
  assert.deepEqual(ids(history, 4000), ['no_reply', 'silent_break']);
});

test('does not fire silent-break when any required condition is absent', () => {
  const recv = { t: 100, type: 'recv' };
  const first = { t: 500, type: 'send', expectsReply: true, endsWithTerminator: true };
  const second = { t: 1000, type: 'send', expectsReply: true, endsWithTerminator: true };
  const termination = {
    t: 1500, type: 'terminated', initiator: 'peer', hadError: false,
    errorCode: null, finSeen: true, userRequested: false,
  };
  const cases = [
    [[first, second], 4000],
    [[recv, second], 4000],
    [[recv, { ...first, expectsReply: false }, second], 4000],
    [[recv, first, { t: 700, type: 'recv' }, second], 4000],
    [[recv, first, second, { t: 1100, type: 'recv' }], 4000],
    [[recv, first, second], 3999],
    [[recv, first, second, termination], 4000],
  ];
  for (const [history, now] of cases) {
    assert.equal(ids(history, now).includes('silent_break'), false);
  }
});

test('fires peer-closed-idle only for a later clean peer FIN', () => {
  const termination = {
    t: 100, type: 'terminated', initiator: 'peer', hadError: false,
    errorCode: null, finSeen: true, userRequested: false,
  };
  assert.deepEqual(ids([{ t: 50, type: 'connect_ok' }, termination], 100), [
    'peer_closed_idle',
    'connection_limit_maybe',
  ]);

  for (const changed of [
    { initiator: 'local' }, { userRequested: true }, { hadError: true }, { finSeen: false }, { t: 50 },
  ]) {
    const result = ids([{ t: 50, type: 'connect_ok' }, { ...termination, ...changed }], 100);
    assert.equal(result.includes('peer_closed_idle'), false);
  }
});

test('uses the last send or receive as the idle-gap origin', () => {
  const history = [
    { t: 0, type: 'connect_ok' },
    { t: 50, type: 'send', expectsReply: false, endsWithTerminator: true },
    { t: 75, type: 'recv' },
    {
      t: 75, type: 'terminated', initiator: 'peer', hadError: false,
      errorCode: null, finSeen: true, userRequested: false,
    },
  ];
  assert.equal(ids(history, 75).includes('peer_closed_idle'), false);
});

test('fires connection-limit-maybe at the quick-close boundary', () => {
  const history = [
    { t: 100, type: 'connect_ok' },
    {
      t: 1100, type: 'terminated', initiator: 'peer', hadError: true,
      errorCode: 'ECONNRESET', finSeen: false, userRequested: false,
    },
  ];
  assert.deepEqual(ids(history, 1100), ['connection_limit_maybe']);
});

test('does not fire connection-limit-maybe outside its conditions', () => {
  const termination = {
    t: 1100, type: 'terminated', initiator: 'peer', hadError: true,
    errorCode: 'ECONNRESET', finSeen: false, userRequested: false,
  };
  const cases = [
    [{ t: 100, type: 'connect_ok' }, { ...termination, t: 1101 }],
    [{ t: 100, type: 'connect_ok' }, { t: 500, type: 'recv' }, termination],
    [{ t: 100, type: 'connect_ok' }, { ...termination, initiator: 'local' }],
    [{ t: 100, type: 'connect_ok' }, { ...termination, userRequested: true }],
    [termination],
  ];
  for (const history of cases) {
    assert.equal(ids(history, 2000).includes('connection_limit_maybe'), false);
  }
});

test('honors custom timing thresholds', () => {
  const noReply = [{ t: 100, type: 'send', expectsReply: true, endsWithTerminator: true }];
  assert.deepEqual(ids(noReply, 600, { replyWaitMs: 500 }), ['no_reply']);

  const quickClose = [
    { t: 100, type: 'connect_ok' },
    {
      t: 300, type: 'terminated', initiator: 'peer', hadError: true,
      errorCode: 'EPIPE', finSeen: false, userRequested: false,
    },
  ];
  assert.deepEqual(ids(quickClose, 300, { quickCloseMs: 199 }), []);
});

test('suppresses termination and timing diagnoses after any user-requested termination', () => {
  const history = [
    { t: 0, type: 'connect_fail', code: 'ECONNREFUSED' },
    { t: 100, type: 'recv' },
    { t: 200, type: 'send', expectsReply: true, endsWithTerminator: false },
    { t: 300, type: 'send', expectsReply: true, endsWithTerminator: false },
    {
      t: 400, type: 'terminated', initiator: 'peer', hadError: false,
      errorCode: null, finSeen: true, userRequested: false,
    },
    {
      t: 500, type: 'terminated', initiator: 'local', hadError: false,
      errorCode: null, finSeen: false, userRequested: true,
    },
  ];
  assert.deepEqual(ids(history, 5000), ['connect_refused', 'maybe_booting']);
});

test('returns unique diagnoses in specified confidence and table order', () => {
  const history = [
    { t: 0, type: 'connect_fail', code: 'EACCES' },
    { t: 1, type: 'connect_fail', code: 'ETIMEDOUT' },
    { t: 2, type: 'connect_fail', code: 'EHOSTUNREACH' },
    { t: 3, type: 'connect_fail', code: 'ENOTFOUND' },
    { t: 4, type: 'connect_fail', code: 'ECONNREFUSED' },
    { t: 100, type: 'recv' },
    { t: 200, type: 'send', expectsReply: true, endsWithTerminator: true },
    { t: 300, type: 'send', expectsReply: true, endsWithTerminator: false },
    { t: 400, type: 'unknown' },
  ];
  assert.deepEqual(diagnose(history, 3400), [
    { id: 'connect_refused', confidence: 'high' },
    { id: 'connect_not_found', confidence: 'high' },
    { id: 'connect_unreachable', confidence: 'high' },
    { id: 'connect_timeout', confidence: 'high' },
    { id: 'connect_other', confidence: 'high' },
    { id: 'maybe_booting', confidence: 'low' },
    { id: 'no_reply', confidence: 'low' },
    { id: 'check_terminator', confidence: 'low' },
    { id: 'silent_break', confidence: 'low' },
  ]);
});

test('handles empty history, ignores unknown events, and rejects non-arrays', () => {
  assert.deepEqual(diagnose([], 0), []);
  assert.deepEqual(diagnose([{ t: 0, type: 'unknown' }], 5000), []);
  for (const history of [null, undefined, {}, 'events']) {
    assert.throws(() => diagnose(history, 0), TypeError);
  }
});
