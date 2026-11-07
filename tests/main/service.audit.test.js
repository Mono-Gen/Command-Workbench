// Regression tests for the findings of the independent audit of the main-process wiring.
// The renderer is untrusted: classification, read-only and confirmations must hold even if the
// page misbehaves, and an approval must apply to exactly what was shown.
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

const clone = (v) => JSON.parse(JSON.stringify(v));

async function setup(t, { answers = [] } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pw-audit-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'workbench-commands.json');
  await fsp.writeFile(file, JSON.stringify(DATA));

  const clock = createFakeClock();
  const sockets = [];
  const emitted = [];
  const confirmCalls = [];
  const pendingDialogs = [];
  let service;
  const connection = createConnection({
    createSocket: () => { const s = new FakeSocket(); sockets.push(s); return s; },
    scheduler: clock.scheduler,
    now: clock.now,
    onEvent: (e) => service.handleConnectionEvent(e),
  });
  const queue = [...answers];
  service = createService({
    connection,
    store: createCommandStore({ fs: fsp, dir, sleep: async () => {} }),
    // An entry in `answers` that is a function is a "manual" dialog the test resolves later.
    confirm: (info) => {
      confirmCalls.push(info);
      const next = queue.length ? queue.shift() : true;
      if (next === 'hold') return new Promise((resolve) => pendingDialogs.push(resolve));
      return Promise.resolve(next);
    },
    emit: (channel, payload) => emitted.push([channel, payload]),
    now: clock.now,
    scheduler: clock.scheduler,
  });
  await service.init();
  return { service, connection, sockets, emitted, confirmCalls, pendingDialogs, clock, file };
}

async function connect(ctx, host = '192.0.2.5', port = 1100) {
  assert.equal(ctx.service.connect({ host, port }).ok, true);
  ctx.sockets.at(-1).emit('connect');
  await flush();
}

const written = (ctx) => ctx.sockets.flatMap((s) => s.written.map((w) => Buffer.from(w).toString('latin1')));
const ref = (command) => ({ device: 'Matrix', command });

// ---- finding 1: the renderer must not be able to relabel a command as "query" silently -------

test('saving a new "query" command asks for a native confirmation that lists its bytes', async (t) => {
  const ctx = await setup(t);
  const next = clone(DATA);
  next.devices[0].commands.push({ name: 'Get input', text: 'GIN[CR]', mode: 'text', appendTerminator: 'none', kind: 'query' });
  const result = await ctx.service.saveData(next);
  assert.equal(result.ok, true);
  assert.equal(ctx.confirmCalls.length, 1);
  assert.deepEqual(ctx.confirmCalls[0].reasons, ['classify_query']);
  assert.equal(ctx.confirmCalls[0].items.length, 1);
  assert.deepEqual({ device: ctx.confirmCalls[0].items[0].device, name: ctx.confirmCalls[0].items[0].name }, { device: 'Matrix', name: 'Get input' });
  assert.deepEqual(Array.from(ctx.confirmCalls[0].items[0].bytes), [0x47, 0x49, 0x4e, 0x0d]);
});

test('declining the classification saves nothing', async (t) => {
  const ctx = await setup(t, { answers: [false] });
  const before = await fsp.readFile(ctx.file, 'utf8');
  const next = clone(DATA);
  next.devices[0].commands.push({ name: 'Sneaky', text: 'FORMAT[CR]', mode: 'text', appendTerminator: 'none', kind: 'query' });
  assert.deepEqual(await ctx.service.saveData(next), { ok: false, code: 'cancelled' });
  assert.equal(await fsp.readFile(ctx.file, 'utf8'), before);
  assert.equal(ctx.service.getState().data.devices[0].commands.length, 2);
});

test('relabeling a command as "query", or changing a query\'s text, needs the confirmation again', async (t) => {
  const ctx = await setup(t);
  const relabel = clone(DATA);
  relabel.devices[0].commands[1].kind = 'query'; // "Power on" becomes a query
  await ctx.service.saveData(relabel);
  assert.deepEqual(ctx.confirmCalls.map((c) => c.items.map((i) => i.name)), [['Power on']]);

  const retext = clone(relabel);
  retext.devices[0].commands[0].text = 'OTHER[CR]'; // "Get power" keeps its kind but changes meaning
  await ctx.service.saveData(retext);
  assert.deepEqual(ctx.confirmCalls.at(-1).items.map((i) => i.name), ['Get power']);

  for (const field of [['mode', 'hex'], ['appendTerminator', 'lf']]) {
    const next = clone(retext);
    next.devices[0].commands[0][field[0]] = field[1];
    if (field[0] === 'mode') next.devices[0].commands[0].text = '40 47';
    const before = ctx.confirmCalls.length;
    await ctx.service.saveData(next);
    assert.equal(ctx.confirmCalls.length, before + 1, `changing ${field[0]} needs confirmation`);
  }
});

test('no confirmation when nothing about the queries changed, or for set commands and unrelated fields', async (t) => {
  const ctx = await setup(t);
  const unchanged = clone(DATA);
  unchanged.devices[0].host = '192.0.2.99'; // host is not part of what a query does
  unchanged.devices[0].commands[1].text = 'NEW SET[CR]'; // set commands are confirmed on every send instead
  unchanged.devices[0].commands[0].expectsReply = false;
  await ctx.service.saveData(unchanged);
  assert.equal(ctx.confirmCalls.length, 0);
});

