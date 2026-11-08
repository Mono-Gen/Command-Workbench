const RECORDING_LIMITS = Object.freeze({
  MAX_PAYLOAD_BYTES: 8 * 1024 * 1024,
  MAX_FILE_BYTES: 32 * 1024 * 1024,
  MAX_EVENTS: 200000,
  MAX_EVENT_BYTES: 65536,
  MAX_CONNECTIONS: 1000,
  MAX_DEPTH: 6,
  MAX_T: 2 ** 40,
});

const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const CLOSE_REASONS = new Set([
  'client_closed', 'upstream_closed', 'upstream_failed', 'error', 'stop', 'limit', 'idle',
]);
const TRUNCATED_REASONS = new Set(['payload_limit', 'event_limit', 'connection_limit']);
const DIRECTIONS = new Set(['up', 'down']);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function pointerToken(value) {
  return String(value).replaceAll('~', '~0').replaceAll('/', '~1');
}

function childPointer(pointer, key) {
  return `${pointer}/${pointerToken(key)}`;
}

function scanStructure(root, add) {
  const stack = [{ value: root, pointer: '', depth: 1 }];
  while (stack.length > 0) {
    const { value, pointer, depth } = stack.pop();
    if (value === null || typeof value !== 'object') {
      if (typeof value === 'number' && !Number.isFinite(value)) add(pointer, 'invalid_type');
      continue;
    }
    if (depth > RECORDING_LIMITS.MAX_DEPTH) {
      add('', 'too_deep');
      return false;
    }
    if (!Array.isArray(value) && !isPlainObject(value)) {
      add(pointer, pointer === '' ? 'not_an_object' : 'invalid_type');
      continue;
    }
    const keys = Object.keys(value);
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index];
      const next = childPointer(pointer, key);
      if (RESERVED_KEYS.has(key)) add(next, 'reserved_key');
      else stack.push({ value: value[key], pointer: next, depth: depth + 1 });
    }
  }
  return true;
}

function unknownFields(value, allowed, pointer, add) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key) && !RESERVED_KEYS.has(key)) add(pointer, 'unknown_field');
  }
}

function requireField(value, key, pointer, add) {
  if (Object.hasOwn(value, key)) return true;
  add(childPointer(pointer, key), 'missing_field');
  return false;
}

function integer(value, pointer, min, max, add, typeCode = 'invalid_type') {
  if (typeof value !== 'number') {
    add(pointer, typeCode);
    return false;
  }
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    add(pointer, 'invalid_value');
    return false;
  }
  return true;
}

function stringValue(value, pointer, min, max, add) {
  if (typeof value !== 'string') {
    add(pointer, 'invalid_type');
    return false;
  }
  if (value.length < min || value.length > max) {
    add(pointer, 'invalid_value');
    return false;
  }
  return true;
}

function decodeBase64(value, pointer, add, decode = true) {
  if (typeof value !== 'string') {
    add(pointer, 'invalid_type');
    return null;
  }
  const firstPadding = value.indexOf('=');
  if (value.length === 0 || value.length % 4 !== 0
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
    || (firstPadding !== -1 && firstPadding < value.length - 2)) {
    add(pointer, 'invalid_base64');
    return null;
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const decodedLength = (value.length / 4) * 3 - padding;
  if (decodedLength > RECORDING_LIMITS.MAX_EVENT_BYTES) {
    add(pointer, 'payload_too_large');
    return null;
  }
  if (!decode) return undefined;
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) {
    add(pointer, 'invalid_base64');
    return null;
  }
  return Uint8Array.from(bytes);
}

