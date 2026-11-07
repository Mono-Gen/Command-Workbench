const test = require('node:test');
const assert = require('node:assert/strict');

const { validateDefinition } = require('../../src/core/device-definition');
const { createDeviceEngine } = require('../../src/core/device-engine');
const { validateRecording } = require('../../src/core/recording');
const {
  canDraft,
  draftDefinition,
  evaluateHoldout,
  replayCheck,
  DRAFT_LIMITS,
  HOMEWORK_CODES,
} = require('../../src/core/definition-draft');

const encoder = new TextEncoder();

function recording(connectionIds, eventValues, extras = {}) {
  const connections = connectionIds.map((id) => ({
    id, openedAt: 0, closedAt: null, closeReason: null,
  }));
  const events = eventValues.map(([seq, t, c, d, value]) => ({
    seq, t, c, d,
    b64: Buffer.from(value instanceof Uint8Array ? value : encoder.encode(value)).toString('base64'),
  }));
  const checked = validateRecording({ schemaVersion: 1, connections, events, ...extras });
  assert.equal(checked.ok, true, JSON.stringify(checked.errors));
  return checked.recording;
}

function one(eventValues, extras) {
  return recording([1], eventValues.map(([seq, t, d, value]) => [seq, t, 1, d, value]), extras);
}

function codes(result) {
  return result.homework.map((entry) => entry.code);
}

function homework(result, code) {
  return result.homework.find((entry) => entry.code === code);
}

test('exports the specified limits and homework order', () => {
  assert.equal(DRAFT_LIMITS.QUIET_MS, 250);
  assert.equal(DRAFT_LIMITS.MAX_COMMANDS, 500);
  assert.deepEqual(HOMEWORK_CODES, [
    'truncated_recording', 'no_terminator_found', 'terminator_ambiguous',
    'oversize_messages', 'incomplete_tail', 'binary_messages', 'unrepresentable',
    'causality_ambiguous', 'state_dependent', 'observed_once', 'multi_message_reply',
    'greeting_varies', 'too_many_commands', 'no_variables',
  ]);
});

test('refuses UDP recordings before every drafting operation', () => {
  const tcp = one([[0, 0, 'up', 'PING\r']]);
  const udp = one([[0, 0, 'up', 'PING\r']], { transport: 'udp' });
  assert.deepEqual(canDraft(tcp), { ok: true });
  assert.deepEqual(canDraft(udp), { ok: false, code: 'udp_draft_unsupported' });
  assert.throws(() => draftDefinition(udp), /^TypeError: udp_draft_unsupported$/);
  assert.throws(() => evaluateHoldout(udp), /^TypeError: udp_draft_unsupported$/);
  const draft = draftDefinition(tcp);
  assert.throws(() => replayCheck(draft, udp), /^TypeError: udp_draft_unsupported$/);
});

test('V1 drafts a greeting, excludes state dependence, and keeps silence', () => {
  const input = one([
    [0, 0, 'down', 'HELLO\r'],
    [1, 1000, 'up', 'PWR ?\r'],
    [2, 1010, 'down', 'PWR 0\r'],
    [3, 3000, 'up', 'PWR 1\r'],
    [4, 5000, 'up', 'PWR ?\r'],
    [5, 5010, 'down', 'PWR 1\r'],
  ]);
  const result = draftDefinition(input);
  assert.equal(result.stats.upTerminator, 'cr');
  assert.equal(Object.hasOwn(result.stats, 'downTerminator'), false);
  assert.equal(result.json.greeting, 'HELLO[CR]');
  assert.deepEqual(result.json.commands, [{ pattern: 'PWR 1', reply: null }]);
  assert.deepEqual(codes(result), ['state_dependent', 'observed_once', 'no_variables']);
  assert.equal(homework(result, 'state_dependent').count, 1);
  assert.match(homework(result, 'state_dependent').examples[0], /PWR \?/);
  assert.equal(homework(result, 'observed_once').count, 1);
  assert.equal(homework(result, 'observed_once').examples[0], 'PWR 1');
  assert.equal(result.stats.cleanExchanges, 3);
  assert.equal(result.stats.silentExchanges, 1);
  assert.equal(result.stats.ambiguousRequests, 0);
  assert.equal(validateDefinition(result.json).ok, true);
});

