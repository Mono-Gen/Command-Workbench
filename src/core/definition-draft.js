const { createFramer } = require('./framing');
const { validateDefinition, isValidatedDefinition } = require('./device-definition');
const { createDeviceEngine } = require('./device-engine');
const { toNotationParts, toPattern } = require('./notation-escape');
const { validateRecording } = require('./recording');

const DRAFT_LIMITS = Object.freeze({
  QUIET_MS: 250,
  MAX_QUIET_MS: 60000,
  MAX_COMMANDS: 500,
  MAX_MESSAGE_BYTES: 4096,
  MAX_EXAMPLES: 5,
  MAX_EXAMPLE_UNITS: 80,
});

const HOMEWORK_CODES = Object.freeze([
  'truncated_recording',
  'no_terminator_found',
  'terminator_ambiguous',
  'oversize_messages',
  'incomplete_tail',
  'binary_messages',
  'unrepresentable',
  'causality_ambiguous',
  'state_dependent',
  'observed_once',
  'multi_message_reply',
  'greeting_varies',
  'too_many_commands',
  'no_variables',
]);

const TERMINATORS = new Set(['cr', 'lf', 'crlf']);
const fatalDecoder = new TextDecoder('utf-8', { fatal: true });
const resultMetadata = new WeakMap();

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNormalizedRecording(recording) {
  if (!isPlainObject(recording) || recording.schemaVersion !== 1
    || typeof recording.truncated !== 'boolean'
    || !Array.isArray(recording.connections) || !Array.isArray(recording.events)) return false;
  const ids = new Set();
  for (const connection of recording.connections) {
    if (!isPlainObject(connection) || !Number.isSafeInteger(connection.id)
      || !Number.isSafeInteger(connection.openedAt)
      || !(connection.closedAt === null || Number.isSafeInteger(connection.closedAt))
      || !(connection.closeReason === null || typeof connection.closeReason === 'string')) return false;
    ids.add(connection.id);
  }
  let previousSeq = -1;
  let previousT = -1;
  for (const event of recording.events) {
    if (!isPlainObject(event) || !Number.isSafeInteger(event.seq) || event.seq <= previousSeq
      || !Number.isSafeInteger(event.t) || event.t < previousT || !ids.has(event.c)
      || (event.d !== 'up' && event.d !== 'down') || !(event.bytes instanceof Uint8Array)) return false;
    previousSeq = event.seq;
    previousT = event.t;
  }
  const wire = {
    ...recording,
    connections: recording.connections.map((connection) => ({ ...connection })),
    events: recording.events.map((event) => {
      const { bytes, ...fields } = event;
      return { ...fields, b64: Buffer.from(bytes).toString('base64') };
    }),
  };
  return validateRecording(wire).ok;
}

function canDraft(recording) {
  if (recording?.transport === 'udp') return { ok: false, code: 'udp_draft_unsupported' };
  return { ok: true };
}

function refuseUdp(recording) {
  if (!canDraft(recording).ok) throw new TypeError('udp_draft_unsupported');
}

function normalizeOptions(options = {}) {
  if (!isPlainObject(options)) throw new TypeError('options must be an object');
  const allowed = new Set(['quietMs', 'terminator', 'maxCommands']);
  if (Object.keys(options).some((key) => !allowed.has(key))) throw new TypeError('Unknown option');
  const quietMs = options.quietMs ?? DRAFT_LIMITS.QUIET_MS;
  const maxCommands = options.maxCommands ?? DRAFT_LIMITS.MAX_COMMANDS;
  if (!Number.isSafeInteger(quietMs) || quietMs < 0 || quietMs > DRAFT_LIMITS.MAX_QUIET_MS) {
    throw new TypeError('Invalid quietMs');
  }
  if (!Number.isSafeInteger(maxCommands) || maxCommands < 1
    || maxCommands > DRAFT_LIMITS.MAX_COMMANDS) throw new TypeError('Invalid maxCommands');
  if (options.terminator !== undefined && !TERMINATORS.has(options.terminator)) {
    throw new TypeError('Invalid terminator');
  }
  return {
    quietMs,
    maxCommands,
    terminator: options.terminator,
  };
}