function validateRecording(value) {
  const errors = [];
  const add = (pointer, code) => {
    if (errors.length < 50) errors.push({ pointer, code });
  };
  if (!isPlainObject(value)) {
    return { ok: false, errors: [{ pointer: '', code: 'not_an_object' }] };
  }
  if (!scanStructure(value, add)) return { ok: false, errors };

  const rootFields = new Set([
    'schemaVersion', 'transport', 'name', 'startedAt', 'target', 'truncated', 'truncatedReason',
    'connections', 'events',
  ]);
  unknownFields(value, rootFields, '', add);

  if (!Object.hasOwn(value, 'schemaVersion') || !Number.isInteger(value.schemaVersion)) {
    add('/schemaVersion', 'invalid_schema_version');
  } else if (value.schemaVersion !== 1) {
    add('/schemaVersion', 'unsupported_schema_version');
  }
  let transport = 'tcp';
  if (Object.hasOwn(value, 'transport')) {
    if (typeof value.transport !== 'string') add('/transport', 'invalid_type');
    else if (!['tcp', 'udp'].includes(value.transport)) add('/transport', 'invalid_value');
    else transport = value.transport;
  }
  if (Object.hasOwn(value, 'name')) stringValue(value.name, '/name', 1, 100, add);
  if (Object.hasOwn(value, 'startedAt')) {
    integer(value.startedAt, '/startedAt', 0, Number.MAX_SAFE_INTEGER, add);
  }
  if (Object.hasOwn(value, 'target')) {
    if (!isPlainObject(value.target)) add('/target', 'invalid_type');
    else {
      unknownFields(value.target, new Set(['host', 'port']), '/target', add);
      if (requireField(value.target, 'host', '/target', add)) {
        stringValue(value.target.host, '/target/host', 1, 253, add);
      }
      if (requireField(value.target, 'port', '/target', add)) {
        integer(value.target.port, '/target/port', 1, 65535, add);
      }
    }
  }
  if (Object.hasOwn(value, 'truncated') && typeof value.truncated !== 'boolean') {
    add('/truncated', 'invalid_type');
  }
  if (Object.hasOwn(value, 'truncatedReason')) {
    if (typeof value.truncatedReason !== 'string') add('/truncatedReason', 'invalid_type');
    else if (!TRUNCATED_REASONS.has(value.truncatedReason)) add('/truncatedReason', 'invalid_value');
    if (value.truncated !== true) add('/truncatedReason', 'invalid_value');
  }

  const connections = [];
  const connectionMap = new Map();
  if (!requireField(value, 'connections', '', add)) {
    // Required-field error is sufficient.
  } else if (!Array.isArray(value.connections)) add('/connections', 'invalid_type');
  else {
    // Over the limit: report it and skip the elements, so a huge array cannot exhaust memory or time.
    const connectionCount = value.connections.length > RECORDING_LIMITS.MAX_CONNECTIONS ? 0 : value.connections.length;
    if (connectionCount === 0 && value.connections.length > 0) add('/connections', 'too_many_connections');
    for (let index = 0; index < connectionCount; index += 1) {
      const item = value.connections[index];
      const pointer = `/connections/${index}`;
      if (!isPlainObject(item)) {
        add(pointer, 'invalid_type');
        continue;
      }
      unknownFields(item, new Set(['id', 'openedAt', 'closedAt', 'closeReason']), pointer, add);
      const hasId = requireField(item, 'id', pointer, add);
      const hasOpened = requireField(item, 'openedAt', pointer, add);
      const hasClosed = requireField(item, 'closedAt', pointer, add);
      const hasReason = requireField(item, 'closeReason', pointer, add);
      const idOk = hasId && integer(item.id, `${pointer}/id`, 1, Number.MAX_SAFE_INTEGER, add);
      const openedOk = hasOpened
        && integer(item.openedAt, `${pointer}/openedAt`, 0, RECORDING_LIMITS.MAX_T, add);
      let closedOk = false;
      if (hasClosed) {
        if (item.closedAt === null) closedOk = true;
        else closedOk = integer(item.closedAt, `${pointer}/closedAt`, 0, RECORDING_LIMITS.MAX_T, add);
      }
      if (openedOk && closedOk && item.closedAt !== null && item.closedAt < item.openedAt) {
        add(`${pointer}/closedAt`, 'invalid_value');
      }
      if (hasReason) {
        if (item.closeReason !== null && typeof item.closeReason !== 'string') {
          add(`${pointer}/closeReason`, 'invalid_type');
        } else if (item.closeReason !== null && !CLOSE_REASONS.has(item.closeReason)) {
          add(`${pointer}/closeReason`, 'invalid_value');
        }
        if ((item.closedAt === null) !== (item.closeReason === null)) {
          add(`${pointer}/closeReason`, 'invalid_value');
        }
      }
      if (idOk) {
        if (connectionMap.has(item.id)) add(pointer, 'duplicate_connection');
        else connectionMap.set(item.id, item);
      }
      if (idOk && openedOk && closedOk && hasReason) {
        connections.push({
          id: item.id, openedAt: item.openedAt, closedAt: item.closedAt,
          closeReason: item.closeReason,
        });
      }
    }
  }

  const events = [];
  let payloadBytes = 0;
  let payloadExceeded = false;
  let previousSeq = -1;
  let previousT = -1;
  if (!requireField(value, 'events', '', add)) {
    // Required-field error is sufficient.
  } else if (!Array.isArray(value.events)) add('/events', 'invalid_type');
  else {
    const eventCount = value.events.length > RECORDING_LIMITS.MAX_EVENTS ? 0 : value.events.length;
    if (eventCount === 0 && value.events.length > 0) add('/events', 'too_many_events');
    for (let index = 0; index < eventCount; index += 1) {
      const item = value.events[index];
      const pointer = `/events/${index}`;
      if (!isPlainObject(item)) {
        add(pointer, 'invalid_type');
        continue;
      }
      unknownFields(item, new Set(['seq', 't', 'c', 'd', 'b64']), pointer, add);
      const present = Object.fromEntries(
        ['seq', 't', 'c', 'd', 'b64'].map((key) => [key, requireField(item, key, pointer, add)]),
      );
      const seqOk = present.seq
        && integer(item.seq, `${pointer}/seq`, 0, Number.MAX_SAFE_INTEGER, add);
      const tOk = present.t
        && integer(item.t, `${pointer}/t`, 0, RECORDING_LIMITS.MAX_T, add);
      const cOk = present.c
        && integer(item.c, `${pointer}/c`, 1, Number.MAX_SAFE_INTEGER, add);
      let dOk = false;
      if (present.d) {
        if (typeof item.d !== 'string') add(`${pointer}/d`, 'invalid_type');
        else if (!DIRECTIONS.has(item.d)) add(`${pointer}/d`, 'invalid_value');
        else dOk = true;
      }
      if (seqOk && item.seq <= previousSeq) add(`${pointer}/seq`, 'order_violation');
      if (tOk && item.t < previousT) add(`${pointer}/t`, 'order_violation');
      if (seqOk) previousSeq = item.seq;
      if (tOk) previousT = item.t;
      const connection = cOk ? connectionMap.get(item.c) : undefined;
      if (cOk && connection === undefined) add(`${pointer}/c`, 'unknown_connection');
      if (tOk && connection !== undefined
        && (item.t < connection.openedAt
          || (connection.closedAt !== null && item.t > connection.closedAt))) {
        add(`${pointer}/t`, 'order_violation');
      }
      let bytes = null;
      if (present.b64) {
        bytes = decodeBase64(item.b64, `${pointer}/b64`, add, !payloadExceeded);
        if (bytes === undefined) bytes = null;
        if (bytes !== null) {
          if (payloadBytes + bytes.length > RECORDING_LIMITS.MAX_PAYLOAD_BYTES) {
            add(`${pointer}/b64`, 'payload_too_large');
            payloadExceeded = true;
            bytes = null;
          } else payloadBytes += bytes.length;
        }
      }
      if (seqOk && tOk && cOk && dOk && bytes !== null) {
        events.push({ seq: item.seq, t: item.t, c: item.c, d: item.d, bytes });
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  const recording = { schemaVersion: 1, transport };
  if (Object.hasOwn(value, 'name')) recording.name = value.name;
  if (Object.hasOwn(value, 'startedAt')) recording.startedAt = value.startedAt;
  if (Object.hasOwn(value, 'target')) recording.target = { ...value.target };
  recording.truncated = value.truncated ?? false;
  if (Object.hasOwn(value, 'truncatedReason')) recording.truncatedReason = value.truncatedReason;
  recording.connections = connections;
  recording.events = events;
  return { ok: true, recording };
}

function parseRecordingText(text) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  if (Buffer.byteLength(text, 'utf8') > RECORDING_LIMITS.MAX_FILE_BYTES) {
    return { ok: false, errors: [{ pointer: '', code: 'too_large' }] };
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, errors: [{ pointer: '', code: 'invalid_json' }] };
  }
  return validateRecording(value);
}

function wireRecording(recording) {
  const value = { schemaVersion: 1 };
  if (recording.transport === 'udp') value.transport = 'udp';
  if (Object.hasOwn(recording, 'name')) value.name = recording.name;
  if (Object.hasOwn(recording, 'startedAt')) value.startedAt = recording.startedAt;
  if (Object.hasOwn(recording, 'target')) {
    value.target = { host: recording.target.host, port: recording.target.port };
  }
  value.truncated = recording.truncated;
  if (Object.hasOwn(recording, 'truncatedReason')) value.truncatedReason = recording.truncatedReason;
  value.connections = recording.connections.map((connection) => ({ ...connection }));
  value.events = recording.events.map((event) => ({
    seq: event.seq, t: event.t, c: event.c, d: event.d,
    b64: Buffer.from(event.bytes).toString('base64'),
  }));
  return value;
}

function serializeRecording(recording) {
  if (!isPlainObject(recording)) throw new TypeError('recording must be normalized');
  const wire = wireRecording(recording);
  const checked = validateRecording(wire);
  if (!checked.ok) throw new TypeError('recording must be normalized');
  return `${JSON.stringify(wire)}\n`;
}

function createRecorder({ now, limits = {}, transport = 'tcp' } = {}) {
  if (typeof now !== 'function' || !isPlainObject(limits) || !['tcp', 'udp'].includes(transport)) {
    throw new TypeError('Invalid recorder options');
  }
  unknownFields(limits, new Set([
    'MAX_PAYLOAD_BYTES', 'MAX_EVENTS', 'MAX_EVENT_BYTES', 'MAX_CONNECTIONS',
  ]), '', () => { throw new TypeError('Invalid recorder limits'); });
  const activeLimits = { ...RECORDING_LIMITS, ...limits };
  for (const key of ['MAX_PAYLOAD_BYTES', 'MAX_EVENTS', 'MAX_EVENT_BYTES', 'MAX_CONNECTIONS']) {
    if (!Number.isSafeInteger(activeLimits[key]) || activeLimits[key] < 0
      || activeLimits[key] > RECORDING_LIMITS[key]) {
      throw new TypeError('Invalid recorder limits');
    }
  }

  let start;
  let previousT;
  let nextConnectionId;
  let connections;
  let connectionMap;
  let events;
  let payloadBytes;
  let truncated;
  let truncatedReason;
  let frozen;
  // Counts clear() calls: a holder of an old connection id can tell that the id no longer
  // belongs to its connection.
  let epoch = 0;

  function readNow() {
    const value = now();
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('now must return a number');
    return value;
  }

  function resetState() {
    start = readNow();
    previousT = 0;
    nextConnectionId = 1;
    connections = [];
    connectionMap = new Map();
    events = [];
    payloadBytes = 0;
    truncated = false;
    truncatedReason = undefined;
    frozen = false;
  }

  function currentT() {
    const elapsed = Math.max(0, Math.floor(readNow() - start));
    previousT = Math.min(RECORDING_LIMITS.MAX_T, Math.max(previousT, elapsed));
    return previousT;
  }

  function truncate(reason, freezesChunks) {
    if (!truncated) {
      truncated = true;
      truncatedReason = reason;
    }
    if (freezesChunks) frozen = true;
  }

  function openConnection() {
    if (connections.length >= activeLimits.MAX_CONNECTIONS) {
      truncate('connection_limit', false);
      return null;
    }
    const connection = {
      id: nextConnectionId, openedAt: currentT(), closedAt: null, closeReason: null,
    };
    nextConnectionId += 1;
    connections.push(connection);
    connectionMap.set(connection.id, connection);
    return connection.id;
  }

  function closeConnection(id, reason) {
    if (!CLOSE_REASONS.has(reason)) throw new TypeError('Invalid close reason');
    const connection = connectionMap.get(id);
    if (connection === undefined || connection.closedAt !== null) return;
    connection.closedAt = currentT();
    connection.closeReason = reason;
  }

  function addChunk(id, dir, bytes) {
    if (!DIRECTIONS.has(dir)) throw new TypeError('Invalid direction');
    if (!(bytes instanceof Uint8Array)) throw new TypeError('bytes must be a Uint8Array');
    if (frozen) return false;
    const connection = connectionMap.get(id);
    if (bytes.length === 0 || connection === undefined || connection.closedAt !== null) return true;
    const eventCount = Math.ceil(bytes.length / activeLimits.MAX_EVENT_BYTES);
    if (bytes.length > 0 && activeLimits.MAX_EVENT_BYTES === 0) {
      truncate('event_limit', true);
      return false;
    }
    if (events.length + eventCount > activeLimits.MAX_EVENTS) {
      truncate('event_limit', true);
      return false;
    }
    if (payloadBytes + bytes.length > activeLimits.MAX_PAYLOAD_BYTES) {
      truncate('payload_limit', true);
      return false;
    }
    const t = currentT();
    for (let offset = 0; offset < bytes.length; offset += activeLimits.MAX_EVENT_BYTES) {
      events.push({
        seq: events.length,
        t,
        c: id,
        d: dir,
        bytes: Uint8Array.from(bytes.subarray(offset, offset + activeLimits.MAX_EVENT_BYTES)),
      });
    }
    payloadBytes += bytes.length;
    return true;
  }

  function snapshot(metadata = {}) {
    if (!isPlainObject(metadata)) throw new TypeError('Invalid snapshot metadata');
    const result = { schemaVersion: 1, transport };
    if (Object.hasOwn(metadata, 'name')) result.name = metadata.name;
    if (Object.hasOwn(metadata, 'startedAt')) result.startedAt = metadata.startedAt;
    if (Object.hasOwn(metadata, 'target')) result.target = { ...metadata.target };
    result.truncated = truncated;
    if (truncatedReason !== undefined) result.truncatedReason = truncatedReason;
    result.connections = connections.map((connection) => ({ ...connection }));
    result.events = events.map((event) => ({ ...event, bytes: Uint8Array.from(event.bytes) }));
    return result;
  }

  function clear() {
    epoch += 1;
    resetState();
  }

  // The kind of traffic is fixed once something is recorded: switching is only possible while the
  // recording is empty (otherwise one file would mix datagrams and a byte stream).
  function setTransport(next) {
    if (!['tcp', 'udp'].includes(next)) throw new TypeError('Invalid transport');
    if (next === transport) return true;
    if (events.length > 0 || connections.length > 0) return false;
    transport = next;
    return true;
  }

  function stats() {
    return {
      events: events.length,
      payloadBytes,
      connections: connections.length,
      truncated,
      truncatedReason,
    };
  }

  resetState();
  return {
    openConnection, closeConnection, addChunk, snapshot, clear, stats, epoch: () => epoch, setTransport, transport: () => transport,
  };
}

module.exports = {
  RECORDING_LIMITS,
  validateRecording,
  parseRecordingText,
  serializeRecording,
  createRecorder,
};