test('V2 rejects pipelined requests and their replies', () => {
  const result = draftDefinition(one([
    [0, 0, 'up', 'A\r'], [1, 5, 'up', 'B\r'],
    [2, 10, 'down', '1\r'], [3, 11, 'down', '2\r'],
  ]));
  assert.deepEqual(result.json.commands, []);
  assert.equal(homework(result, 'causality_ambiguous').count, 2);
  assert.equal(result.stats.ambiguousRequests, 2);
  assert.equal(result.stats.ambiguousReplies, 2);
  assert.equal(result.stats.cleanExchanges, 0);
});

test('V3 preserves explicit mixed terminators and replays exactly', () => {
  const input = one([
    [0, 0, 'up', 'GET\r'], [1, 20, 'down', 'VAL 5\r\n'],
  ]);
  const result = draftDefinition(input);
  assert.equal(result.stats.upTerminator, 'cr');
  assert.equal(Object.hasOwn(result.stats, 'downTerminator'), false);
  assert.deepEqual(result.json.commands, [{ pattern: 'GET', reply: 'VAL 5[CR][LF]' }]);
  assert.deepEqual(codes(result), ['observed_once', 'no_variables']);
  assert.deepEqual(replayCheck(result, input), { checked: 1, failures: [] });
  const changed = one([
    [0, 0, 'up', 'GET\r'], [1, 20, 'down', 'OTHER\r\n'],
  ]);
  assert.equal(replayCheck(result, changed).failures.length, 1);
});

test('V4 infers terminators by longest match and reports first-place ties', () => {
  const cases = [
    ['A\rB\n', 'cr', true],
    ['A\r\nB\r\n', 'crlf', false],
    ['A\r\nB\r', 'crlf', true],
  ];
  for (const [text, expected, ambiguous] of cases) {
    const result = draftDefinition(one([[0, 0, 'up', text]]));
    assert.equal(result.stats.upTerminator, expected);
    assert.equal(codes(result).includes('terminator_ambiguous'), ambiguous);
  }
});

test('V5 keeps stable observations and scores connection holdout', () => {
  const input = recording([1, 2], [
    [0, 0, 1, 'up', 'STATUS\r'], [1, 10, 1, 'down', 'OK\r'],
    [2, 100, 2, 'up', 'STATUS\r'], [3, 110, 2, 'down', 'OK\r'],
  ]);
  const result = draftDefinition(input);
  assert.deepEqual(result.json.commands, [{ pattern: 'STATUS', reply: 'OK[CR]' }]);
  assert.equal(codes(result).includes('observed_once'), false);
  assert.deepEqual(evaluateHoldout(input), {
    evaluable: true, exchanges: 2, reproduced: 2, mismatched: 0,
    unseen: 0, unsupported: 0, rate: 1,
  });
  assert.deepEqual(evaluateHoldout(one([
    [0, 0, 'up', 'STATUS\r'], [1, 10, 'down', 'OK\r'],
  ])), { evaluable: false, reason: 'need_two_connections' });
});

test('holdout marks requests excluded as ambiguous in training as unsupported', () => {
  const input = recording([1, 2], [
    [0, 0, 1, 'up', 'X\r'], [1, 1, 1, 'down', 'A\r'],
    [2, 100, 2, 'up', 'X\r'], [3, 101, 2, 'up', 'Z\r'],
    [4, 500, 2, 'up', 'Y\r'],
  ]);
  assert.deepEqual(evaluateHoldout(input), {
    evaluable: true, exchanges: 2, reproduced: 0, mismatched: 0,
    unseen: 1, unsupported: 1, rate: 0,
  });
});

test('V6 escapes special request and reply characters', () => {
  const input = one([
    [0, 0, 'up', 'SET {a}*\r'], [1, 10, 'down', '[x]\r'],
  ]);
  const result = draftDefinition(input);
  assert.deepEqual(result.json.commands, [{ pattern: 'SET {{a}}**', reply: '\\[x\\][CR]' }]);
  assert.deepEqual(replayCheck(result, input).failures, []);
});

