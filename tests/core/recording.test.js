const test = require('node:test');
const assert = require('node:assert/strict');

const {
  RECORDING_LIMITS,
  validateRecording,
  parseRecordingText,
  serializeRecording,
  createRecorder,
} = require('../../src/core/recording');

function source(overrides = {}) {
  return {
    schemaVersion: 1,
    connections: [{
      id: 1, openedAt: 0, closedAt: 20, closeReason: 'client_closed',
    }],
    events: [{ seq: 0, t: 10, c: 1, d: 'up', b64: 'QQ==' }],
    ...overrides,
  };
}

function errorsOf(value) {
  const result = validateRecording(value);
  assert.equal(result.ok, false);
  return result.errors;
}

function hasError(errors, pointer, code) {
  assert.equal(errors.some((error) => error.pointer === pointer && error.code === code), true,
    `${pointer} ${code}: ${JSON.stringify(errors)}`);
}

test('exports the exact recording limits', () => {
  assert.deepEqual(RECORDING_LIMITS, {
    MAX_PAYLOAD_BYTES: 8 * 1024 * 1024,
    MAX_FILE_BYTES: 32 * 1024 * 1024,
    MAX_EVENTS: 200000,
    MAX_EVENT_BYTES: 65536,
    MAX_CONNECTIONS: 1000,
    MAX_DEPTH: 6,
    MAX_T: 2 ** 40,
  });
});

test('validates and normalizes every v1 field without aliasing', () => {
  const input = source({
    name: 'capture', startedAt: 1700000000000,
    target: { host: '127.0.0.1', port: 23 },
    truncated: true, truncatedReason: 'event_limit',
  });
  const result = validateRecording(input);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.recording, {
    schemaVersion: 1,
    transport: 'tcp',
    name: 'capture', startedAt: 1700000000000,
    target: { host: '127.0.0.1', port: 23 },
    truncated: true, truncatedReason: 'event_limit',
    connections: [{ id: 1, openedAt: 0, closedAt: 20, closeReason: 'client_closed' }],
    events: [{ seq: 0, t: 10, c: 1, d: 'up', bytes: Uint8Array.of(65) }],
  });
  input.target.host = 'changed';
  input.connections[0].openedAt = 9;
  assert.equal(result.recording.target.host, '127.0.0.1');
  assert.equal(result.recording.connections[0].openedAt, 0);
});

test('reports structural, required, type, range, enum, and unknown-field errors', () => {
  hasError(errorsOf(null), '', 'not_an_object');
  const errors = errorsOf({
    schemaVersion: 1.5,
    name: '',
    startedAt: 'now',
    target: { host: '', port: 70000, extra: true },
    truncated: 'yes',
    connections: 'bad',
    extra: true,
  });
  hasError(errors, '/schemaVersion', 'invalid_schema_version');
  hasError(errors, '/name', 'invalid_value');
  hasError(errors, '/startedAt', 'invalid_type');
  hasError(errors, '/target/host', 'invalid_value');
  hasError(errors, '/target/port', 'invalid_value');
  hasError(errors, '/target', 'unknown_field');
  hasError(errors, '/truncated', 'invalid_type');
  hasError(errors, '/connections', 'invalid_type');
  hasError(errors, '/events', 'missing_field');
  hasError(errors, '', 'unknown_field');
  hasError(errorsOf(source({ schemaVersion: 2 })), '/schemaVersion', 'unsupported_schema_version');
});

test('validates recording transport and idle close reasons', () => {
  assert.equal(validateRecording(source()).recording.transport, 'tcp');
  assert.equal(validateRecording(source({ transport: 'tcp' })).recording.transport, 'tcp');
  assert.equal(validateRecording(source({ transport: 'udp' })).recording.transport, 'udp');
  for (const transport of [null, 1, {}, []]) {
    assert.deepEqual(errorsOf(source({ transport })), [{ pointer: '/transport', code: 'invalid_type' }]);
  }
  assert.deepEqual(errorsOf(source({ transport: 'sctp' })), [
    { pointer: '/transport', code: 'invalid_value' },
  ]);
  assert.equal(validateRecording(source({
    connections: [{ id: 1, openedAt: 0, closedAt: 20, closeReason: 'idle' }],
  })).ok, true);
  hasError(errorsOf(source({
    connections: [{ id: 1, openedAt: 0, closedAt: null, closeReason: 'idle' }],
  })), '/connections/0/closeReason', 'invalid_value');
});

