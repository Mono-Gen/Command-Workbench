// Regression tests for main-process service boundaries that are easy to weaken accidentally.
const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createService } = require('../../src/main/service');
const { createConnection } = require('../../src/main/connection');
const { createCommandStore } = require('../../src/main/storage');
const { createFakeClock, FakeSocket, flush } = require('../helpers/fakes');

const DATA = {
  schemaVersion: 1,
  devices: [{
    name: 'Matrix',
    host: '192.0.2.5',
    port: 1100,
    commands: [
      { name: 'Get power', text: 'GETPWR[CR]', mode: 'text', appendTerminator: 'none', kind: 'query' },
      { name: 'Power on', text: 'SETPWR 1[CR]', mode: 'text', appendTerminator: 'none', kind: 'set' },
    ],
  }],
};

const clone = (value) => JSON.parse(JSON.stringify(value));

async function setup(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pw-audit-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'workbench-commands.json');
  await fsp.writeFile(file, JSON.stringify(DATA));

  const clock = createFakeClock();
  const sockets = [];
  const confirmCalls = [];
  let service;
  const connection = createConnection({
    createSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
    scheduler: clock.scheduler,
    now: clock.now,
    onEvent: (event) => service.handleConnectionEvent(event),
  });
  service = createService({
    connection,
    store: createCommandStore({ fs: fsp, dir, sleep: async () => {} }),
    confirm: async (info) => { confirmCalls.push(info); return false; },
    now: clock.now,
    scheduler: clock.scheduler,
  });
  await service.init();
  return { service, sockets, confirmCalls, clock, file };
}

async function connect(ctx) {
  assert.equal(ctx.service.connect({ host: '192.0.2.5', port: 1100 }).ok, true);
  ctx.sockets.at(-1).emit('connect');
  await flush();
}

test('saveData validates and saves without showing a confirmation', async (t) => {
  const ctx = await setup(t);
  const next = clone(DATA);
  next.devices[0].commands.push({ name: 'Status', text: 'STATUS[CR]', mode: 'text', appendTerminator: 'none' });
  next.devices[0].commands[0].text = 'OTHER[CR]';

  const result = await ctx.service.saveData(next);
  assert.equal(result.ok, true);
  assert.equal(ctx.confirmCalls.length, 0);
  assert.equal(result.data.devices[0].commands[2].expectsReply, true);
  assert.equal(Object.hasOwn(result.data.devices[0].commands[2], 'kind'), false);
  assert.deepEqual(JSON.parse(await fsp.readFile(ctx.file, 'utf8')), result.data);
});

test('a save failure leaves the in-memory data unchanged', async () => {
  const original = clone(DATA);
  const connection = {
    getState: () => 'idle',
    getHistory: () => [],
    disconnect: () => ({ ok: true }),
  };
  const store = {
    load: async () => ({ status: 'ok', data: original, errors: [], leftoverTemps: [] }),
    save: async () => ({ ok: false, code: 'write_failed', errno: 'ENOSPC' }),
  };
  const service = createService({ connection, store });
  await service.init();
  const next = clone(DATA);
  next.devices[0].name = 'Changed';

  assert.deepEqual(await service.saveData(next), { ok: false, code: 'write_failed', errno: 'ENOSPC' });
  assert.equal(service.getState().data.devices[0].name, 'Matrix');
});

test('periodic rejects intervals outside 1 through 3600 seconds', async (t) => {
  const ctx = await setup(t);
  await connect(ctx);
  for (const bad of [0, 999, 3600001, 1.5, '5000']) {
    assert.deepEqual(
      await ctx.service.startPeriodic({ device: 'Matrix', command: 'Get power', intervalMs: bad }),
      { ok: false, code: 'invalid_interval' },
    );
  }
  assert.equal(ctx.service.getState().periodicRunning, false);
});

test('long direct input is sent without a dialog; only the 64 KiB parse limit applies', async (t) => {
  const ctx = await setup(t);
  await connect(ctx);
  const long = await ctx.service.sendDirect({ text: 'A'.repeat(1000), mode: 'text', appendTerminator: 'none' });
  assert.equal(long.ok, true);
  assert.equal(ctx.confirmCalls.length, 0);

  const tooLarge = await ctx.service.sendDirect({ text: 'A'.repeat(65537), mode: 'text', appendTerminator: 'none' });
  assert.equal(tooLarge.code, 'parse_error');
  assert.equal(tooLarge.errors[0].code, 'too_large');
});
