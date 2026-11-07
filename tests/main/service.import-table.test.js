const test = require('node:test');
const assert = require('node:assert/strict');

const { validateStore } = require('../../src/core/command-store');
const { createService } = require('../../src/main/service');

const clone = (value) => JSON.parse(JSON.stringify(value));

const BASE_DATA = {
  schemaVersion: 1,
  devices: [{
    name: 'Existing',
    host: '192.0.2.10',
    port: 9000,
    commands: [{ name: 'Saved', text: 'SAVED', mode: 'text', appendTerminator: 'cr', expectsReply: false }],
  }],
};

function table(overrides = {}) {
  return {
    name: 'Table device',
    transport: 'tcp',
    terminator: 'cr',
    greeting: '',
    unknownReply: '',
    rows: [{ command: 'PWR?', reply: 'ON' }, { command: 'SET 1', reply: '' }],
    ...overrides,
  };
}

async function setup({ data = BASE_DATA, saveResult = null } = {}) {
  const saveCalls = [];
  const store = {
    load: async () => ({ status: 'ok', data: clone(data), errors: [], leftoverTemps: [] }),
    save: async (next) => {
      saveCalls.push(clone(next));
      const validation = validateStore(next);
      if (!validation.ok) return { ok: false, code: 'invalid_data', errors: validation.errors };
      return saveResult ?? { ok: true };
    },
  };
  const connection = {
    getState: () => 'idle',
    getHistory: () => [],
    disconnect: () => ({ ok: true }),
  };
  const confirmCalls = [];
  const service = createService({ connection, store, confirm: (...args) => confirmCalls.push(args) });
  await service.init();
  return { service, saveCalls, confirmCalls };
}

test('importTable adds commands to an existing device and never requests confirmation', async () => {
  const ctx = await setup();
  const result = await ctx.service.importTable({ table: table(), target: { existing: 'Existing' } });
  assert.equal(result.ok, true);
  assert.equal(result.added, 2);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.data.devices[0].commands.slice(1), [
    { name: 'PWR?', text: 'PWR?', mode: 'text', appendTerminator: 'cr', expectsReply: true },
    { name: 'SET 1', text: 'SET 1', mode: 'text', appendTerminator: 'cr', expectsReply: false },
  ]);
  assert.equal(Object.hasOwn(result.data.devices[0].commands[1], 'kind'), false);
  assert.equal(ctx.saveCalls.length, 1);
  assert.equal(ctx.confirmCalls.length, 0);
});

test('importTable creates TCP and UDP devices with only the allowed transport field', async () => {
  const tcp = await setup();
  const tcpResult = await tcp.service.importTable({
    table: table(), target: { create: { name: 'TCP device', host: '127.0.0.1', port: 10001 } },
  });
  assert.equal(tcpResult.ok, true);
  assert.deepEqual(tcpResult.data.devices[1], {
    name: 'TCP device', host: '127.0.0.1', port: 10001,
    commands: [
      { name: 'PWR?', text: 'PWR?', mode: 'text', appendTerminator: 'cr', expectsReply: true },
      { name: 'SET 1', text: 'SET 1', mode: 'text', appendTerminator: 'cr', expectsReply: false },
    ],
  });

  const udp = await setup();
  const udpResult = await udp.service.importTable({
    table: table({ transport: 'udp', terminator: 'lf' }),
    target: { create: { name: 'UDP device', host: '127.0.0.1', port: 10002 } },
  });
  assert.equal(udpResult.ok, true);
  assert.equal(udpResult.data.devices[1].transport, 'udp');
  assert.equal(udpResult.data.devices[1].commands[0].appendTerminator, 'lf');
  assert.equal(udp.confirmCalls.length, 0);
});