test('V7 splits mixed downstream line endings per run', () => {
  const events = [
    [0, 0, 'down', 'READY\r'],
    [1, 100, 'up', 'ID?\r'],
    [2, 101, 'down', 'ID A1\r'],
    [3, 300, 'up', 'VER?\r'],
    [4, 301, 'down', 'VER 2.0\r\n'],
    [5, 500, 'up', 'ID?\r'],
    [6, 501, 'down', 'ID A1\r'],
  ];
  const expected = [
    { pattern: 'ID?', reply: 'ID A1[CR]' },
    { pattern: 'VER?', reply: 'VER 2.0[CR][LF]' },
  ];
  const result = draftDefinition(one(events));
  assert.equal(result.json.greeting, 'READY[CR]');
  assert.deepEqual(result.json.commands, expected);
  assert.deepEqual(codes(result), ['observed_once', 'no_variables']);
  assert.equal(homework(result, 'observed_once').count, 1);
  assert.equal(homework(result, 'observed_once').examples[0], 'VER?');
  assert.equal(codes(result).includes('state_dependent'), false);

  const split = draftDefinition(one([
    ...events.slice(0, 4),
    [4, 301, 'down', 'VER 2.0\r'],
    [5, 302, 'down', '\n'],
    [6, 500, 'up', 'ID?\r'],
    [7, 501, 'down', 'ID A1\r'],
  ]));
  assert.equal(split.json.greeting, 'READY[CR]');
  assert.deepEqual(split.json.commands, expected);
});

test('V8 taints incomplete reply and greeting runs instead of inferring silence', () => {
  const replyTail = draftDefinition(one([
    [0, 0, 'up', 'X\r'], [1, 10, 'down', 'OK'],
  ]));
  assert.deepEqual(replyTail.json.commands, []);
  assert.equal(homework(replyTail, 'incomplete_tail').count, 1);
  assert.equal(homework(replyTail, 'incomplete_tail').examples[0], 'X');
  assert.equal(replyTail.stats.incompleteTails, 1);
  assert.equal(replyTail.stats.silentExchanges, 0);

  const greetingTail = draftDefinition(one([
    [0, 0, 'down', 'HI'],
    [1, 50, 'up', 'Y\r'],
    [2, 60, 'down', 'Z\r'],
  ]));
  assert.equal(Object.hasOwn(greetingTail.json, 'greeting'), false);
  assert.deepEqual(greetingTail.json.commands, [{ pattern: 'Y', reply: 'Z[CR]' }]);
  assert.equal(homework(greetingTail, 'incomplete_tail').count, 1);
  assert.equal(greetingTail.stats.incompleteTails, 1);

  const isolatedRuns = draftDefinition(one([
    [0, 0, 'up', 'A\r'],
    [1, 10, 'down', 'PART'],
    [2, 300, 'up', 'B\r'],
    [3, 310, 'down', 'OK\r'],
  ]));
  assert.deepEqual(isolatedRuns.json.commands, [{ pattern: 'B', reply: 'OK[CR]' }]);
  assert.equal(homework(isolatedRuns, 'incomplete_tail').count, 1);
  assert.equal(homework(isolatedRuns, 'incomplete_tail').examples[0], 'A');
  assert.equal(isolatedRuns.stats.incompleteTails, 1);
  assert.equal(isolatedRuns.stats.silentExchanges, 0);
});

test('an empty upstream message ends the exchange and leaves the next run unowned', () => {
  const result = draftDefinition(one([
    [0, 0, 'up', 'A\r'],
    [1, 10, 'down', 'GOOD\r'],
    [2, 300, 'up', '\r'],
    [3, 310, 'down', 'TAIL'],
  ]));
  assert.deepEqual(result.json.commands, [{ pattern: 'A', reply: 'GOOD[CR]' }]);
  assert.equal(homework(result, 'incomplete_tail').count, 1);
  assert.deepEqual(homework(result, 'incomplete_tail').examples, ['(no request)']);
  assert.equal(result.stats.emptyMessages, 1);
  assert.equal(result.stats.incompleteTails, 1);
  assert.equal(result.stats.silentExchanges, 0);

  const completeOrphan = draftDefinition(one([
    [0, 0, 'up', 'A\r'],
    [1, 10, 'down', 'GOOD\r'],
    [2, 300, 'up', '\r'],
    [3, 310, 'down', 'ORPHAN\r'],
    [4, 600, 'up', 'B\r'],
    [5, 610, 'down', 'OK\r'],
  ]));
  assert.deepEqual(completeOrphan.json.commands, [
    { pattern: 'A', reply: 'GOOD[CR]' },
    { pattern: 'B', reply: 'OK[CR]' },
  ]);
  assert.equal(completeOrphan.stats.ambiguousReplies, 1);
  assert.equal(completeOrphan.stats.cleanExchanges, 2);
});

