// The "make a definition from a table" calls of the device service. The table builder itself is
// tested in tests/core/table-definition.test.js; here the service's own rules are checked: what
// reaches the page, when a definition may be replaced, and how saving goes through the dialog.
const test = require('node:test');
const assert = require('node:assert/strict');

const { createDeviceService } = require('../../src/main/device-service');
const { createDeviceServer } = require('../../src/main/device-server');
const { bundledSampleStore } = require('../helpers/sample-store');
const { createFakeClock } = require('../helpers/fakes');
const { FakeServer } = require('../helpers/fake-server');

function setup({ saveText, chooseFile = async () => ({ ok: false, code: 'cancelled' }) } = {}) {
  const clock = createFakeClock();
  let service;
  const server = createDeviceServer({
    createServer: (handler) => new FakeServer(handler),
    scheduler: clock.scheduler,
    now: clock.now,
    onEvent: (event) => service.handleServerEvent(event),
  });
  service = createDeviceService({
    server,
    chooseFile,
    sampleStore: bundledSampleStore(),
    confirm: async () => true,
    saveText,
    emit: () => {},
    now: clock.now,
    scheduler: clock.scheduler,
  });
  return { service };
}

const table = (overrides = {}) => ({
  name: 'Table device',
  transport: 'tcp',
  terminator: 'cr',
  greeting: 'HELLO',
  unknownReply: '',
  rows: [{ command: 'PWR?', reply: 'PWR on' }, { command: 'SET 1', reply: '' }, { command: '', reply: '' }],
  ...overrides,
});

test('preview returns the JSON text that would be saved, and changes nothing', () => {
  const { service } = setup();
  const result = service.tablePreview(table());
  assert.equal(result.ok, true);
  const parsed = JSON.parse(result.text);
  assert.deepEqual(parsed.commands, [{ pattern: 'PWR?', reply: 'PWR on[CR]' }, { pattern: 'SET 1', reply: null }]);
  assert.equal(parsed.greeting, 'HELLO[CR]');
  assert.equal(service.getState().definition, null, 'a preview does not load anything');
});

test('use loads the definition and describes it as made from a table', () => {
  const { service } = setup();
  const result = service.tableUse(table());
  assert.equal(result.ok, true);
  assert.deepEqual(
    { name: result.info.name, source: result.info.source, fileName: result.info.fileName, commandCount: result.info.commandCount },
    { name: 'Table device', source: 'table', fileName: 'table.json', commandCount: 2 },
  );
  assert.deepEqual(result.info.patterns, ['PWR?', 'SET 1']);
  assert.deepEqual(service.getState().definition, result.info);
});

test('a table with problems is reported per row and loads nothing; a good definition stays loaded', () => {
  const { service } = setup();
  assert.equal(service.tableUse(table()).ok, true);
  const bad = service.tableUse(table({ name: 'Other', rows: [{ command: 'A', reply: 'x' }, { command: 'A', reply: 'y' }] }));
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'invalid_table');
  assert.deepEqual(bad.errors.map((e) => [e.where, e.code]), [[{ row: 1 }, 'command_duplicate']]);
  assert.equal(bad.totalErrors, 1);
  assert.equal(service.getState().definition.name, 'Table device');
  assert.equal(service.tablePreview(table({ rows: [] })).code, 'invalid_table');
});

test('use is refused while the server runs, and the running definition is untouched', async () => {
  const { service } = setup();
  service.tableUse(table());
  assert.equal((await service.start({ host: '127.0.0.1', port: 0 })).ok, true);
  assert.deepEqual(service.tableUse(table({ name: 'Replacement' })), { ok: false, code: 'running' });
  assert.equal(service.getState().definition.name, 'Table device');
  await service.stop();
});

test('save goes through the dialog: the text is made after the place is chosen, the page gets the file name only', async () => {
  const calls = [];
  const { service } = setup({
    saveText: async ({ kind, makeText }) => { calls.push({ kind, text: makeText() }); return { ok: true, fileName: 'mine.json' }; },
  });
  const result = await service.tableSave(table());
  assert.deepEqual(result, { ok: true, fileName: 'mine.json' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, 'draft');
  assert.equal(calls[0].text, service.tablePreview(table()).text, 'what is saved is what the preview showed');
});

test('save: a table with problems never opens the dialog; a cancelled dialog is passed on; no dialog available is reported', async () => {
  let opened = 0;
  const { service } = setup({ saveText: async () => { opened += 1; return { ok: false, code: 'cancelled' }; } });
  assert.equal((await service.tableSave(table({ name: '' }))).code, 'invalid_table');
  assert.equal(opened, 0);
  assert.deepEqual(await service.tableSave(table()), { ok: false, code: 'cancelled' });
  assert.deepEqual(await setup().service.tableSave(table()), { ok: false, code: 'save_unavailable' });
});

test('save: a second request while the dialog is open is refused, and the next one works afterwards', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { service } = setup({ saveText: async () => { await gate; return { ok: true, fileName: 'a.json' }; } });
  const first = service.tableSave(table());
  assert.deepEqual(await service.tableSave(table()), { ok: false, code: 'busy' });
  release();
  assert.equal((await first).ok, true);
  assert.equal((await service.tableSave(table())).ok, true);
});