function concatBytes(chunks) {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function byteKey(bytes) {
  return Buffer.from(bytes).toString('base64');
}

function sameBytes(left, right) {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function terminatorBytes(terminator) {
  if (terminator === 'cr') return Uint8Array.of(0x0d);
  if (terminator === 'lf') return Uint8Array.of(0x0a);
  return Uint8Array.of(0x0d, 0x0a);
}

function inferTerminator(recording, direction) {
  const counts = { crlf: 0, cr: 0, lf: 0 };
  for (const connection of recording.connections) {
    const stream = concatBytes(recording.events
      .filter((event) => event.c === connection.id && event.d === direction)
      .map((event) => event.bytes));
    for (let index = 0; index < stream.length; index += 1) {
      if (stream[index] === 0x0d && stream[index + 1] === 0x0a) {
        counts.crlf += 1;
        index += 1;
      } else if (stream[index] === 0x0d) counts.cr += 1;
      else if (stream[index] === 0x0a) counts.lf += 1;
    }
  }
  const highest = Math.max(counts.crlf, counts.cr, counts.lf);
  if (highest === 0) return { terminator: null, ambiguous: false };
  const tied = ['crlf', 'cr', 'lf'].filter((name) => counts[name] === highest);
  return { terminator: tied[0], ambiguous: tied.length > 1 };
}

function hasIncompleteTail(chunks, terminator) {
  const stream = concatBytes(chunks);
  if (stream.length === 0) return false;
  const end = terminatorBytes(terminator);
  let lastEnd = 0;
  for (let index = 0; index <= stream.length - end.length; index += 1) {
    let matches = true;
    for (let offset = 0; offset < end.length; offset += 1) {
      if (stream[index + offset] !== end[offset]) matches = false;
    }
    if (matches) {
      lastEnd = index + end.length;
      index += end.length - 1;
    }
  }
  return lastEnd !== stream.length;
}

function createHomework() {
  const entries = new Map(HOMEWORK_CODES.map((code) => [code, {
    count: 0, examples: [], exampleSet: new Set(), keySet: new Set(),
  }]));

  function add(code, count = 1, example, key) {
    const entry = entries.get(code);
    if (key !== undefined) {
      if (entry.keySet.has(key)) return;
      entry.keySet.add(key);
    }
    entry.count += count;
    if (example !== undefined && entry.examples.length < DRAFT_LIMITS.MAX_EXAMPLES
      && !entry.exampleSet.has(example)) {
      const bounded = example.slice(0, DRAFT_LIMITS.MAX_EXAMPLE_UNITS);
      entry.examples.push(bounded);
      entry.exampleSet.add(example);
    }
  }

  function output() {
    return HOMEWORK_CODES.flatMap((code) => {
      const entry = entries.get(code);
      return entry.count > 0 ? [{ code, count: entry.count, examples: entry.examples }] : [];
    });
  }
  return { add, output };
}

function displayText(text) {
  const parts = toNotationParts(text);
  if (parts === null) return text.slice(0, DRAFT_LIMITS.MAX_EXAMPLE_UNITS);
  return parts.join('').slice(0, DRAFT_LIMITS.MAX_EXAMPLE_UNITS);
}

function decodeRequest(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return null;
  }
  try {
    return fatalDecoder.decode(bytes);
  } catch {
    return null;
  }
}

function decodeBytes(bytes) {
  try {
    return fatalDecoder.decode(bytes);
  } catch {
    return null;
  }
}

function metadataForByte(events, index, cursor) {
  while (index >= cursor.end) {
    cursor.eventIndex += 1;
    cursor.end += events[cursor.eventIndex].bytes.length;
  }
  return events[cursor.eventIndex];
}

function splitDownRun(events, precedingUp, unowned, runIndex, connectionId, homework, stats) {
  if (events.length === 0) return { messages: [], greetingTainted: false };
  const stream = concatBytes(events.map((event) => event.bytes));
  const messages = [];
  const cursor = { eventIndex: 0, end: events[0].bytes.length };
  let start = 0;
  let withinEventOrder = 0;
  for (let index = 0; index < stream.length;) {
    let endingLength = 0;
    if (stream[index] === 0x0d) endingLength = stream[index + 1] === 0x0a ? 2 : 1;
    else if (stream[index] === 0x0a) endingLength = 1;
    if (endingLength === 0) {
      index += 1;
      continue;
    }

    const payloadLength = index - start;
    const lastByte = index + endingLength - 1;
    const event = metadataForByte(events, lastByte, cursor);
    if (payloadLength > DRAFT_LIMITS.MAX_MESSAGE_BYTES) {
      stats.oversizeMessages += 1;
      homework.add('oversize_messages');
      messages.push({ type: 'overflow', seq: event.seq, t: event.t, withinEventOrder });
    } else if (payloadLength === 0) {
      stats.emptyMessages += 1;
    } else {
      messages.push({
        type: 'message',
        direction: 'down',
        bytes: stream.slice(start, index),
        raw: stream.slice(start, lastByte + 1),
        seq: event.seq,
        t: event.t,
        withinEventOrder,
      });
      stats.messagesDown += 1;
    }
    withinEventOrder += 1;
    start = lastByte + 1;
    index = start;
  }

  let greetingTainted = false;
  if (start < stream.length) {
    stats.incompleteTails += 1;
    if (unowned) {
      homework.add('incomplete_tail', 1, '(no request)', `${connectionId}:${runIndex}`);
      return { messages, greetingTainted };
    }
    if (precedingUp === null) greetingTainted = true;
    else precedingUp.tainted = true;
    const exampleBytes = precedingUp === null ? stream.slice(start) : precedingUp.bytes;
    const exampleText = decodeRequest(exampleBytes);
    homework.add(
      'incomplete_tail', 1,
      exampleText === null ? undefined : displayText(exampleText),
      `${connectionId}:${runIndex}`,
    );
  }
  return { messages, greetingTainted };
}

function extractConnection(recording, connection, upTerminator, homework, stats) {
  const framer = createFramer({
    terminator: upTerminator,
    maxMessageBytes: DRAFT_LIMITS.MAX_MESSAGE_BYTES,
  });
  const events = recording.events.filter((event) => event.c === connection.id);
  const upChunks = [];
  const messages = [];
  let downRun = [];
  let runIndex = 0;
  let precedingUp = null;
  let runUnowned = false;
  let greetingTainted = false;

  function finishRun() {
    const split = splitDownRun(
      downRun, precedingUp, runUnowned, runIndex, connection.id, homework, stats,
    );
    if (runUnowned) {
      stats.ambiguousReplies += split.messages
        .filter((message) => message.type === 'message').length;
    } else {
      messages.push(...split.messages);
    }
    greetingTainted ||= split.greetingTainted;
    downRun = [];
    runIndex += 1;
  }

  for (const event of events) {
    if (event.d === 'down') {
      downRun.push(event);
      continue;
    }
    upChunks.push(event.bytes);
    const framed = framer.push(event.bytes);
    const completesMessage = framed.some((item) => item.type === 'message');
    if (completesMessage) finishRun();
    let lastMessage = null;
    let lastCompletedWasEmpty = false;
    let withinEventOrder = 0;
    for (const item of framed) {
      if (item.type === 'overflow') {
        stats.oversizeMessages += 1;
        homework.add('oversize_messages');
        messages.push({
          type: 'overflow', seq: event.seq, t: event.t, withinEventOrder,
        });
        withinEventOrder += 1;
        continue;
      }
      if (item.bytes.length === 0) {
        stats.emptyMessages += 1;
        lastMessage = null;
        lastCompletedWasEmpty = true;
        withinEventOrder += 1;
        continue;
      }
      const message = {
        type: 'message',
        direction: 'up',
        bytes: item.bytes,
        raw: null,
        seq: event.seq,
        t: event.t,
        withinEventOrder,
        followsOverflow: false,
        tainted: false,
      };
      messages.push(message);
      lastMessage = message;
      lastCompletedWasEmpty = false;
      withinEventOrder += 1;
      stats.messagesUp += 1;
    }
    if (completesMessage) {
      precedingUp = lastMessage;
      runUnowned = lastCompletedWasEmpty;
    }
  }
  finishRun();
  if (hasIncompleteTail(upChunks, upTerminator)) stats.incompleteTails += 1;

  messages.sort((left, right) => left.seq - right.seq
    || left.withinEventOrder - right.withinEventOrder);
  let overflowPending = false;
  const merged = [];
  for (const message of messages) {
    if (message.type === 'overflow') {
      overflowPending = true;
      continue;
    }
    if (message.direction === 'up') {
      message.followsOverflow = overflowPending;
      overflowPending = false;
    }
    merged.push(message);
  }
  return { messages: merged, greetingTainted };
}

function pairMessages(messages, quietMs, homework, stats, connectionId) {
  const firstUp = messages.findIndex((message) => message.direction === 'up');
  const greeting = firstUp === -1
    ? messages.filter((message) => message.direction === 'down')
    : messages.slice(0, firstUp).filter((message) => message.direction === 'down');
  const ambiguous = new Set();
  const ambiguousRequestKeys = new Set();
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.direction !== 'up') continue;
    if (message.followsOverflow) ambiguous.add(index);
    let next = index + 1;
    while (next < messages.length && messages[next].direction === 'down') next += 1;
    if (next < messages.length && messages[next].direction === 'up'
      && next === index + 1 && messages[next].t - message.t < quietMs) {
      ambiguous.add(index);
      ambiguous.add(next);
    }
  }

  const exchanges = [];
  for (let index = 0; index < messages.length; index += 1) {
    const request = messages[index];
    if (request.direction !== 'up') continue;
    const down = [];
    let next = index + 1;
    while (next < messages.length && messages[next].direction === 'down') {
      down.push(messages[next]);
      next += 1;
    }
    if (ambiguous.has(index)) {
      stats.ambiguousRequests += 1;
      stats.ambiguousReplies += down.length;
      const decoded = decodeRequest(request.bytes);
      ambiguousRequestKeys.add(decoded === null ? byteKey(request.bytes) : decoded);
      homework.add(
        'causality_ambiguous', 1,
        decoded === null ? undefined : displayText(decoded),
        `${connectionId}:${request.seq}:${request.order}`,
      );
    } else if (!request.tainted) {
      const observation = concatBytes(down.map((message) => message.raw));
      exchanges.push({
        connectionId,
        request: request.bytes,
        requestSeq: request.seq,
        observation,
        replyMessages: down.length,
      });
      stats.cleanExchanges += 1;
      if (down.length === 0) stats.silentExchanges += 1;
    }
    index = next - 1;
  }
  return { greeting, exchanges, ambiguousRequestKeys };
}