test('honors quietMs strict boundaries including zero', () => {
  const input249 = one([
    [0, 0, 'up', 'A\r'], [1, 249, 'up', 'B\r'], [2, 300, 'down', 'X\r'],
  ]);
  assert.equal(draftDefinition(input249).stats.ambiguousRequests, 2);

  const input250 = one([
    [0, 0, 'up', 'A\r'], [1, 250, 'up', 'B\r'], [2, 300, 'down', 'X\r'],
  ]);
  assert.equal(draftDefinition(input250).stats.ambiguousRequests, 0);
  assert.equal(draftDefinition(input249, { quietMs: 0 }).stats.ambiguousRequests, 0);
});

test('supports terminator overrides and no-terminator fallback', () => {
  const none = draftDefinition(one([[0, 0, 'up', 'TAIL']]));
  assert.equal(none.stats.upTerminator, 'cr');
  assert.equal(homework(none, 'no_terminator_found').count, 1);
  const overridden = draftDefinition(one([
    [0, 0, 'up', 'A\n'], [1, 1, 'down', 'B\r'],
  ]), { terminator: 'lf' });
  assert.equal(overridden.stats.upTerminator, 'lf');
  assert.equal(codes(overridden).includes('terminator_ambiguous'), false);
  assert.equal(codes(overridden).includes('no_terminator_found'), false);

  const downTie = draftDefinition(one([
    [0, 0, 'up', 'A\r'], [1, 1, 'down', 'X\rY\n'],
  ]));
  assert.deepEqual(downTie.json.commands, [{ pattern: 'A', reply: 'X[CR]Y[LF]' }]);
  assert.equal(codes(downTie).includes('terminator_ambiguous'), false);
});

test('counts empty, incomplete, oversized, and multi-message traffic', () => {
  const overflow = draftDefinition(one([
    [0, 0, 'up', `${'x'.repeat(4097)}\rA\r`],
    [1, 10, 'down', 'ONE\rTWO\rTAIL'],
  ]), { quietMs: 0 });
  assert.equal(overflow.stats.oversizeMessages, 1);
  assert.equal(overflow.stats.incompleteTails, 1);
  assert.equal(codes(overflow).includes('oversize_messages'), true);
  assert.equal(codes(overflow).includes('incomplete_tail'), true);

  const multi = draftDefinition(one([
    [0, 0, 'up', '\rQ\r'], [1, 10, 'down', '\rA\rB\r'],
  ]), { quietMs: 0 });
  assert.equal(multi.stats.emptyMessages, 2);
  assert.equal(homework(multi, 'multi_message_reply').count, 1);
  assert.deepEqual(multi.json.commands, [{ pattern: 'Q', reply: 'A[CR]B[CR]' }]);
});

test('excludes binary, BOM-leading, and unrepresentable exchanges', () => {
  const bytes = Uint8Array.of(0xff, 0x0d);
  const result = draftDefinition(one([
    [0, 0, 'up', bytes],
    [1, 10, 'up', '\ufeffBOM\r'],
    [2, 20, 'up', `${'r'.repeat(257)}\r`],
    [3, 30, 'up', 'BINARY_REPLY\r'],
    [4, 40, 'down', Uint8Array.of(0xff, 0x0d)],
    [5, 50, 'up', 'LONG_REPLY\r'],
    [6, 60, 'down', `${'z'.repeat(4096)}\r`],
  ]), { quietMs: 0 });
  assert.equal(homework(result, 'binary_messages').count, 3);
  assert.equal(homework(result, 'unrepresentable').count, 2);
  assert.deepEqual(result.json.commands, []);
});

