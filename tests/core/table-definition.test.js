// The table builder turns "command -> reply" rows into a definition. Expected values come from the
// rules in docs/device-definition.md (first match wins, terminator chosen once, silence = no reply),
// not from running the builder: where a definition is produced, it is run through the real engine.
const test = require('node:test');
const assert = require('node:assert/strict');

const { buildTableDefinition, tableDefinitionText, LIMITS } = require('../../src/core/table-definition');
const { parseDefinitionText } = require('../../src/core/device-definition');
const { createDeviceEngine } = require('../../src/core/device-engine');

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);

function input(overrides = {}) {
  return {
    name: 'Test device',
    transport: 'tcp',
    terminator: 'cr',
    greeting: '',
    unknownReply: '',
    rows: [{ command: 'PWR?', reply: 'PWR on' }, { command: 'VER?', reply: 'VER 1.0' }],
    ...overrides,
  };
}

const talk = (engine, text) => engine.handleMessage(Uint8Array.from(Buffer.from(text, 'utf8')));
const replies = (outcome) => outcome.effects.map((e) => Buffer.from(e.bytes).toString('utf8'));
const codes = (result) => result.errors.map((e) => `${e.where.row ?? e.where.field}:${e.code}`);

test('two rows become two commands; each reply ends with the chosen terminator', () => {
  for (const [terminator, ending] of [['cr', CR], ['lf', LF], ['crlf', CR + LF]]) {
    const result = buildTableDefinition(input({ terminator }));
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    const engine = createDeviceEngine(result.definition);
    assert.deepEqual(replies(talk(engine, 'PWR?')), [`PWR on${ending}`]);
    assert.deepEqual(replies(talk(engine, 'VER?')), [`VER 1.0${ending}`]);
    assert.equal(result.definition.framing.terminator, terminator);
  }
});

test('the generated text is a definition the loader accepts, in reading order', () => {
  const result = buildTableDefinition(input({ greeting: 'HELLO', unknownReply: 'ERR' }));
  assert.equal(result.ok, true);
  const text = tableDefinitionText(result.json);
  assert.ok(text.endsWith('\n'));
  assert.deepEqual(Object.keys(JSON.parse(text)), ['schemaVersion', 'name', 'framing', 'greeting', 'commands', 'unknown']);
  assert.equal(parseDefinitionText(text).ok, true);
});

test('greeting and the reply to an unknown command carry the terminator too', () => {
  const result = buildTableDefinition(input({ greeting: 'HELLO', unknownReply: 'ERR 2' }));
  const engine = createDeviceEngine(result.definition);
  assert.equal(Buffer.from(engine.greeting()).toString('utf8'), `HELLO${CR}`);
  assert.deepEqual(replies(talk(engine, 'NOPE')), [`ERR 2${CR}`]);
});

test('an empty reply is silence, and an empty unknown reply means nothing is sent for unknown commands', () => {
  const result = buildTableDefinition(input({ rows: [{ command: 'SET 1', reply: '' }, { command: 'GET', reply: 'OK' }] }));
  assert.equal(result.ok, true);
  assert.equal(result.json.commands[0].reply, null);
  assert.equal(Object.hasOwn(result.json, 'unknown'), false);
  const engine = createDeviceEngine(result.definition);
  assert.deepEqual(replies(talk(engine, 'SET 1')), []);
  assert.deepEqual(replies(talk(engine, 'NOPE')), []);
});

test('manual notation in a reply is turned into bytes, like in the controller', () => {
  const result = buildTableDefinition(input({ rows: [{ command: 'A', reply: 'X[TAB]Y[LF]Z' }] }));
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(replies(talk(createDeviceEngine(result.definition), 'A')), [`X\tY${LF}Z${CR}`]);
});

test('braces and stars typed in a cell are literal text, not pattern or reference syntax', () => {
  const result = buildTableDefinition(input({ rows: [{ command: 'A{B}*', reply: 'got {var.x} {{' }] }));
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const engine = createDeviceEngine(result.definition);
  assert.deepEqual(replies(talk(engine, 'A{B}*')), [`got {var.x} {{${CR}`]);
  assert.deepEqual(replies(talk(engine, 'AxBx')), [], 'the star does not act as a wildcard');
});