test('importTable skips canonical same-name commands and does not save when all are skipped', async () => {
  const data = clone(BASE_DATA);
  data.devices[0].commands = [
    { name: ' PÓWER ', text: 'OLD', mode: 'text', appendTerminator: 'none', expectsReply: true },
    { name: 'Other', text: 'OTHER', mode: 'text', appendTerminator: 'none', expectsReply: true },
  ];
  const ctx = await setup({ data });
  const decomposed = 'po\u0301wer';
  const result = await ctx.service.importTable({
    table: table({ rows: [{ command: decomposed, reply: 'ON' }, { command: 'NEW', reply: '' }] }),
    target: { existing: 'Existing' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.added, 1);
  assert.deepEqual(result.skipped, [decomposed]);
  assert.equal(result.data.devices[0].commands.at(-1).name, 'NEW');

  const allSkipped = await setup({ data });
  const unchanged = allSkipped.service.getState().data;
  const skipped = await allSkipped.service.importTable({
    table: table({ rows: [{ command: decomposed, reply: 'ON' }] }),
    target: { existing: 'Existing' },
  });
  assert.deepEqual(skipped, { ok: true, data: unchanged, added: 0, skipped: [decomposed] });
  assert.equal(allSkipped.saveCalls.length, 0);
});

test('importTable reports unknown devices and invalid tables without saving', async () => {
  const ctx = await setup();
  assert.deepEqual(
    await ctx.service.importTable({ table: table(), target: { existing: 'Missing' } }),
    { ok: false, code: 'unknown_device' },
  );
  const rows = Array.from({ length: 60 }, (_, index) => ({ command: '', reply: `reply ${index}` }));
  const invalid = await ctx.service.importTable({ table: table({ rows }), target: { existing: 'Existing' } });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, 'invalid_table');
  assert.equal(invalid.errors.length, 50);
  assert.equal(invalid.totalErrors, 60);
  assert.deepEqual(invalid.errors[0], { where: { row: 0 }, code: 'command_empty', source: 'table' });
  assert.equal(ctx.saveCalls.length, 0);
});

test('importTable returns standard store validation errors and leaves memory unchanged', async () => {
  const ctx = await setup();
  const before = clone(ctx.service.getState().data);
  const result = await ctx.service.importTable({
    table: table(),
    target: { create: { name: ' existing ', host: '127.0.0.1', port: 10003 } },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid_data');
  assert.deepEqual(result.errors, [{ path: 'devices[1].name', code: 'duplicate_name' }]);
  assert.deepEqual(ctx.service.getState().data, before);
  assert.equal(ctx.saveCalls.length, 1);
});

test('importTable accepts 1000 commands and returns the standard error for 1001', async () => {
  const dataWith = (count) => ({
    schemaVersion: 1,
    devices: [{
      name: 'Existing', host: '192.0.2.10', port: 9000,
      commands: Array.from({ length: count }, (_, index) => ({
        name: `C${index}`, text: `C${index}`, mode: 'text', appendTerminator: 'none', expectsReply: false,
      })),
    }],
  });

  const atLimit = await setup({ data: dataWith(999) });
  const accepted = await atLimit.service.importTable({
    table: table({ rows: [{ command: 'LAST', reply: '' }] }), target: { existing: 'Existing' },
  });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.data.devices[0].commands.length, 1000);

  const overLimit = await setup({ data: dataWith(1000) });
  const before = clone(overLimit.service.getState().data);
  const rejected = await overLimit.service.importTable({
    table: table({ rows: [{ command: 'OVER', reply: '' }] }), target: { existing: 'Existing' },
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'invalid_data');
  assert.deepEqual(rejected.errors, [{ path: 'devices[0].commands', code: 'too_many' }]);
  assert.deepEqual(overLimit.service.getState().data, before);
});

test('importTable leaves memory unchanged when saving fails', async () => {
  const failure = { ok: false, code: 'write_failed', errno: 'ENOSPC' };
  const ctx = await setup({ saveResult: failure });
  const before = clone(ctx.service.getState().data);
  const result = await ctx.service.importTable({ table: table(), target: { existing: 'Existing' } });
  assert.deepEqual(result, failure);
  assert.deepEqual(ctx.service.getState().data, before);
  assert.equal(ctx.saveCalls.length, 1);
  assert.equal(ctx.confirmCalls.length, 0);
});

test('importTable skips a later row whose name equals an earlier one of the same import (case is ignored), keeping the first', async () => {
  const ctx = await setup();
  // The table itself allows "PWR?" and "pwr?" (different text); as saved-command names they are the same.
  const result = await ctx.service.importTable({
    table: table({ rows: [{ command: 'PWR?', reply: 'ON' }, { command: 'pwr?', reply: 'ON' }, { command: 'VER?', reply: '1' }] }),
    target: { existing: 'Existing' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.added, 2);
  assert.deepEqual(result.skipped, ['pwr?']);
  assert.deepEqual(result.data.devices[0].commands.map((command) => command.name), ['Saved', 'PWR?', 'VER?']);
});

test('importTable keeps within the store limits: too many commands for one device is refused as invalid data and nothing is kept', async () => {
  const crowded = clone(BASE_DATA);
  crowded.devices[0].commands = Array.from({ length: 999 }, (_, index) => ({ name: `C${index}`, text: 'X', mode: 'text', appendTerminator: 'none', expectsReply: false }));
  const ctx = await setup({ data: crowded });
  const result = await ctx.service.importTable({
    table: table({ rows: [{ command: 'N1', reply: '' }, { command: 'N2', reply: '' }] }),
    target: { existing: 'Existing' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid_data');
  assert.equal(ctx.service.getState().data.devices[0].commands.length, 999, 'the in-memory data is unchanged');
});