test('load into table reads through the native chooser and returns only validated table input', async () => {
  const source = {
    schemaVersion: 1,
    name: 'Loaded table',
    framing: { terminator: 'lf' },
    greeting: 'HELLO[LF]',
    commands: [{ pattern: 'PING', reply: 'PONG[LF]' }, { pattern: 'SET', reply: null }],
    unknown: { reply: 'ERR[LF]' },
  };
  const { service } = setup({
    chooseFile: async () => ({ ok: true, text: JSON.stringify(source), fileName: 'loaded.json' }),
  });
  assert.deepEqual(await service.tableLoadFile(), {
    ok: true,
    fileName: 'loaded.json',
    input: {
      name: 'Loaded table', transport: 'tcp', terminator: 'lf', greeting: 'HELLO', unknownReply: 'ERR',
      rows: [{ command: 'PING', reply: 'PONG' }, { command: 'SET', reply: '' }],
    },
  });
  assert.equal(service.getState().definition, null, 'loading the editor does not load the virtual device');
});

test('load into table reports invalid definitions and unrepresentable definitions without partial input', async () => {
  const invalid = setup({
    chooseFile: async () => ({ ok: true, text: '{"schemaVersion":1}', fileName: 'invalid.json' }),
  });
  const invalidResult = await invalid.service.tableLoadFile();
  assert.equal(invalidResult.code, 'invalid_definition');
  assert.equal(invalidResult.fileName, 'invalid.json');
  assert.equal(Array.isArray(invalidResult.errors), true);
  assert.equal(Object.hasOwn(invalidResult, 'input'), false);

  const advanced = definitionText({ variables: {}, notifications: [] });
  const rejected = setup({
    chooseFile: async () => ({ ok: true, text: advanced, fileName: 'advanced.json' }),
  });
  const rejectedResult = await rejected.service.tableLoadFile();
  assert.equal(rejectedResult.code, 'definition_not_table');
  assert.deepEqual(rejectedResult.reasons.map((reason) => reason.code), ['variables_not_supported', 'notifications_not_supported']);
  assert.equal(Object.hasOwn(rejectedResult, 'input'), false);
});

function definitionText(overrides = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    name: 'Advanced',
    framing: { terminator: 'cr' },
    commands: [{ pattern: 'PING', reply: 'PONG[CR]' }],
    ...overrides,
  });
}

test('load into table passes cancellation through and refuses a second chooser while the first is open', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { service } = setup({ chooseFile: async () => { await gate; return { ok: false, code: 'cancelled' }; } });
  const first = service.tableLoadFile();
  assert.deepEqual(await service.tableLoadFile(), { ok: false, code: 'busy' });
  release();
  assert.deepEqual(await first, { ok: false, code: 'cancelled' });
  const cancelled = setup().service;
  assert.deepEqual(await cancelled.tableLoadFile(), { ok: false, code: 'cancelled' });
});

test('table load, file load and table save refuse to overlap with each other', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { service } = setup({
    saveText: async () => ({ ok: true, fileName: 'saved.json' }),
    chooseFile: async () => { await gate; return { ok: false, code: 'cancelled' }; },
  });
  const first = service.tableLoadFile();
  assert.deepEqual(await service.loadFile(), { ok: false, code: 'busy' });
  assert.deepEqual(await service.tableSave(table({ rows: [{ command: 'A', reply: 'B' }] })), { ok: false, code: 'busy' });
  release();
  await first;
  // A file load in flight also blocks a table load.
  let release2;
  const gate2 = new Promise((resolve) => { release2 = resolve; });
  const other = setup({ chooseFile: async () => { await gate2; return { ok: false, code: 'cancelled' }; } }).service;
  const pending = other.loadFile();
  assert.deepEqual(await other.tableLoadFile(), { ok: false, code: 'busy' });
  release2();
  await pending;
});