test('rejects reserved keys, excessive depth, exotic objects, and caps errors at 50', () => {
  const reserved = JSON.parse('{"schemaVersion":1,"connections":[],"events":[],"target":{"__proto__":1}}');
  hasError(errorsOf(reserved), '/target/__proto__', 'reserved_key');
  const deep = {
    schemaVersion: 1, connections: [], events: [], a: { b: { c: { d: { e: { f: {} } } } } },
  };
  hasError(errorsOf(deep), '', 'too_deep');
  hasError(errorsOf(new Date(0)), '', 'not_an_object');
  const many = { schemaVersion: 1, connections: [], events: [] };
  for (let index = 0; index < 80; index += 1) many[`x${index}`] = true;
  assert.equal(errorsOf(many).length, 50);
});

test('enforces connection invariants and event ordering', () => {
  const errors = errorsOf({
    schemaVersion: 1,
    connections: [
      { id: 1, openedAt: 5, closedAt: 4, closeReason: null },
      { id: 1, openedAt: 0, closedAt: null, closeReason: 'stop' },
    ],
    events: [
      { seq: 2, t: 5, c: 1, d: 'side', b64: 'QQ==' },
      { seq: 2, t: 4, c: 99, d: 'down', b64: 'Qg==' },
    ],
  });
  hasError(errors, '/connections/0/closedAt', 'invalid_value');
  hasError(errors, '/connections/0/closeReason', 'invalid_value');
  hasError(errors, '/connections/1', 'duplicate_connection');
  hasError(errors, '/connections/1/closeReason', 'invalid_value');
  hasError(errors, '/events/0/d', 'invalid_value');
  hasError(errors, '/events/1/seq', 'order_violation');
  hasError(errors, '/events/1/t', 'order_violation');
  hasError(errors, '/events/1/c', 'unknown_connection');
  hasError(errorsOf(source({
    connections: [{ id: 1, openedAt: 10, closedAt: 20, closeReason: 'stop' }],
    events: [{ seq: 0, t: 9, c: 1, d: 'up', b64: 'QQ==' }],
  })), '/events/0/t', 'order_violation');
});

test('rejects noncanonical base64 before decoding and enforces payload limits', () => {
  assert.equal(validateRecording(source({
    events: [{ seq: 0, t: 1, c: 1, d: 'up', b64: 'QUJD' }],
  })).ok, true);
  for (const b64 of ['', 'A===', 'A', 'A A=', 'AB==', 'AAAA=']) {
    hasError(errorsOf(source({ events: [{ seq: 0, t: 1, c: 1, d: 'up', b64 }] })),
      '/events/0/b64', 'invalid_base64');
  }
  const tooLarge = Buffer.alloc(RECORDING_LIMITS.MAX_EVENT_BYTES + 1).toString('base64');
  hasError(errorsOf(source({ events: [{ seq: 0, t: 1, c: 1, d: 'up', b64: tooLarge }] })),
    '/events/0/b64', 'payload_too_large');
  const chunk = Buffer.alloc(RECORDING_LIMITS.MAX_EVENT_BYTES).toString('base64');
  const events = Array.from({ length: 129 }, (_, seq) => ({ seq, t: seq, c: 1, d: 'up', b64: chunk }));
  events.push({ seq: 129, t: 129, c: 1, d: 'up', b64: 123 });
  const payloadErrors = errorsOf(source({
    connections: [{ id: 1, openedAt: 0, closedAt: null, closeReason: null }], events,
  }));
  hasError(payloadErrors, '/events/128/b64', 'payload_too_large');
  hasError(payloadErrors, '/events/129/b64', 'invalid_type');
});

test('enforces collection limits and truncation consistency', () => {
  const connections = Array.from({ length: 1001 }, (_, index) => ({
    id: index + 1, openedAt: 0, closedAt: null, closeReason: null,
  }));
  hasError(errorsOf({ schemaVersion: 1, connections, events: [] }), '/connections', 'too_many_connections');
  const events = Array.from({ length: 200001 }, (_, seq) => ({ seq, t: 0, c: 1, d: 'up', b64: 'QQ==' }));
  hasError(errorsOf(source({
    connections: [{ id: 1, openedAt: 0, closedAt: null, closeReason: null }], events,
  })), '/events', 'too_many_events');
  hasError(errorsOf(source({ truncatedReason: 'payload_limit' })), '/truncatedReason', 'invalid_value');
});