function analyze(recording, options, homework) {
  const stats = {
    connections: recording.connections.length,
    messagesUp: 0,
    messagesDown: 0,
    emptyMessages: 0,
    cleanExchanges: 0,
    silentExchanges: 0,
    ambiguousRequests: 0,
    ambiguousReplies: 0,
    commands: 0,
    upTerminator: null,
    oversizeMessages: 0,
    incompleteTails: 0,
  };

  let upTerminator = options.terminator;
  if (upTerminator === undefined) {
    const inferred = inferTerminator(recording, 'up');
    upTerminator = inferred.terminator ?? 'cr';
    if (inferred.terminator === null) homework.add('no_terminator_found');
    else if (inferred.ambiguous) homework.add('terminator_ambiguous');
  }
  stats.upTerminator = upTerminator;

  const exchanges = [];
  const greetings = [];
  const connectionExchanges = new Map();
  const ambiguousRequestKeys = new Set();
  for (const connection of recording.connections) {
    const extracted = extractConnection(
      recording, connection, upTerminator, homework, stats,
    );
    const paired = pairMessages(extracted.messages, options.quietMs, homework, stats, connection.id);
    exchanges.push(...paired.exchanges);
    for (const key of paired.ambiguousRequestKeys) ambiguousRequestKeys.add(key);
    connectionExchanges.set(connection.id, paired.exchanges);
    if (extracted.messages.length > 0) {
      greetings.push({
        connectionId: connection.id,
        bytes: extracted.greetingTainted
          ? new Uint8Array()
          : concatBytes(paired.greeting.map((message) => message.raw)),
      });
    }
  }
  return { stats, exchanges, greetings, connectionExchanges, ambiguousRequestKeys };
}

