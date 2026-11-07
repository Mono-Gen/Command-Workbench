// Builds a virtual-device definition from a plain table of "command -> reply" rows.
//
// This is the beginner path: it covers fixed replies only (no variables, conditions or
// notifications). Everything it produces goes through validateDefinition, so the table never has
// its own idea of what a valid definition is; the checks done here only exist to point at the ROW
// that is wrong, which the validator (that sees one finished JSON document) cannot do.
//
// Pure and deterministic. Row 0 is the first row of the table.
const { validateDefinition } = require('./device-definition');
const { parseCommand } = require('./parse-command');

const LIMITS = Object.freeze({
  MAX_ROWS: 500,
  MAX_NAME: 100,
  MAX_PATTERN: 256, // the validator's limit on the pattern AFTER escaping
  MAX_REPLY: 1024, // the validator's limit on a reply template AFTER escaping and the terminator
});

const TERMINATORS = Object.freeze({ cr: '[CR]', lf: '[LF]', crlf: '[CR][LF]' });
const TRANSPORTS = ['tcp', 'udp'];

// A terminator written in manual notation at the end of a cell. The terminator is chosen once for
// the whole table, so writing it in a cell would send it twice.
const TERMINATOR_BYTES = Object.freeze({ cr: [0x0d], lf: [0x0a], crlf: [0x0d, 0x0a] });
const TRAILING_TERMINATOR = /(?:\[(?:CR|LF|CRLF)\]|<(?:CR|LF|CRLF)>|\\r|\\n)\s*$/i;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

// True when the cell, read the way a reply is read (notation turned into bytes), ends with the chosen
// terminator: this also catches spellings the pattern above does not list, such as "0x0D" or "\x0D".
// A cell the parser rejects is left to the validator, which reports the notation mistake itself.
function endsWithTerminator(text, terminator) {
  const parsed = parseCommand(text, { mode: 'text', appendTerminator: 'none' });
  if (!parsed.ok) return false;
  const tail = TERMINATOR_BYTES[terminator];
  const { bytes } = parsed;
  return bytes.length >= tail.length && tail.every((byte, index) => bytes[bytes.length - tail.length + index] === byte);
}

const isPlainObject = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

// In a pattern "{", "}" and "*" are special; in a reply "{" and "}" are. A table cell is always
// literal text, so they are doubled and the table cannot reach the pattern syntax by accident.
const escapePattern = (text) => text.replaceAll('{', '{{').replaceAll('}', '}}').replaceAll('*', '**');
const escapeReply = (text) => text.replaceAll('{', '{{').replaceAll('}', '}}');

function describeInput(input) {
  if (!isPlainObject(input)) return 'not_an_object';
  if (typeof input.name !== 'string') return 'name';
  if (!TRANSPORTS.includes(input.transport)) return 'transport';
  if (!Object.hasOwn(TERMINATORS, input.terminator)) return 'terminator';
  if (typeof input.greeting !== 'string') return 'greeting';
  if (typeof input.unknownReply !== 'string') return 'unknownReply';
  if (!Array.isArray(input.rows)) return 'rows';
  for (const row of input.rows) {
    if (!isPlainObject(row) || typeof row.command !== 'string' || typeof row.reply !== 'string') return 'rows';
  }
  return null;
}

function checkReplyCell(text, input, fail, where) {
  if (CONTROL_CHARACTER.test(text)) {
    fail(where, 'reply_control_character');
    return null;
  }
  if (TRAILING_TERMINATOR.test(text) || endsWithTerminator(text, input.terminator)) {
    fail(where, 'reply_terminator_included');
    return null;
  }
  const template = escapeReply(text) + TERMINATORS[input.terminator];
  if (template.length > LIMITS.MAX_REPLY) {
    fail(where, 'reply_too_long');
    return null;
  }
  return template;
}

function collectTableRows(input, fail, { maxCommandName = null } = {}) {
  // Rows that are blank in both cells are not rows (the empty line at the end of the table).
  const used = [];
  input.rows.forEach((row, index) => {
    if (row.command.trim().length > 0 || row.reply.length > 0) used.push({ row, index });
  });
  if (used.length > LIMITS.MAX_ROWS) fail({ field: 'rows' }, 'too_many_rows');
  else if (used.length === 0) fail({ field: 'rows' }, 'no_rows');

  const rows = [];
  const firstSeen = new Map();
  for (const { row, index } of used.slice(0, LIMITS.MAX_ROWS)) {
    const where = { row: index };
    const command = row.command.trim();
    let ok = true;
    if (command.length === 0) {
      fail(where, 'command_empty');
      ok = false;
    } else if (CONTROL_CHARACTER.test(command)) {
      fail(where, 'command_control_character');
      ok = false;
    } else if (TRAILING_TERMINATOR.test(command)) {
      fail(where, 'command_terminator_included');
      ok = false;
    } else if (maxCommandName !== null && command.length > maxCommandName) {
      fail(where, 'command_name_too_long');
      ok = false;
    } else if (escapePattern(command).length > LIMITS.MAX_PATTERN) {
      fail(where, 'command_too_long');
      ok = false;
    } else if (firstSeen.has(command)) {
      // The first matching command wins, so the second one could never be used.
      fail(where, 'command_duplicate', { firstRow: firstSeen.get(command) });
      ok = false;
    } else {
      firstSeen.set(command, index);
    }

    // An empty reply is a deliberate silence, not a missing value.
    let reply = null;
    if (row.reply.length > 0) {
      reply = checkReplyCell(row.reply, input, fail, where);
      if (reply === null) ok = false;
    }
    if (ok) rows.push({ command, reply, expectsReply: row.reply.length > 0, index });
  }
  return rows;
}