test('handles greeting agreement, variation, absence, and binary greeting', () => {
  const agree = draftDefinition(recording([1, 2], [
    [0, 0, 1, 'down', 'HI\r'], [1, 1, 1, 'up', 'A\r'],
    [2, 2, 2, 'down', 'HI\r'], [3, 3, 2, 'up', 'B\r'],
  ]));
  assert.equal(agree.json.greeting, 'HI[CR]');
  assert.equal(codes(agree).includes('greeting_varies'), false);

  const vary = draftDefinition(recording([1, 2], [
    [0, 0, 1, 'down', 'HI\r'], [1, 1, 1, 'up', 'A\r'], [2, 2, 2, 'up', 'B\r'],
  ]));
  assert.equal(Object.hasOwn(vary.json, 'greeting'), false);
  assert.equal(homework(vary, 'greeting_varies').count, 1);

  const absent = draftDefinition(one([[0, 0, 'up', 'A\r']]));
  assert.equal(Object.hasOwn(absent.json, 'greeting'), false);
  assert.equal(codes(absent).includes('greeting_varies'), false);

  const binary = draftDefinition(one([
    [0, 0, 'down', Uint8Array.of(0xff, 0x0d)], [1, 1, 'up', 'A\r'],
  ]));
  assert.equal(codes(binary).includes('binary_messages'), true);

  const binaryVaries = draftDefinition(recording([1, 2], [
    [0, 0, 1, 'down', Uint8Array.of(0xff, 0x0d)], [1, 1, 1, 'up', 'A\r'],
    [2, 2, 2, 'down', 'HI\r'], [3, 3, 2, 'up', 'B\r'],
  ]));
  assert.equal(codes(binaryVaries).includes('binary_messages'), true);
  assert.equal(codes(binaryVaries).includes('greeting_varies'), true);
});

test('sorts commands, caps at maxCommands, and reports recording truncation', () => {
  const events = [];
  for (let index = 0; index < 501; index += 1) {
    events.push([index * 2, index * 10, 'up', `Q${index}\r`]);
    events.push([index * 2 + 1, index * 10 + 1, 'down', `R${index}\r`]);
  }
  const result = draftDefinition(one(events, {
    truncated: true, truncatedReason: 'event_limit',
  }), { quietMs: 0 });
  assert.equal(result.json.commands.length, 500);
  assert.equal(result.json.commands[0].pattern, 'Q0');
  assert.equal(homework(result, 'too_many_commands').count, 1);
  assert.equal(homework(result, 'truncated_recording').count, 1);
  assert.equal(codes(result).at(-1), 'no_variables');
});

test('validates options and normalized recordings', () => {
  const input = one([]);
  for (const options of [
    null, { quietMs: -1 }, { quietMs: 60001 }, { quietMs: 1.5 },
    { terminator: 'none' }, { downTerminator: 'cr' }, { downTerminator: 'CR' },
    { maxCommands: 0 }, { maxCommands: 501 }, { maxCommands: 1.5 }, { extra: true },
  ]) assert.throws(() => draftDefinition(input, options), TypeError);
  assert.throws(() => draftDefinition({ schemaVersion: 1, connections: [], events: [] }), TypeError);
  assert.throws(() => draftDefinition({
    schemaVersion: 1,
    truncated: false,
    connections: [
      { id: 1, openedAt: 0, closedAt: null, closeReason: null },
      { id: 1, openedAt: 0, closedAt: null, closeReason: null },
    ],
    events: [],
  }), TypeError);
  assert.throws(() => evaluateHoldout(null), TypeError);
  assert.throws(() => replayCheck({}, input), TypeError);
});