test('spaces around a command are not part of it, spaces inside are', () => {
  const result = buildTableDefinition(input({ rows: [{ command: '  PWR 1  ', reply: 'OK' }] }));
  assert.equal(result.json.commands[0].pattern, 'PWR 1');
});

test('the blank rows at the end are ignored, and row numbers still count them', () => {
  const rows = [{ command: '', reply: '' }, { command: 'A', reply: 'a' }, { command: '', reply: '' }, { command: 'A', reply: 'b' }, { command: '', reply: '' }];
  const result = buildTableDefinition(input({ rows }));
  assert.deepEqual(codes(result), ['3:command_duplicate']);
  assert.equal(result.errors[0].detail.firstRow, 1);
});

test('UDP: the transport is written, and a greeting is refused', () => {
  const ok = buildTableDefinition(input({ transport: 'udp' }));
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  assert.equal(ok.json.transport, 'udp');
  assert.deepEqual(codes(buildTableDefinition(input({ transport: 'udp', greeting: 'HI' }))), ['greeting:greeting_udp']);
});

test('row errors point at the row', () => {
  const rows = [
    { command: 'OK', reply: 'fine' },
    { command: '', reply: 'orphan reply' },
    { command: 'DUP', reply: 'a' },
    { command: 'DUP', reply: 'b' },
    { command: 'TERM[CR]', reply: 'x' },
    { command: 'B', reply: 'x<LF>' },
    { command: `TAB${String.fromCharCode(9)}X`, reply: 'x' },
    { command: 'C', reply: `a${LF}b` },
    { command: 'D', reply: 'bad [ZZ] notation' },
  ];
  assert.deepEqual(codes(buildTableDefinition(input({ rows }))), [
    '1:command_empty', '3:command_duplicate', '4:command_terminator_included', '5:reply_terminator_included',
    '6:command_control_character', '7:reply_control_character',
  ]);
});

test('a notation error in a reply is found by the validator and still points at the row', () => {
  const result = buildTableDefinition(input({ rows: [{ command: 'A', reply: 'ok' }, { command: 'B', reply: 'bad [ZZ] notation' }] }));
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.deepEqual(result.errors[0].where, { row: 1 });
  assert.equal(result.errors[0].source, 'definition');
  assert.equal(result.errors[0].code, 'invalid_notation');
});

test('a bad notation in the greeting or the unknown reply points at that field', () => {
  assert.deepEqual(codes(buildTableDefinition(input({ greeting: '[ZZ]' }))), ['greeting:invalid_notation']);
  assert.deepEqual(codes(buildTableDefinition(input({ unknownReply: '[ZZ]' }))), ['unknownReply:invalid_notation']);
});

test('name: required, and 100 characters at most (the boundary is accepted)', () => {
  assert.deepEqual(codes(buildTableDefinition(input({ name: '   ' }))), ['name:name_required']);
  assert.deepEqual(codes(buildTableDefinition(input({ name: 'x'.repeat(101) }))), ['name:name_too_long']);
  assert.equal(buildTableDefinition(input({ name: 'x'.repeat(100) })).ok, true);
});

test('size boundaries: 500 rows pass, 501 fail; a 256-character command passes, 257 fails', () => {
  const make = (n) => Array.from({ length: n }, (_, i) => ({ command: `C${i}`, reply: 'r' }));
  assert.equal(buildTableDefinition(input({ rows: make(LIMITS.MAX_ROWS) })).ok, true);
  assert.deepEqual(codes(buildTableDefinition(input({ rows: make(LIMITS.MAX_ROWS + 1) }))), ['rows:too_many_rows']);
  assert.equal(buildTableDefinition(input({ rows: [{ command: 'c'.repeat(256), reply: 'r' }] })).ok, true);
  assert.deepEqual(codes(buildTableDefinition(input({ rows: [{ command: 'c'.repeat(257), reply: 'r' }] }))), ['0:command_too_long']);
});