function groupExchanges(exchanges, homework) {
  const groups = new Map();
  const excluded = new Set();
  for (const exchange of exchanges) {
    const rawKey = byteKey(exchange.request);
    const request = decodeRequest(exchange.request);
    if (request === null) {
      homework.add('binary_messages', 1, undefined, `request:${rawKey}`);
      excluded.add(rawKey);
      continue;
    }
    let group = groups.get(request);
    if (group === undefined) {
      group = { request, exchanges: [], firstSeq: exchange.requestSeq, rawKeys: new Set() };
      groups.set(request, group);
    }
    group.exchanges.push(exchange);
    group.rawKeys.add(rawKey);
  }
  return { groups, excluded };
}

function notationValue(parts) {
  return parts.length === 1 ? parts[0] : parts;
}

function draftCommands(analysis, options, homework) {
  const { groups, excluded } = groupExchanges(analysis.exchanges, homework);
  const candidates = [];
  for (const group of groups.values()) {
    const key = group.request;
    const observations = new Map();
    let binaryReply = false;
    for (const exchange of group.exchanges) {
      const observationKey = byteKey(exchange.observation);
      observations.set(observationKey, exchange.observation);
      if (exchange.observation.length > 0 && decodeBytes(exchange.observation) === null) {
        binaryReply = true;
      }
    }
    if (binaryReply) {
      homework.add('binary_messages', 1, displayText(group.request), `reply:${key}`);
      excluded.add(key);
      continue;
    }
    if (observations.size > 1) {
      homework.add(
        'state_dependent', 1,
        `${displayText(group.request)} (${observations.size})`,
        key,
      );
      excluded.add(key);
      continue;
    }
    const pattern = toPattern(group.request);
    const observation = observations.values().next().value;
    const replyText = observation.length === 0 ? '' : decodeBytes(observation);
    const parts = replyText === '' ? null : toNotationParts(replyText);
    if (group.request.length === 0 || pattern === null || (replyText !== '' && parts === null)) {
      homework.add('unrepresentable', 1, displayText(group.request), key);
      excluded.add(key);
      continue;
    }
    if (group.exchanges.length === 1) {
      homework.add('observed_once', 1, displayText(group.request), key);
    }
    if (group.exchanges.some((exchange) => exchange.replyMessages >= 2)) {
      homework.add('multi_message_reply', 1, displayText(group.request), key);
    }
    candidates.push({
      request: group.request,
      pattern,
      reply: parts === null ? null : notationValue(parts),
      observation,
      count: group.exchanges.length,
      firstSeq: group.firstSeq,
    });
  }
  candidates.sort((left, right) => right.count - left.count || left.firstSeq - right.firstSeq);
  if (candidates.length > options.maxCommands) {
    homework.add('too_many_commands', candidates.length - options.maxCommands);
  }
  return { included: candidates.slice(0, options.maxCommands), excluded };
}

