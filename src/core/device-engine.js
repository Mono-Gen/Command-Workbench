const { isValidatedDefinition } = require('./device-definition');

const textEncoder = new TextEncoder();
const fatalDecoder = new TextDecoder('utf-8', { fatal: true });
const MAX_REPLY_BYTES = 4096;
// Upper bound on the characters scanned while matching ONE message against all commands. Without
// it a hostile definition plus a long message could keep the main thread busy for seconds. A
// message that exhausts the budget is treated as unknown.
const MAX_MATCH_WORK = 2000000;

function asciiFoldCode(code) {
  return code >= 0x41 && code <= 0x5a ? code + 0x20 : code;
}

function literalMatchesAt(text, position, literal, caseInsensitive) {
  if (position + literal.length > text.length) {
    return false;
  }
  for (let index = 0; index < literal.length; index += 1) {
    const actual = text.charCodeAt(position + index);
    const expected = literal.charCodeAt(index);
    if (caseInsensitive) {
      if (asciiFoldCode(actual) !== asciiFoldCode(expected)) {
        return false;
      }
    } else if (actual !== expected) {
      return false;
    }
  }
  return true;
}

// ASCII-only case folding (A-Z -> a-z); every other character is left as it is.
function foldAscii(text) {
  return text.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x20));
}

// Returns the earliest position >= start where `literal` occurs, -1 if it does not occur, or -2 when
// the matching budget is used up. Uses the engine's native search instead of a hand-written loop.
function findLiteral(ctx, literal, start, caseInsensitive) {
  ctx.work += ctx.text.length - start + 1;
  if (ctx.work > MAX_MATCH_WORK) {
    return -2;
  }
  if (caseInsensitive) {
    // Folded once per message, on first use.
    if (ctx.folded === null) ctx.folded = foldAscii(ctx.text);
    return ctx.folded.indexOf(foldAscii(literal), start);
  }
  return ctx.text.indexOf(literal, start);
}

function matchCommand(command, ctx) {
  const { text } = ctx;
  const captures = {};
  let position = 0;
  for (let index = 0; index < command.pattern.length; index += 1) {
    const element = command.pattern[index];
    if (element.type === 'literal') {
      if (!literalMatchesAt(text, position, element.text, command.caseInsensitive)) {
        return null;
      }
      position += element.text.length;
      continue;
    }

    const next = command.pattern[index + 1];
    if (next === undefined) {
      const captured = text.slice(position);
      if (element.type === 'capture') {
        if (captured.length === 0 || captured.includes(' ')) {
          return null;
        }
        captures[element.name] = captured;
      }
      position = text.length;
      continue;
    }

    const searchStart = element.type === 'capture' ? position + 1 : position;
    const end = findLiteral(ctx, next.text, searchStart, command.caseInsensitive);
    if (end < 0) {
      return null;
    }
    if (element.type === 'capture') {
      const captured = text.slice(position, end);
      if (captured.includes(' ')) {
        return null;
      }
      captures[element.name] = captured;
    }
    position = end;
  }
  return position === text.length ? captures : null;
}

function renderValue(value) {
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  return String(value);
}

function renderTemplate(template, values, captures = {}, limit = MAX_REPLY_BYTES) {
  const chunks = [];
  let totalLength = 0;
  for (const token of template) {
    let chunk;
    if (token.type === 'static') {
      chunk = token.bytes;
    } else {
      const value = token.source === 'var' ? values[token.name] : captures[token.name];
      chunk = textEncoder.encode(renderValue(value));
    }
    totalLength += chunk.length;
    if (totalLength > limit) {
      return { tooLarge: true, bytes: null };
    }
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { tooLarge: false, bytes };
}

function convertValue(value, variable) {
  if (variable.type === 'int') {
    let converted;
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value)) {
        return { ok: false };
      }
      converted = value;
    } else if (typeof value === 'string' && /^-?(0|[1-9][0-9]*)$/.test(value)) {
      converted = Number(value);
      if (!Number.isSafeInteger(converted)) {
        return { ok: false };
      }
    } else {
      return { ok: false };
    }
    return converted >= variable.min && converted <= variable.max
      ? { ok: true, value: converted }
      : { ok: false };
  }
  if (variable.type === 'bool') {
    if (typeof value === 'boolean') {
      return { ok: true, value };
    }
    if (value === 'true' || value === 'false') {
      return { ok: true, value: value === 'true' };
    }
    return { ok: false };
  }
  if (variable.type === 'enum') {
    return typeof value === 'string' && variable.values.includes(value)
      ? { ok: true, value }
      : { ok: false };
  }
  if (variable.type === 'string') {
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      return { ok: false };
    }
    const converted = renderValue(value);
    return converted.length <= variable.maxLength
      ? { ok: true, value: converted }
      : { ok: false };
  }
  return { ok: false };
}

function conditionHolds(condition, values) {
  const value = values[condition.var];
  if (Object.hasOwn(condition, 'is')) {
    return value === condition.is;
  }
  if (Object.hasOwn(condition, 'isNot')) {
    return value !== condition.isNot;
  }
  if (Object.hasOwn(condition, 'in')) {
    return condition.in.some((candidate) => candidate === value);
  }
  if (Object.hasOwn(condition, 'min') && value < condition.min) {
    return false;
  }
  return !Object.hasOwn(condition, 'max') || value <= condition.max;
}

