// The table builder turns "command -> reply" rows into a definition. Expected values come from the
// rules in docs/device-definition.md (first match wins, terminator chosen once, silence = no reply),
// not from running the builder: where a definition is produced, it is run through the real engine.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildTableDefinition, buildTableCommands, definitionToTable, tableDefinitionText, LIMITS,
} = require('../../src/core/table-definition');
const { parseCommand } = require('../../src/core/parse-command');
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

test('table commands use literal command names and reply presence without a kind', () => {
  const result = buildTableCommands(input({
    rows: [{ command: '  PWR?  ', reply: 'PWR on' }, { command: 'SET 1', reply: '' }],
  }));
  assert.deepEqual(result, {
    ok: true,
    commands: [
      { name: 'PWR?', text: 'PWR?', mode: 'text', appendTerminator: 'cr', expectsReply: true },
      { name: 'SET 1', text: 'SET 1', mode: 'text', appendTerminator: 'cr', expectsReply: false },
    ],
  });
  assert.equal(Object.hasOwn(result.commands[0], 'kind'), false);
});

function expectedCommandBytes(command, terminator) {
  const endings = { cr: [0x0d], lf: [0x0a], crlf: [0x0d, 0x0a] };
  return Buffer.concat([Buffer.from(command, 'utf8'), Buffer.from(endings[terminator])]);
}

function assertCommandInvariant(command, terminator = 'cr') {
  const built = buildTableCommands(input({ terminator, rows: [{ command, reply: 'reply' }] }));
  assert.equal(built.ok, true, `${JSON.stringify(command)}: ${JSON.stringify(built.errors)}`);
  const parsed = parseCommand(built.commands[0].text, { mode: 'text', appendTerminator: terminator });
  assert.equal(parsed.ok, true, `${JSON.stringify(command)}: ${JSON.stringify(parsed.errors)}`);
  assert.deepEqual(Buffer.from(parsed.bytes), expectedCommandBytes(command.trim(), terminator), JSON.stringify(command));
}

test('table command text preserves tricky literal cells byte-for-byte', () => {
  const commands = [
    'A<B>', 'x[1]', 'a\\b', 'OK 0x0D', 'A0x0D', '0xZZ', '0X1f', '\\0x1', ']', '>',
    '日本語', '{}*', 'spaces inside', '\ud800',
  ];
  for (const command of commands) assertCommandInvariant(command);
});

test('table command text preserves deterministic pseudo-random cells byte-for-byte', () => {
  const alphabet = ['A', 'z', '0', '9', 'x', 'X', ' ', '\\', '[', ']', '<', '>', '{', '}', '*', '?', 'あ'];
  const documentedErrors = new Set([
    'command_empty', 'command_control_character', 'command_terminator_included', 'command_name_too_long',
    'command_too_long', 'command_duplicate', 'reply_control_character', 'reply_terminator_included',
    'reply_too_long', 'too_many_rows', 'no_rows',
  ]);
  let state = 0x51f15e;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  for (let caseIndex = 0; caseIndex < 3000; caseIndex += 1) {
    const length = 1 + (random() % 8);
    let command = '';
    for (let index = 0; index < length; index += 1) command += alphabet[random() % alphabet.length];
    if (command.trim().length === 0) command = `A${command.slice(1)}`;
    const built = buildTableCommands(input({ rows: [{ command, reply: 'reply' }] }));
    if (!built.ok) {
      assert.ok(built.errors.length > 0);
      for (const error of built.errors) assert.ok(documentedErrors.has(error.code), JSON.stringify(error));
      continue;
    }
    const parsed = parseCommand(built.commands[0].text, { mode: 'text', appendTerminator: 'cr' });
    assert.equal(parsed.ok, true, `${JSON.stringify(command)}: ${JSON.stringify(parsed.errors)}`);
    assert.deepEqual(Buffer.from(parsed.bytes), expectedCommandBytes(command.trim(), 'cr'), JSON.stringify(command));
  }
});

test('table command names accept 100 characters and reject 101 without truncating', () => {
  const accepted = buildTableCommands(input({ rows: [{ command: 'n'.repeat(100), reply: '' }] }));
  assert.equal(accepted.ok, true);
  assert.equal(accepted.commands[0].name.length, 100);

  const rejected = buildTableCommands(input({ rows: [{ command: 'n'.repeat(101), reply: '' }] }));
  assert.deepEqual(codes(rejected), ['0:command_name_too_long']);
});