test('homework is ordered and examples are bounded', () => {
  const result = draftDefinition(one([
    [0, 0, 'up', 'A\r'], [1, 1, 'up', 'B\r'], [2, 2, 'down', 'X\r'],
  ], { truncated: true, truncatedReason: 'payload_limit' }));
  const indexes = result.homework.map((entry) => HOMEWORK_CODES.indexOf(entry.code));
  assert.deepEqual(indexes, [...indexes].sort((a, b) => a - b));
  for (const entry of result.homework) {
    assert.equal(entry.count > 0, true);
    assert.equal(entry.examples.length <= 5, true);
    assert.equal(entry.examples.every((example) => example.length <= 80), true);
  }
});

function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state;
  };
}

function snapshotInput(value) {
  return {
    ...value,
    target: value.target === undefined ? undefined : { ...value.target },
    connections: value.connections.map((item) => ({ ...item })),
    events: value.events.map((item) => ({ ...item, bytes: Array.from(item.bytes) })),
  };
}

test('500 seeded normalized recordings are deterministic, valid, replayable, and immutable', () => {
  const next = seeded(0xdecafbad);
  const fragments = ['A', 'B', 'Q1', 'OK', 'ERR', 'X{y}*', '[v]', 'é', ''];
  const endings = ['\r', '\n', '\r\n', ''];
  for (let run = 0; run < 500; run += 1) {
    const connectionCount = 1 + (next() % 3);
    const ids = Array.from({ length: connectionCount }, (_, index) => index + 1);
    const events = [];
    let t = 0;
    const eventCount = next() % 12;
    for (let seq = 0; seq < eventCount; seq += 1) {
      t += next() % 300;
      const c = ids[next() % ids.length];
      const d = next() & 1 ? 'up' : 'down';
      let value;
      if (next() % 17 === 0) value = Uint8Array.of(0xff, 0x0d);
      else value = `${fragments[next() % fragments.length]}${endings[next() % endings.length]}`;
      if (typeof value === 'string' && value.length === 0) value = 'A';
      events.push([seq, t, c, d, value]);
    }
    const input = recording(ids, events);
    const before = snapshotInput(input);
    const options = { quietMs: next() % 301, maxCommands: 1 + (next() % 10) };
    const first = draftDefinition(input, options);
    const second = draftDefinition(input, options);
    assert.deepEqual(first, second, `determinism run ${run}`);
    assert.equal(validateDefinition(first.json).ok, true, `validation run ${run}`);
    assert.deepEqual(replayCheck(first, input).failures, [], `replay run ${run}`);
    assert.doesNotThrow(() => evaluateHoldout(input, options), `holdout run ${run}`);
    assert.deepEqual(snapshotInput(input), before, `mutation run ${run}`);
  }
});

test('seeded stop-and-wait replies preserve independently recorded mixed line endings', () => {
  const next = seeded(0x7f4a7c15);
  const endings = ['\r', '\n', '\r\n'];
  for (let run = 0; run < 500; run += 1) {
    const events = [];
    const expected = new Map();
    let seq = 0;
    let t = 0;
    const exchanges = 1 + (next() % 8);
    for (let index = 0; index < exchanges; index += 1) {
      const request = `Q${run}_${index}`;
      events.push([seq, t, 'up', `${request}\r`]);
      seq += 1;
      t += 1;

      let reply = '';
      const lines = 1 + (next() % 3);
      for (let line = 0; line < lines; line += 1) {
        reply += `R${run}_${index}_${line}${endings[next() % endings.length]}`;
      }
      expected.set(request, encoder.encode(reply));

      let offset = 0;
      while (offset < reply.length) {
        const remaining = reply.length - offset;
        const size = 1 + (next() % Math.min(remaining, 5));
        events.push([seq, t, 'down', reply.slice(offset, offset + size)]);
        offset += size;
        seq += 1;
        t += 1;
      }
      t += 300;
    }

    const result = draftDefinition(one(events));
    assert.equal(result.json.commands.length, expected.size, `command count run ${run}`);
    const engine = createDeviceEngine(result.definition);
    for (const [request, bytes] of expected) {
      const outcome = engine.handleMessage(encoder.encode(request));
      const actual = Buffer.concat(outcome.effects
        .filter((effect) => effect.kind === 'reply')
        .map((effect) => Buffer.from(effect.bytes)));
      assert.deepEqual(actual, Buffer.from(bytes), `${request} in run ${run}`);
    }
  }
});