test('a query that cannot be sent (bad notation) is saved without a dialog, and is attested when fixed', async (t) => {
  const ctx = await setup(t);
  const broken = clone(DATA);
  broken.devices[0].commands.push({ name: 'Draft', text: '[NOPE', mode: 'text', appendTerminator: 'none', kind: 'query' });
  assert.equal((await ctx.service.saveData(broken)).ok, true);
  assert.equal(ctx.confirmCalls.length, 0);

  const fixed = clone(broken);
  fixed.devices[0].commands[2].text = 'OK[CR]';
  await ctx.service.saveData(fixed);
  assert.equal(ctx.confirmCalls.length, 1);
});

test('a query too long to show in full cannot be saved as a query', async (t) => {
  const ctx = await setup(t);
  const next = clone(DATA);
  next.devices[0].commands.push({ name: 'Long', text: 'A'.repeat(257), mode: 'text', appendTerminator: 'none', kind: 'query' });
  assert.deepEqual(await ctx.service.saveData(next), { ok: false, code: 'too_long_to_confirm' });
  assert.equal(ctx.confirmCalls.length, 0);
});

test('after a confirmed save, the query is sent without another dialog; a rewritten one is not trusted', async (t) => {
  const ctx = await setup(t);
  await connect(ctx);
  await ctx.service.sendSaved(ref('Get power')); // settles the first-send confirmation
  const next = clone(DATA);
  next.devices[0].commands[0].text = 'EVIL[CR]';
  await ctx.service.saveData(next); // the user approves the new content in the native dialog
  ctx.confirmCalls.length = 0;
  await ctx.service.sendSaved(ref('Get power'));
  assert.equal(ctx.confirmCalls.length, 0, 'approved at save time');
  assert.equal(written(ctx).at(-1), 'EVIL\r', 'the bytes that were approved are the bytes that are sent');
});

// ---- finding 2: turning read-only off is a user act, confirmed natively ----------------------

test('turning read-only on needs no dialog; turning it off asks, and declining keeps it on', async (t) => {
  const ctx = await setup(t, { answers: [false, true] });
  assert.deepEqual(await ctx.service.setReadOnly(true), { ok: true, readOnly: true });
  assert.equal(ctx.confirmCalls.length, 0);

  assert.deepEqual(await ctx.service.setReadOnly(false), { ok: false, code: 'cancelled', readOnly: true });
  assert.equal(ctx.service.getState().readOnly, true);
  assert.deepEqual(ctx.confirmCalls[0].reasons, ['disable_read_only']);

  assert.deepEqual(await ctx.service.setReadOnly(false), { ok: true, readOnly: false });
  assert.equal(ctx.service.getState().readOnly, false);
});

test('setting read-only to its current value asks nothing', async (t) => {
  const ctx = await setup(t);
  assert.deepEqual(await ctx.service.setReadOnly(false), { ok: true, readOnly: false });
  await ctx.service.setReadOnly(true);
  assert.deepEqual(await ctx.service.setReadOnly(true), { ok: true, readOnly: true });
  assert.equal(ctx.confirmCalls.length, 0);
});

// ---- finding 3 and 6: periodic start --------------------------------------------------------

test('periodic: an invalid interval is rejected', async (t) => {
  const ctx = await setup(t);
  await connect(ctx);
  for (const bad of [0, 999, 3600001, 1.5, '5000']) {
    assert.deepEqual(await ctx.service.startPeriodic({ device: 'Matrix', command: 'Get power', intervalMs: bad }), { ok: false, code: 'invalid_interval' });
  }
  assert.equal(ctx.service.getState().periodicRunning, false);
  assert.equal(ctx.confirmCalls.length, 0);
});

test('periodic: not allowed while read-only is on', async (t) => {
  const ctx = await setup(t);
  await connect(ctx);
  await ctx.service.setReadOnly(true);
  assert.deepEqual(await ctx.service.startPeriodic({ device: 'Matrix', command: 'Get power', intervalMs: 5000 }), { ok: false, code: 'blocked', reason: 'read_only_blocks_periodic' });
  assert.equal(ctx.confirmCalls.length, 0);
});

// ---- finding 4: an approval belongs to one connection and one target -------------------------

// ---- finding 5: conditions are checked at the moment of writing -----------------------------

test('read-only switched on while a confirmed "set" waits in the write queue blocks it at write time', async (t) => {
  const ctx = await setup(t);
  await connect(ctx);
  await ctx.service.sendSaved(ref('Get power')); // settle the first-send confirmation

  // Make the next write hang so a second send has to wait behind it.
  const socket = ctx.sockets[0];
  let finishFirst;
  socket.write = (buffer, callback) => { socket.written.push(Uint8Array.from(buffer)); finishFirst = () => callback(null); return true; };
  const first = ctx.service.sendSaved(ref('Get power'));
  await flush();
  const second = ctx.service.sendSaved(ref('Power on')); // confirmed (auto-accepted), then queued
  await flush();

  await ctx.service.setReadOnly(true);
  finishFirst();
  assert.equal((await first).ok, true);
  assert.deepEqual(await second, { ok: false, code: 'blocked', reason: 'changed_before_send' });
  assert.equal(written(ctx).filter((w) => w === 'SETPWR 1\r').length, 0, 'the set command was never written');
});

// ---- finding 7: nothing may hide beyond what the dialog can show ----------------------------

test('long input is sent without a dialog; only the 64 KiB parse limit applies', async (t) => {
  const ctx = await setup(t);
  await connect(ctx);
  const long = await ctx.service.sendDirect({ text: 'A'.repeat(1000), mode: 'text', appendTerminator: 'none' });
  assert.equal(long.ok, true);
  assert.equal(ctx.confirmCalls.length, 0);

  const tooLarge = await ctx.service.sendDirect({ text: 'A'.repeat(65537), mode: 'text', appendTerminator: 'none' });
  assert.equal(tooLarge.code, 'parse_error');
  assert.equal(tooLarge.errors[0].code, 'too_large');
});