test('table commands share the 500-row boundary', () => {
  const rows = Array.from({ length: LIMITS.MAX_ROWS }, (_, index) => ({ command: `C${index}`, reply: '' }));
  assert.equal(buildTableCommands(input({ rows })).ok, true);
  assert.deepEqual(
    codes(buildTableCommands(input({ rows: [...rows, { command: 'OVER', reply: '' }] }))),
    ['rows:too_many_rows'],
  );
});

test('table commands share row validation and preserve original row numbers around blanks', () => {
  const rows = [
    { command: '', reply: '' },
    { command: '', reply: 'orphan' },
    { command: 'DUP', reply: '' },
    { command: '', reply: '' },
    { command: 'DUP', reply: '' },
    { command: `BAD${String.fromCharCode(9)}X`, reply: '' },
    { command: 'TERM[CR]', reply: '' },
    { command: 'OK', reply: `bad${String.fromCharCode(10)}` },
  ];
  const result = buildTableCommands(input({ rows }));
  assert.deepEqual(codes(result), [
    '1:command_empty', '4:command_duplicate', '5:command_control_character',
    '6:command_terminator_included', '7:reply_control_character',
  ]);
  assert.deepEqual(result.errors[1].detail, { firstRow: 2 });
  assert.deepEqual(codes(buildTableCommands(input({ rows: [] }))), ['rows:no_rows']);
  assert.deepEqual(codes(buildTableCommands(input({ rows: [{ command: ' ', reply: '' }] }))), ['rows:no_rows']);
});

test('table commands preserve all three automatic terminators', () => {
  for (const terminator of ['cr', 'lf', 'crlf']) assertCommandInvariant('A<B> 0xZZ', terminator);
});

test('definitionToTable is the inverse for canonical table inputs, including tricky literal text', () => {
  const rows = [
    { command: String.raw`A\[x]<y> 0x0D {z}*`, reply: String.raw`R\\\[x\]\<y\> \x30x0A {z}*` },
    { command: '日本語😀?', reply: '返答😀[TAB]終わり' },
    { command: 'SILENT', reply: '' },
  ];
  for (const terminator of ['cr', 'lf', 'crlf']) {
    for (const transport of ['tcp', 'udp']) {
      const original = input({
        name: `Round trip ${transport} ${terminator}`,
        transport,
        terminator,
        greeting: transport === 'tcp' ? String.raw`HELLO \\ \[ \] \< \> \x30x 😀 {x}` : '',
        unknownReply: String.raw`ERR \\ \[ \] \< \> \x30x 😀 {x}`,
        rows,
      });
      const built = buildTableDefinition(original);
      assert.equal(built.ok, true, JSON.stringify(built.errors));
      assert.deepEqual(definitionToTable(built.json), { ok: true, input: original });
    }
  }
});

function definition(overrides = {}) {
  return {
    schemaVersion: 1,
    name: 'Readable definition',
    framing: { terminator: 'cr' },
    commands: [{ pattern: 'PING', reply: 'PONG[CR]' }],
    ...overrides,
  };
}

function rejectionCode(value) {
  const result = definitionToTable(value);
  assert.equal(result.ok, false, JSON.stringify(result));
  return result.reasons.map((reason) => reason.code);
}