test('the limits count the text after escaping and the terminator', () => {
  // 129 stars become 258 characters of pattern.
  assert.deepEqual(codes(buildTableDefinition(input({ rows: [{ command: '*'.repeat(129), reply: 'r' }] }))), ['0:command_too_long']);
  // 1022 characters + "[CR]" (4) = 1026 > 1024; 1020 + 4 = 1024 is the limit.
  assert.deepEqual(codes(buildTableDefinition(input({ rows: [{ command: 'A', reply: 'r'.repeat(1022) }] }))), ['0:reply_too_long']);
  assert.equal(buildTableDefinition(input({ rows: [{ command: 'A', reply: 'r'.repeat(1020) }] })).ok, true);
});

test('no rows at all is an error', () => {
  assert.deepEqual(codes(buildTableDefinition(input({ rows: [] }))), ['rows:no_rows']);
  assert.deepEqual(codes(buildTableDefinition(input({ rows: [{ command: ' ', reply: '' }] }))), ['rows:no_rows']);
});

test('malformed input is rejected without throwing', () => {
  const bad = [null, undefined, 5, 'x', [], input({ name: 5 }), input({ transport: 'ftp' }), input({ terminator: 'none' }),
    input({ greeting: null }), input({ unknownReply: 1 }), input({ rows: 'x' }), input({ rows: [null] }),
    input({ rows: [{ command: 'A' }] }), input({ rows: [{ command: 1, reply: 'x' }] })];
  for (const value of bad) {
    const result = buildTableDefinition(value);
    assert.equal(result.ok, false, JSON.stringify(value));
    assert.equal(result.errors[0].code, 'invalid_input');
  }
});

test('a terminator written in a spelling the parser reads as a byte (hex) is also refused, so it is never sent twice', () => {
  // "0x0D" after a space and "\x0D" are CR to the notation parser: the table would add a second CR.
  for (const reply of ['OK 0x0D', 'OK 0x0d', 'OK\\x0D', 'OK\\r']) {
    assert.deepEqual(codes(buildTableDefinition(input({ rows: [{ command: 'A', reply }] }))), ['0:reply_terminator_included'], reply);
  }
  assert.deepEqual(codes(buildTableDefinition(input({ greeting: 'HI 0x0D' }))), ['greeting:reply_terminator_included']);
  assert.deepEqual(codes(buildTableDefinition(input({ unknownReply: 'ERR 0x0D' }))), ['unknownReply:reply_terminator_included']);
  // The terminator of THIS table is what counts: a LF at the end of a CR table is just text of the reply.
  assert.equal(buildTableDefinition(input({ rows: [{ command: 'A', reply: 'OK 0x0A' }] })).ok, true);
  assert.deepEqual(codes(buildTableDefinition(input({ terminator: 'crlf', rows: [{ command: 'A', reply: 'OK 0x0D\\x0A' }] }))), ['0:reply_terminator_included']);
  // A CR and a LF with something between them are not the CR+LF terminator.
  assert.equal(buildTableDefinition(input({ terminator: 'crlf', rows: [{ command: 'A', reply: 'OK 0x0D 0x0A' }] })).ok, true);
  // After a letter or digit "0x0D" is ordinary text (the parser's own rule), so it is not a terminator.
  assert.equal(buildTableDefinition(input({ rows: [{ command: 'A', reply: 'OK0x0D' }] })).ok, true);
  // A cell the parser rejects is reported by the validator, once, at its row.
  assert.deepEqual(codes(buildTableDefinition(input({ rows: [{ command: 'A', reply: 'bad [ZZ]' }] }))), ['0:invalid_notation']);
});

test('the input object is not changed', () => {
  const value = input({ rows: [{ command: ' A ', reply: 'x' }] });
  const before = JSON.stringify(value);
  buildTableDefinition(value);
  assert.equal(JSON.stringify(value), before);
});