function draftGreeting(greetings, homework) {
  if (greetings.length === 0 || greetings.every((greeting) => greeting.bytes.length === 0)) {
    return { value: undefined, expected: null };
  }
  const frequencies = new Map();
  for (const greeting of greetings) {
    const key = byteKey(greeting.bytes);
    frequencies.set(key, (frequencies.get(key) ?? 0) + 1);
    if (greeting.bytes.length > 0 && decodeBytes(greeting.bytes) === null) {
      homework.add('binary_messages', 1, undefined, `greeting:${key}`);
    }
  }
  let commonKey = null;
  let commonCount = -1;
  for (const [key, count] of frequencies) {
    if (count > commonCount) {
      commonKey = key;
      commonCount = count;
    }
  }
  const allNonEmpty = greetings.every((greeting) => greeting.bytes.length > 0);
  if (!allNonEmpty || frequencies.size !== 1) {
    homework.add('greeting_varies', greetings.length - commonCount);
    return { value: undefined, expected: null };
  }
  const bytes = greetings[0].bytes;
  const text = decodeBytes(bytes);
  if (text === null) {
    homework.add('binary_messages', 1, undefined, `greeting:${commonKey}`);
    return { value: undefined, expected: null };
  }
  const parts = toNotationParts(text);
  if (parts === null) {
    homework.add('unrepresentable', 1, 'greeting', 'greeting');
    return { value: undefined, expected: null };
  }
  return { value: notationValue(parts), expected: bytes };
}