function escapeCommandText(text) {
  let escaped = '';
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const codeUnit = text.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = text.charCodeAt(index + 1);
      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
        escaped += text.slice(index, index + 2);
        index += 1;
      } else {
        escaped += '\\xEF\\xBF\\xBD';
      }
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      escaped += '\\xEF\\xBF\\xBD';
    } else if (character === '0'
      && (text[index + 1] === 'x' || text[index + 1] === 'X')
      && (index === 0 || !/[0-9A-Za-z]/.test(text[index - 1]))) {
      escaped += '\\x30';
    } else if ('\\[]<>'.includes(character)) {
      escaped += `\\${character}`;
    } else {
      escaped += character;
    }
  }
  return escaped;
}

// Errors are { where, code, source, detail? }. `where` is { row: n } or { field: name }.
// `source` is 'table' for the checks made here and 'definition' for what the validator reported.
function buildTableDefinition(input) {
  const invalid = describeInput(input);
  if (invalid !== null) {
    return { ok: false, errors: [{ where: { field: invalid === 'not_an_object' ? 'input' : invalid }, code: 'invalid_input', source: 'table' }] };
  }

  const errors = [];
  const fail = (where, code, detail) => errors.push(detail === undefined
    ? { where, code, source: 'table' }
    : { where, code, source: 'table', detail });

  const name = input.name.trim();
  if (name.length === 0) fail({ field: 'name' }, 'name_required');
  else if (name.length > LIMITS.MAX_NAME) fail({ field: 'name' }, 'name_too_long');

  const commands = [];
  const origin = []; // origin[commandIndex] = table row index, to point validator errors back at a row
  for (const row of collectTableRows(input, fail)) {
    commands.push({ pattern: escapePattern(row.command), reply: row.reply });
    origin.push(row.index);
  }

  const udp = input.transport === 'udp';
  let greeting = null;
  if (input.greeting.length > 0) {
    if (udp) fail({ field: 'greeting' }, 'greeting_udp');
    else greeting = checkReplyCell(input.greeting, input, fail, { field: 'greeting' });
  }
  let unknownReply = null;
  if (input.unknownReply.length > 0) unknownReply = checkReplyCell(input.unknownReply, input, fail, { field: 'unknownReply' });

  if (errors.length > 0) return { ok: false, errors };

  // Key order is the reading order of the finished file; it is also what a beginner sees.
  const json = { schemaVersion: 1 };
  json.name = name;
  if (udp) json.transport = 'udp';
  json.framing = { terminator: input.terminator };
  if (greeting !== null) json.greeting = greeting;
  json.commands = commands;
  if (unknownReply !== null) json.unknown = { reply: unknownReply };

  const checked = validateDefinition(json);
  if (!checked.ok) return { ok: false, errors: checked.errors.map((error) => mapDefinitionError(error, origin)) };
  return { ok: true, json, definition: checked.definition };
}

function buildTableCommands(input) {
  const invalid = describeInput(input);
  if (invalid !== null) {
    return { ok: false, errors: [{ where: { field: invalid === 'not_an_object' ? 'input' : invalid }, code: 'invalid_input', source: 'table' }] };
  }

  const errors = [];
  const fail = (where, code, detail) => errors.push(detail === undefined
    ? { where, code, source: 'table' }
    : { where, code, source: 'table', detail });
  const rows = collectTableRows(input, fail, { maxCommandName: LIMITS.MAX_NAME });
  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    commands: rows.map((row) => ({
      name: row.command,
      text: escapeCommandText(row.command),
      mode: 'text',
      appendTerminator: input.terminator,
      expectsReply: row.expectsReply,
    })),
  };
}

// Points a validator error (a JSON Pointer into the finished document) back at the table.
function mapDefinitionError(error, origin) {
  const mapped = { code: error.code, source: 'definition' };
  if (error.detail !== undefined) mapped.detail = error.detail;
  const commandMatch = /^\/commands\/(\d+)(?:\/|$)/.exec(error.pointer);
  if (commandMatch !== null && origin[Number(commandMatch[1])] !== undefined) {
    mapped.where = { row: origin[Number(commandMatch[1])] };
  } else if (error.pointer === '/name') mapped.where = { field: 'name' };
  else if (error.pointer === '/greeting') mapped.where = { field: 'greeting' };
  else if (error.pointer.startsWith('/unknown')) mapped.where = { field: 'unknownReply' };
  else mapped.where = { field: 'definition', pointer: error.pointer };
  return mapped;
}

// The text shown and saved: two-space JSON and a final newline, like the samples.
function tableDefinitionText(json) {
  return `${JSON.stringify(json, null, 2)}\n`;
}

module.exports = { buildTableDefinition, buildTableCommands, tableDefinitionText, LIMITS, TERMINATORS };