const rejectionCases = [
  ['invalid_definition', definition({ name: 7 }), 'invalid_definition'],
  ['unknown_top_level_field', definition({ extra: true }), 'unknown_top_level_field'],
  ['description_not_supported', definition({ description: 'extra' }), 'description_not_supported'],
  ['connection_not_supported', definition({ connection: {} }), 'connection_not_supported'],
  ['variables_not_supported', definition({ variables: {} }), 'variables_not_supported'],
  ['notifications_not_supported', definition({ notifications: [] }), 'notifications_not_supported'],
  ['unsupported_schema_version', definition({ schemaVersion: 2 }), 'unsupported_schema_version'],
  ['unsupported_transport', definition({ transport: 'serial' }), 'unsupported_transport'],
  ['custom_framing_not_supported', definition({ framing: { terminator: 'cr', maxLength: 20 } }), 'custom_framing_not_supported'],
  ['unsupported_terminator', definition({ framing: { terminator: 'nul' } }), 'unsupported_terminator'],
  ['command_id_not_supported', definition({ commands: [{ id: 'ping', pattern: 'PING', reply: 'PONG[CR]' }] }), 'command_id_not_supported'],
  ['case_insensitive_not_supported', definition({ commands: [{ pattern: 'PING', caseInsensitive: true, reply: 'PONG[CR]' }] }), 'case_insensitive_not_supported'],
  ['capture_not_supported', definition({ commands: [{ pattern: 'P {x}', capture: {}, reply: 'OK[CR]' }] }), 'capture_not_supported'],
  ['conditions_not_supported', definition({ commands: [{ pattern: 'PING', when: [], reply: 'PONG[CR]' }] }), 'conditions_not_supported'],
  ['state_changes_not_supported', definition({ commands: [{ pattern: 'PING', do: { set: {} }, reply: 'PONG[CR]' }] }), 'state_changes_not_supported'],
  ['delay_not_supported', definition({ commands: [{ pattern: 'PING', delayMs: 1, reply: 'PONG[CR]' }] }), 'delay_not_supported'],
  ['alternate_reply_not_supported', definition({ commands: [{ pattern: 'PING', otherwise: { reply: 'NO[CR]' }, reply: 'PONG[CR]' }] }), 'alternate_reply_not_supported'],
  ['unknown_command_field', definition({ commands: [{ pattern: 'PING', reply: 'PONG[CR]', extra: true }] }), 'unknown_command_field'],
  ['unknown_reply_field_not_supported', definition({ unknown: { reply: 'ERR[CR]', extra: true } }), 'unknown_reply_field_not_supported'],
  ['multiple_replies_not_supported', definition({ commands: [{ pattern: 'PING', reply: ['A[CR]', 'B[CR]'] }] }), 'multiple_replies_not_supported'],
  ['reply_terminator_mismatch', definition({ commands: [{ pattern: 'PING', reply: 'PONG[LF]' }] }), 'reply_terminator_mismatch'],
  ['empty_reply_not_supported', definition({ commands: [{ pattern: 'PING', reply: '[CR]' }] }), 'empty_reply_not_supported'],
  ['non_fixed_reply', definition({ commands: [{ pattern: '{value}', reply: '{capture.value}[CR]' }] }), 'non_fixed_reply'],
  ['reply_control_character', definition({ commands: [{ pattern: 'PING', reply: 'A\tB[CR]' }] }), 'reply_control_character'],
  ['name_whitespace_not_preserved', definition({ name: ' Padded ' }), 'name_whitespace_not_preserved'],
  ['no_commands', definition({ commands: [] }), 'no_commands'],
  ['non_literal_pattern', definition({ commands: [{ pattern: 'P*', reply: 'PONG[CR]' }] }), 'non_literal_pattern'],
  ['command_whitespace_not_preserved', definition({ commands: [{ pattern: ' PING ', reply: 'PONG[CR]' }] }), 'command_whitespace_not_preserved'],
  ['command_control_character', definition({ commands: [{ pattern: 'A\tB', reply: 'PONG[CR]' }] }), 'command_control_character'],
  ['duplicate_command', definition({ commands: [{ pattern: 'PING', reply: null }, { pattern: 'PING', reply: null }] }), 'duplicate_command'],
  ['command_terminator_included', definition({ commands: [{ pattern: 'PING[CR]', reply: 'PONG[CR]' }] }), 'command_terminator_included'],
  ['reply_terminator_included', definition({ commands: [{ pattern: 'PING', reply: 'PONG[CR][CR]' }] }), 'reply_terminator_included'],
];

for (const [name, value, expected] of rejectionCases) {
  test(`definitionToTable rejects ${name} with its specific reason`, () => {
    assert.ok(rejectionCode(value).includes(expected));
  });
}

test('every bundled sample has the spec-derived readable/rejected classification', () => {
  const sampleDir = path.join(__dirname, '..', '..', 'src', 'samples');
  const expected = {
    'matrix-switch.json': ['description_not_supported', 'connection_not_supported', 'variables_not_supported', 'notifications_not_supported'],
    'quirky-player.json': ['description_not_supported', 'connection_not_supported', 'variables_not_supported', 'notifications_not_supported'],
    'udp-unit.json': ['description_not_supported', 'connection_not_supported', 'variables_not_supported', 'notifications_not_supported'],
  };
  assert.deepEqual(fs.readdirSync(sampleDir).filter((file) => file.endsWith('.json')).sort(), Object.keys(expected));
  for (const [file, expectedReasons] of Object.entries(expected)) {
    const json = JSON.parse(fs.readFileSync(path.join(sampleDir, file), 'utf8'));
    const result = definitionToTable(json);
    assert.equal(result.ok, false, file);
    const actual = result.reasons.map((reason) => reason.code);
    for (const code of expectedReasons) assert.ok(actual.includes(code), `${file}: ${code}`);
  }
});