function buildDraft(recording, normalizedOptions) {
  const homework = createHomework();
  if (recording.truncated) homework.add('truncated_recording');
  const analysis = analyze(recording, normalizedOptions, homework);
  const commandDraft = draftCommands(analysis, normalizedOptions, homework);
  for (const key of analysis.ambiguousRequestKeys) commandDraft.excluded.add(key);
  const greeting = draftGreeting(analysis.greetings, homework);
  homework.add('no_variables');

  const json = {
    schemaVersion: 1,
    name: 'Draft from recording',
    description: `Draft from a recording of ${analysis.stats.connections} connection(s) with ${analysis.stats.cleanExchanges} usable exchange(s). A starting point only.`,
    framing: { terminator: analysis.stats.upTerminator },
  };
  if (greeting.value !== undefined) json.greeting = greeting.value;
  json.commands = commandDraft.included.map((candidate) => ({
    pattern: candidate.pattern,
    reply: candidate.reply,
  }));
  const checked = validateDefinition(json);
  if (!checked.ok) throw new Error('internal: draft invalid');
  analysis.stats.commands = json.commands.length;
  const result = {
    json,
    definition: checked.definition,
    homework: homework.output(),
    stats: analysis.stats,
  };
  resultMetadata.set(result, {
    options: normalizedOptions,
    commands: commandDraft.included,
    excluded: commandDraft.excluded,
    greeting: greeting.expected,
  });
  return result;
}

function draftDefinition(recording, options = {}) {
  refuseUdp(recording);
  if (!isNormalizedRecording(recording)) throw new TypeError('recording must be normalized');
  return buildDraft(recording, normalizeOptions(options));
}

function replayOutput(definition, request) {
  const outcome = createDeviceEngine(definition).handleMessage(new TextEncoder().encode(request));
  return concatBytes(outcome.effects
    .filter((effect) => effect.kind === 'reply')
    .map((effect) => effect.bytes));
}