function createDeviceEngine(definition) {
  if (!isValidatedDefinition(definition)) {
    throw new TypeError('definition must be a validated definition');
  }

  let values = initialValues();

  function initialValues() {
    return Object.fromEntries(
      Object.entries(definition.variables).map(([name, variable]) => [name, variable.initial]),
    );
  }

  function getState() {
    return { values: { ...values } };
  }

  function reset() {
    values = initialValues();
  }

  function greeting() {
    if (definition.greeting === null) {
      return null;
    }
    const rendered = renderTemplate(definition.greeting, values);
    return rendered.tooLarge ? null : rendered.bytes;
  }

  function notificationEffects(changes) {
    const changedNames = new Set(changes.map((change) => change.var));
    const effects = [];
    for (const notification of definition.notifications) {
      if (!changedNames.has(notification.variable)) {
        continue;
      }
      const rendered = renderTemplate(notification.send, values);
      if (!rendered.tooLarge) {
        effects.push({
          type: 'send',
          to: notification.to,
          kind: 'notification',
          bytes: rendered.bytes,
          delayMs: 0,
        });
      }
    }
    return effects;
  }

  function unknownOutcome(outcome, commandIndex, captures = {}) {
    const effects = [];
    if (definition.unknownReply !== null) {
      const rendered = renderTemplate(definition.unknownReply, values, captures);
      if (!rendered.tooLarge) {
        effects.push({
          type: 'send', to: 'sender', kind: 'reply', bytes: rendered.bytes, delayMs: 0,
        });
      } else {
        outcome = 'reply_too_large';
      }
    }
    return { outcome, commandIndex, effects, changes: [] };
  }

  function finishHandled(command, commandIndex, path, captures, changes) {
    let template;
    let fallsThrough = false;
    if (path === 'matched') {
      template = command.reply;
    } else {
      const handler = command[path];
      fallsThrough = !handler.present;
      template = handler.reply;
    }
    if (fallsThrough) {
      return unknownOutcome(path, commandIndex, captures);
    }

    const effects = [];
    let outcome = path;
    if (template !== null) {
      const rendered = renderTemplate(template, values, captures);
      if (rendered.tooLarge) {
        outcome = 'reply_too_large';
      } else {
        effects.push({
          type: 'send',
          to: 'sender',
          kind: 'reply',
          bytes: rendered.bytes,
          delayMs: command.delayMs,
        });
      }
    }
    if (path === 'matched') {
      effects.push(...notificationEffects(changes));
    }
    return { outcome, commandIndex, effects, changes };
  }

  function handleMessage(bytes) {
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError('bytes must be a Uint8Array');
    }
    if (bytes.length === 0) {
      return { outcome: 'empty', commandIndex: null, effects: [], changes: [] };
    }

    let text;
    try {
      text = fatalDecoder.decode(bytes);
    } catch {
      return unknownOutcome('unknown_undecodable', null);
    }

    let commandIndex = -1;
    let command;
    let rawCaptures;
    const ctx = { text, folded: null, work: 0 };
    for (let index = 0; index < definition.commands.length; index += 1) {
      const matched = matchCommand(definition.commands[index], ctx);
      // Budget exhausted: stop looking; the message counts as unknown.
      if (ctx.work > MAX_MATCH_WORK) break;
      if (matched !== null) {
        commandIndex = index;
        command = definition.commands[index];
        rawCaptures = matched;
        break;
      }
    }
    if (commandIndex === -1) {
      return unknownOutcome('unknown', null);
    }

    const captures = {};
    let mapMiss = false;
    for (const name of command.captureNames) {
      const raw = rawCaptures[name];
      const config = command.captures[name];
      if (config !== undefined && config.map !== undefined) {
        if (Object.hasOwn(config.map, raw)) {
          captures[name] = config.map[raw];
        } else {
          captures[name] = raw;
          mapMiss = true;
        }
      } else {
        captures[name] = raw;
      }
    }
    if (mapMiss) {
      return finishHandled(command, commandIndex, 'invalid', captures, []);
    }

    if (!command.when.every((condition) => conditionHolds(condition, values))) {
      return finishHandled(command, commandIndex, 'otherwise', captures, []);
    }

    const converted = {};
    for (const [name, source] of Object.entries(command.set)) {
      const candidate = source.source === 'capture' ? captures[source.name] : source.value;
      const result = convertValue(candidate, definition.variables[name]);
      if (!result.ok) {
        return finishHandled(command, commandIndex, 'invalid', captures, []);
      }
      converted[name] = result.value;
    }

    const changes = [];
    for (const [name, next] of Object.entries(converted)) {
      const previous = values[name];
      if (previous !== next) {
        changes.push({ var: name, from: previous, to: next });
      }
    }
    values = { ...values, ...converted };
    return finishHandled(command, commandIndex, 'matched', captures, changes);
  }

  function applyStatePatch(patch) {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)
      || (Object.getPrototypeOf(patch) !== Object.prototype && Object.getPrototypeOf(patch) !== null)) {
      throw new TypeError('values must be a plain object');
    }
    const converted = {};
    for (const [name, candidate] of Object.entries(patch)) {
      const variable = definition.variables[name];
      if (variable === undefined) {
        throw new TypeError('Unknown variable');
      }
      const result = convertValue(candidate, variable);
      if (!result.ok) {
        throw new TypeError('Invalid variable value');
      }
      converted[name] = result.value;
    }

    const changes = [];
    for (const [name, next] of Object.entries(converted)) {
      const previous = values[name];
      if (previous !== next) {
        changes.push({ var: name, from: previous, to: next });
      }
    }
    values = { ...values, ...converted };
    return { changes, effects: notificationEffects(changes) };
  }

  return { getState, reset, greeting, handleMessage, applyStatePatch };
}

module.exports = { createDeviceEngine, MAX_MATCH_WORK };