test('parses text errors and serializes in deterministic v1 key order', () => {
  assert.deepEqual(parseRecordingText('{'), {
    ok: false, errors: [{ pointer: '', code: 'invalid_json' }],
  });
  assert.throws(() => parseRecordingText(null), TypeError);
  const oversized = 'é'.repeat((RECORDING_LIMITS.MAX_FILE_BYTES / 2) + 1);
  assert.deepEqual(parseRecordingText(oversized), {
    ok: false, errors: [{ pointer: '', code: 'too_large' }],
  });
  const normalized = validateRecording(source({ name: 'n', truncated: false })).recording;
  const text = serializeRecording(normalized);
  assert.equal(text, '{"schemaVersion":1,"name":"n","truncated":false,"connections":[{"id":1,"openedAt":0,"closedAt":20,"closeReason":"client_closed"}],"events":[{"seq":0,"t":10,"c":1,"d":"up","b64":"QQ=="}]}\n');
  assert.deepEqual(parseRecordingText(text).recording, normalized);
  const udp = validateRecording(source({ transport: 'udp', name: 'n' })).recording;
  const udpText = serializeRecording(udp);
  assert.match(udpText, /^\{"schemaVersion":1,"transport":"udp","name":"n"/);
  assert.deepEqual(parseRecordingText(udpText).recording, udp);
  const reversedTarget = validateRecording(source({
    target: { port: 23, host: 'h' },
  })).recording;
  assert.match(serializeRecording(reversedTarget), /"target":\{"host":"h","port":23\}/);
});

test('recorder preserves UDP transport across clear and serialization', () => {
  let now = 1000;
  const recorder = createRecorder({ now: () => now++, transport: 'udp' });
  const id = recorder.openConnection();
  recorder.addChunk(id, 'up', Uint8Array.of(1, 2, 3));
  recorder.closeConnection(id, 'idle');
  const first = recorder.snapshot();
  assert.equal(first.transport, 'udp');
  assert.equal(first.connections[0].closeReason, 'idle');
  assert.deepEqual(parseRecordingText(serializeRecording(first)).recording, first);
  recorder.clear();
  assert.equal(recorder.snapshot().transport, 'udp');

  const tcp = createRecorder({ now: () => 0 });
  assert.equal(tcp.snapshot().transport, 'tcp');
  assert.equal(Object.hasOwn(JSON.parse(serializeRecording(tcp.snapshot())), 'transport'), false);
  for (const transport of [null, '', 'sctp', 1]) {
    assert.throws(() => createRecorder({ now: () => 0, transport }), TypeError);
  }
});

test('round-trips seeded valid recordings through serialization', () => {
  let state = 0x1a2b3c4d;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  for (let run = 0; run < 300; run += 1) {
    const count = 1 + (next() % 5);
    const events = [];
    let t = 0;
    for (let seq = 0; seq < count; seq += 1) {
      t += next() % 4;
      const bytes = Uint8Array.from([next() & 0xff, next() & 0xff]);
      events.push({ seq, t, c: 1, d: next() & 1 ? 'up' : 'down', b64: Buffer.from(bytes).toString('base64') });
    }
    const validated = validateRecording({
      schemaVersion: 1,
      connections: [{ id: 1, openedAt: 0, closedAt: null, closeReason: null }],
      events,
    });
    assert.equal(validated.ok, true);
    assert.deepEqual(parseRecordingText(serializeRecording(validated.recording)).recording,
      validated.recording);
  }
});

test('records monotonic split events, snapshots copies, closes idempotently, and clears', () => {
  const times = [1000, 1010, 1005, 1020, 2000, 2001];
  const recorder = createRecorder({
    now: () => times.shift(),
    limits: { MAX_EVENT_BYTES: 2 },
  });
  const id = recorder.openConnection();
  assert.equal(id, 1);
  assert.equal(recorder.addChunk(id, 'up', Uint8Array.of(1, 2, 3)), true);
  assert.equal(recorder.addChunk(99, 'up', Uint8Array.of(9)), true);
  recorder.closeConnection(id, 'stop');
  recorder.closeConnection(id, 'error');
  assert.equal(recorder.addChunk(id, 'down', Uint8Array.of(4)), true);
  const first = recorder.snapshot({ name: 'n', startedAt: 7, target: { host: 'h', port: 1 } });
  assert.deepEqual(first.events.map((event) => [event.seq, event.t, Array.from(event.bytes)]), [
    [0, 10, [1, 2]], [1, 10, [3]],
  ]);
  assert.equal(first.connections[0].closedAt, 20);
  first.events[0].bytes[0] = 99;
  assert.equal(recorder.snapshot().events[0].bytes[0], 1);
  assert.deepEqual(recorder.stats(), {
    events: 2, payloadBytes: 3, connections: 1, truncated: false, truncatedReason: undefined,
  });
  recorder.clear();
  assert.deepEqual(recorder.stats(), {
    events: 0, payloadBytes: 0, connections: 0, truncated: false, truncatedReason: undefined,
  });
  assert.equal(recorder.openConnection(), 1);
});

test('freezes chunks atomically at event/payload limits while connections remain mutable', () => {
  let now = 0;
  const byEvents = createRecorder({ now: () => now++, limits: { MAX_EVENTS: 1, MAX_EVENT_BYTES: 2 } });
  const id = byEvents.openConnection();
  assert.equal(byEvents.addChunk(id, 'up', Uint8Array.of(1, 2, 3)), false);
  assert.equal(byEvents.stats().events, 0);
  assert.equal(byEvents.stats().truncatedReason, 'event_limit');
  assert.equal(byEvents.addChunk(id, 'up', Uint8Array.of(1)), false);
  assert.equal(byEvents.openConnection(), 2);
  byEvents.closeConnection(id, 'stop');

  const byPayload = createRecorder({ now: () => now++, limits: { MAX_PAYLOAD_BYTES: 2 } });
  const payloadId = byPayload.openConnection();
  assert.equal(byPayload.addChunk(payloadId, 'down', Uint8Array.of(1, 2, 3)), false);
  assert.equal(byPayload.stats().truncatedReason, 'payload_limit');

  const byConnections = createRecorder({ now: () => now++, limits: { MAX_CONNECTIONS: 1 } });
  assert.equal(byConnections.openConnection(), 1);
  assert.equal(byConnections.openConnection(), null);
  assert.equal(byConnections.stats().truncatedReason, 'connection_limit');
});

test('rejects invalid recorder arguments', () => {
  assert.throws(() => createRecorder(), TypeError);
  assert.throws(() => createRecorder({ now: 1 }), TypeError);
  const recorder = createRecorder({ now: () => 0 });
  const id = recorder.openConnection();
  assert.throws(() => recorder.addChunk(id, 'side', Uint8Array.of(1)), TypeError);
  assert.throws(() => recorder.addChunk(id, 'up', [1]), TypeError);
  assert.throws(() => recorder.closeConnection(id, 'bad'), TypeError);
});

test('the largest recording the recorder can produce is saved within the file limit and loads again', () => {
  let t = 0;
  const recorder = createRecorder({ now: () => t });
  const ids = [];
  for (let i = 0; i < 1000; i += 1) ids.push(recorder.openConnection());
  // Many tiny events maximize the per-event JSON overhead; 41 bytes each stays under the payload cap.
  const chunk = new Uint8Array(41).fill(0x7f);
  for (let i = 0; i < RECORDING_LIMITS.MAX_EVENTS; i += 1) {
    t += 1;
    assert.equal(recorder.addChunk(ids[i % ids.length], i % 2 === 0 ? 'up' : 'down', chunk), true, `event ${i}`);
  }
  assert.equal(recorder.addChunk(ids[0], 'up', chunk), false, 'the event cap is the limit reached here');
  const text = serializeRecording(recorder.snapshot());
  assert.ok(Buffer.byteLength(text, 'utf8') <= RECORDING_LIMITS.MAX_FILE_BYTES, `size ${Buffer.byteLength(text, 'utf8')}`);
  const parsed = parseRecordingText(text);
  assert.equal(parsed.ok, true, JSON.stringify(parsed.errors));
  assert.equal(parsed.recording.events.length, RECORDING_LIMITS.MAX_EVENTS);
});