function replayCheck(draftResult, recording) {
  refuseUdp(recording);
  if (!isPlainObject(draftResult) || !isValidatedDefinition(draftResult.definition)
    || !isNormalizedRecording(recording)) throw new TypeError('Invalid replay input');
  const metadata = resultMetadata.get(draftResult);
  if (metadata === undefined) throw new TypeError('draftResult must come from draftDefinition');
  const homework = createHomework();
  const analysis = analyze(recording, metadata.options, homework);
  const observations = new Map();
  for (const exchange of analysis.exchanges) {
    const request = decodeRequest(exchange.request);
    if (request === null) continue;
    let values = observations.get(request);
    if (values === undefined) {
      values = new Map();
      observations.set(request, values);
    }
    values.set(byteKey(exchange.observation), exchange.observation);
  }
  const failures = [];
  for (const command of metadata.commands) {
    const actual = replayOutput(draftResult.definition, command.request);
    const recorded = observations.get(command.request);
    const expected = recorded?.values().next().value ?? null;
    if ((expected === null || recorded.size !== 1 || !sameBytes(actual, expected))
      && failures.length < 50) {
      failures.push({
        request: command.request,
        expected: expected === null ? null : Uint8Array.from(expected),
        actual,
      });
    }
  }
  const actualGreeting = createDeviceEngine(draftResult.definition).greeting();
  const expectedGreeting = draftGreeting(analysis.greetings, createHomework()).expected;
  const greetingMatches = actualGreeting === null && expectedGreeting === null
    || actualGreeting !== null && expectedGreeting !== null
      && sameBytes(actualGreeting, expectedGreeting);
  if (!greetingMatches && failures.length < 50) {
    failures.push({
      request: null,
      expected: expectedGreeting === null ? null : Uint8Array.from(expectedGreeting),
      actual: actualGreeting,
    });
  }
  return { checked: metadata.commands.length, failures };
}

function subRecording(recording, excludedId) {
  const result = { schemaVersion: 1 };
  if (Object.hasOwn(recording, 'name')) result.name = recording.name;
  if (Object.hasOwn(recording, 'startedAt')) result.startedAt = recording.startedAt;
  if (Object.hasOwn(recording, 'target')) result.target = { ...recording.target };
  result.truncated = recording.truncated;
  if (Object.hasOwn(recording, 'truncatedReason')) result.truncatedReason = recording.truncatedReason;
  result.connections = recording.connections
    .filter((connection) => connection.id !== excludedId)
    .map((connection) => ({ ...connection }));
  result.events = recording.events
    .filter((event) => event.c !== excludedId)
    .map((event) => ({ ...event, bytes: Uint8Array.from(event.bytes) }));
  return result;
}

function evaluateHoldout(recording, options = {}) {
  refuseUdp(recording);
  if (!isNormalizedRecording(recording)) throw new TypeError('recording must be normalized');
  const normalizedOptions = normalizeOptions(options);
  const fullHomework = createHomework();
  const full = analyze(recording, normalizedOptions, fullHomework);
  const eligible = recording.connections
    .filter((connection) => (full.connectionExchanges.get(connection.id) ?? []).length > 0);
  if (eligible.length < 2) return { evaluable: false, reason: 'need_two_connections' };

  const totals = { exchanges: 0, reproduced: 0, mismatched: 0, unseen: 0, unsupported: 0 };
  for (const connection of eligible) {
    const training = subRecording(recording, connection.id);
    const draft = buildDraft(training, normalizedOptions);
    const metadata = resultMetadata.get(draft);
    const commands = new Map(metadata.commands.map((command) => [command.request, command]));
    for (const exchange of full.connectionExchanges.get(connection.id)) {
      totals.exchanges += 1;
      const request = decodeRequest(exchange.request);
      if (request === null || request.length === 0 || toPattern(request) === null) {
        totals.unsupported += 1;
        continue;
      }
      const command = commands.get(request);
      if (command === undefined) {
        if (metadata.excluded.has(request) || metadata.excluded.has(byteKey(exchange.request))) {
          totals.unsupported += 1;
        } else totals.unseen += 1;
        continue;
      }
      const actual = replayOutput(draft.definition, request);
      if (sameBytes(actual, exchange.observation)) totals.reproduced += 1;
      else totals.mismatched += 1;
    }
  }
  return { evaluable: true, ...totals, rate: totals.reproduced / totals.exchanges };
}

module.exports = {
  canDraft,
  draftDefinition,
  evaluateHoldout,
  replayCheck,
  DRAFT_LIMITS,
  HOMEWORK_CODES,
};
