// Tests for the application service: the rules in plan section 9.47 are enforced here,
// in the main process, regardless of what the renderer sends.
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
      { name: 'Status', text: 'STATUS[CR]', mode: 'text', appendTerminator: 'none' },
      { name: 'Bad', text: '[NOPE]', mode: 'text', appendTerminator: 'none', kind: 'query' },
    ],
  }],
};

async function setup(t, { confirmAnswers = [], data = DATA } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pw-service-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  if (data) await fsp.writeFile(path.join(dir, 'workbench-commands.json'), JSON.stringify(data));

  const clock = createFakeClock();
  const sockets = [];
  const emitted = [];
  const confirmCalls = [];
  let service;
  const connection = createConnection({
    createSocket: () => { const s = new FakeSocket(); sockets.push(s); return s; },
    scheduler: clock.scheduler,
    now: clock.now,
    onEvent: (event) => service.handleConnectionEvent(event),
  });
  const answers = [...confirmAnswers];
  service = createService({
    connection,
    store: createCommandStore({ fs: fsp, dir, sleep: async () => {} }),
    confirm: async (info) => { confirmCalls.push(info); return answers.length ? answers.shift() : true; },
    emit: (channel, payload) => emitted.push([channel, payload]),
    now: clock.now,
    scheduler: clock.scheduler,
  });
  await service.init();
  return { service, connection, sockets, emitted, confirmCalls, clock, dir };
}

async function connected(ctx) {
  const result = ctx.service.connect({ host: '192.0.2.5', port: 1100 });
  assert.equal(result.ok, true);
  ctx.sockets.at(-1).emit('connect');
  await flush();
}

const writes = (ctx) => ctx.sockets.flatMap((s) => s.written.map((w) => Buffer.from(w).toString('latin1')));

test('init: loads the saved data and reports the load status', async (t) => {
  const ctx = await setup(t);
  const state = ctx.service.getState();
  assert.equal(state.load.status, 'ok');
  assert.equal(state.data.devices[0].name, 'Matrix');
  assert.equal(Object.hasOwn(state, 'readOnly'), false);
  assert.equal(state.connectionState, 'idle');
});

test('init: a missing file gives an empty list and a broken file blocks saving', async (t) => {
  const missing = await setup(t, { data: null });
  assert.equal(missing.service.getState().load.status, 'missing');
  assert.deepEqual((await missing.service.saveData(DATA)).ok, true);

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pw-service-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  await fsp.writeFile(path.join(dir, 'workbench-commands.json'), '{ broken');
  const service = createService({
    connection: createConnection({}),
    store: createCommandStore({ fs: fsp, dir, sleep: async () => {} }),
    confirm: async () => true,
  });
  const state = await service.init();
  assert.equal(state.load.status, 'corrupt');
  assert.equal((await service.saveData(DATA)).code, 'blocked_by_unreadable_file');
  assert.equal(await fsp.readFile(path.join(dir, 'workbench-commands.json'), 'utf8'), '{ broken');
});

test('saveData: the stored copy is the validated one, and invalid data is rejected', async (t) => {
  const ctx = await setup(t);
  const bad = JSON.parse(JSON.stringify(DATA));
  bad.devices[0].port = 0;
  assert.equal((await ctx.service.saveData(bad)).code, 'invalid_data');
  assert.equal(ctx.service.getState().data.devices[0].port, 1100, 'in-memory data unchanged');

  const next = JSON.parse(JSON.stringify(DATA));
  next.devices[0].name = 'Renamed';
  const saved = await ctx.service.saveData(next);
  assert.equal(saved.ok, true);
  assert.equal(ctx.service.getState().data.devices[0].name, 'Renamed');
  assert.equal(ctx.service.getState().data.devices[0].commands[0].expectsReply, true, 'normalized');
});

test('parsePreview: returns bytes as rows, or the parse errors', async (t) => {
  const ctx = await setup(t);
  const ok = ctx.service.parsePreview({ text: 'A[CR]', mode: 'text', appendTerminator: 'none' });
  assert.equal(ok.ok, true);
  assert.equal(ok.length, 2);
  assert.deepEqual(ok.rows[0].cells.map((c) => c.hex), ['41', '0D']);
  const bad = ctx.service.parsePreview({ text: '[X', mode: 'text', appendTerminator: 'none' });
  assert.deepEqual(bad, { ok: false, errors: [{ position: 0, length: 1, code: 'unclosed_bracket' }] });
});

test('sending when not connected is refused before any confirmation', async (t) => {
  const ctx = await setup(t);
  assert.deepEqual(await ctx.service.sendSaved({ device: 'Matrix', command: 'Get power' }), { ok: false, code: 'not_connected' });
  assert.equal(ctx.confirmCalls.length, 0);
});

test('unknown device or command is refused; a non-object reference too', async (t) => {
  const ctx = await setup(t);
  await connected(ctx);
  for (const ref of [{ device: 'Nope', command: 'x' }, { device: 'Matrix', command: 'Nope' }, null, 'Matrix']) {
    assert.deepEqual(await ctx.service.sendSaved(ref), { ok: false, code: 'unknown_command' });
  }
});

test('a saved query is sent at once, with no confirmation dialog', async (t) => {
  const ctx = await setup(t);
  await connected(ctx);
  assert.deepEqual(await ctx.service.sendSaved({ device: 'Matrix', command: 'Get power' }), { ok: true, warnings: [] });
  assert.equal(ctx.confirmCalls.length, 0, 'pressing "Send" is the confirmation');
  assert.deepEqual(writes(ctx), ['GETPWR\r']);
});

test('set-kind and kind-less saved commands are sent at once', async (t) => {
  const ctx = await setup(t);
  await connected(ctx);
  await ctx.service.sendSaved({ device: 'Matrix', command: 'Power on' });
  await ctx.service.sendSaved({ device: 'Matrix', command: 'Status' });
  assert.equal(ctx.confirmCalls.length, 0);
  assert.deepEqual(writes(ctx), ['SETPWR 1\r', 'STATUS\r']);
});

test('a parse error is reported without confirmation or sending', async (t) => {
  const ctx = await setup(t);
  await connected(ctx);
  const result = await ctx.service.sendSaved({ device: 'Matrix', command: 'Bad' });
  assert.equal(result.code, 'parse_error');
  assert.deepEqual(result.errors, [{ position: 0, length: 6, code: 'unknown_name' }]);
  assert.equal(ctx.confirmCalls.length, 0);
});

test('raw input is sent without a confirmation dialog', async (t) => {
  const ctx = await setup(t);
  await connected(ctx);
  const sent = await ctx.service.sendDirect({ text: 'X', mode: 'text', appendTerminator: 'none' });
  assert.equal(sent.ok, true);
  assert.equal(ctx.confirmCalls.length, 0, 'raw input is sent at once too');
});

test('direct input always expects a reply, even if a caller passes expectsReply: false', async (t) => {
  const ctx = await setup(t);
  await connected(ctx);
  await ctx.service.sendDirect({ text: 'X[CR]', mode: 'text', appendTerminator: 'none' });
  await ctx.service.sendDirect({ text: 'Y', mode: 'text', appendTerminator: 'none', expectsReply: false });
  const sends = ctx.connection.getHistory().filter((e) => e.type === 'send');
  assert.deepEqual(sends.map((e) => [e.expectsReply, e.endsWithTerminator]), [[true, true], [true, false]]);
});

// ---- periodic ---------------------------------------------------------------------------

test('periodic: set-kind and kind-less saved commands can both be repeated', async (t) => {
  const ctx = await setup(t);
  await connected(ctx);
  assert.deepEqual(await ctx.service.startPeriodic({ device: 'Matrix', command: 'Power on', intervalMs: 1000 }), { ok: true });
  ctx.clock.advance(1000);
  await flush();
  ctx.service.stopPeriodic();
  assert.deepEqual(await ctx.service.startPeriodic({ device: 'Matrix', command: 'Status', intervalMs: 1000 }), { ok: true });
  ctx.clock.advance(1000);
  await flush();
  ctx.service.stopPeriodic();
  assert.deepEqual(writes(ctx), ['SETPWR 1\r', 'STATUS\r']);
  assert.deepEqual(await ctx.service.startPeriodic({ device: 'Matrix', command: 'Nope', intervalMs: 5000 }), { ok: false, code: 'unknown_command' });
  assert.equal(ctx.service.getState().periodicRunning, false);
  assert.equal(ctx.confirmCalls.length, 0);
});

test('periodic: refused when not connected; starts without a dialog and sends on each tick', async (t) => {
  const ctx = await setup(t);
  assert.deepEqual(await ctx.service.startPeriodic({ device: 'Matrix', command: 'Get power', intervalMs: 5000 }), { ok: false, code: 'not_connected' });
  await connected(ctx);
  assert.deepEqual(await ctx.service.startPeriodic({ device: 'Matrix', command: 'Get power', intervalMs: 5000 }), { ok: true });
  assert.equal(ctx.confirmCalls.length, 0);

  ctx.clock.advance(5000);
  await flush();
  assert.deepEqual(writes(ctx), ['GETPWR\r']);
});

test('periodic: stops when the connection ends, on disconnect and on shutdown', async (t) => {
  for (const [name, action] of [
    ['connection ended', (ctx) => { ctx.sockets[0].emit('end'); ctx.sockets[0].emit('close', false); }],
    ['disconnect', (ctx) => ctx.service.disconnect()],
    ['shutdown', (ctx) => ctx.service.shutdown()],
  ]) {
    const ctx = await setup(t);
    await connected(ctx);
    await ctx.service.startPeriodic({ device: 'Matrix', command: 'Get power', intervalMs: 1000 });
    assert.equal(ctx.service.getState().periodicRunning, true, name);
    action(ctx);
    await flush();
    assert.equal(ctx.service.getState().periodicRunning, false, `stopped on ${name}`);
    const stopped = ctx.emitted.filter(([channel]) => channel === 'periodic').at(-1)[1];
    assert.equal(stopped.running, false);
  }
});

test('periodic: changing saved data later does not alter a running timer snapshot', async (t) => {
  const ctx = await setup(t);
  await connected(ctx);
  await ctx.service.startPeriodic({ device: 'Matrix', command: 'Get power', intervalMs: 1000 });
  const next = JSON.parse(JSON.stringify(DATA));
  next.devices[0].commands[0].text = 'CHANGED[CR]';
  await ctx.service.saveData(next);
  ctx.clock.advance(1000);
  await flush();
  assert.deepEqual(writes(ctx), ['GETPWR\r'], 'the snapshot taken at start keeps its original text');
});

// ---- events and hints -------------------------------------------------------------------

test('connection events are forwarded to the renderer channel', async (t) => {
  const ctx = await setup(t);
  await connected(ctx);
  ctx.sockets[0].emit('data', Buffer.from('OK\r'));
  const forwarded = ctx.emitted.filter(([channel]) => channel === 'event').map(([, e]) => e);
  assert.deepEqual(forwarded.map((e) => e.type === 'state' ? `state:${e.state}` : e.type), ['state:connecting', 'state:connected', 'connect_ok', 'recv']);
  assert.deepEqual(Array.from(forwarded.at(-1).bytes), [0x4f, 0x4b, 0x0d]);
});

test('log: a send and a receive are pushed as ready-to-display entries', async (t) => {
  const ctx = await setup(t);
  await connected(ctx);
  ctx.clock.advance(7);
  await ctx.service.sendSaved({ device: 'Matrix', command: 'Get power' });
  ctx.sockets[0].emit('data', Buffer.from('OK\r\n'));
  const logs = ctx.emitted.filter(([c]) => c === 'log').map(([, p]) => p);
  assert.equal(logs.length, 2);

  assert.deepEqual({ dir: logs[0].dir, t: logs[0].t, length: logs[0].length }, { dir: 'tx', t: 7, length: 7 });
  assert.deepEqual(logs[0].rows[0].cells.map((c) => c.hex), ['47', '45', '54', '50', '57', '52', '0D']);
  assert.equal(logs[0].text, 'GETPWR\r');

  assert.deepEqual({ dir: logs[1].dir, length: logs[1].length, text: logs[1].text }, { dir: 'rx', length: 4, text: 'OK\r\n' });
  assert.deepEqual(logs[1].rows[0].cells.map((c) => c.kind), ['printable', 'printable', 'cr', 'lf']);
});

test('log: UTF-8 split across two chunks is decoded correctly, and the decoder restarts on reconnect', async (t) => {
  const ctx = await setup(t);
  await connected(ctx);
  const euro = Buffer.from('€'); // 3 bytes
  ctx.sockets[0].emit('data', euro.subarray(0, 2));
  ctx.sockets[0].emit('data', euro.subarray(2));
  const texts = ctx.emitted.filter(([c]) => c === 'log').map(([, p]) => p.text);
  assert.deepEqual(texts, ['', '€']);

  // A half character left over must not leak into the next connection.
  ctx.sockets[0].emit('data', Buffer.from([0xe2, 0x82]));
  ctx.sockets[0].emit('close', false);
  await flush();
  await connected(ctx);
  ctx.sockets[1].emit('data', Buffer.from('A'));
  const last = ctx.emitted.filter(([c]) => c === 'log').at(-1)[1];
  assert.equal(last.text, 'A');
});

test('hints: "no reply" appears after the wait time and is emitted once', async (t) => {
  const ctx = await setup(t);
  await connected(ctx);
  await ctx.service.sendSaved({ device: 'Matrix', command: 'Get power' });
  ctx.clock.advance(2000);
  assert.equal(ctx.emitted.filter(([c]) => c === 'hints').at(-1)[1].hints.length, 0);
  ctx.clock.advance(1000);
  const hints = ctx.emitted.filter(([c]) => c === 'hints').at(-1)[1].hints;
  assert.deepEqual(hints.map((h) => h.id), ['no_reply']);

  const count = ctx.emitted.filter(([c]) => c === 'hints').length;
  ctx.clock.advance(3000);
  assert.equal(ctx.emitted.filter(([c]) => c === 'hints').length, count, 'unchanged hints are not re-emitted');
});

test('hints: a connect failure produces a hint and stops the hint timer', async (t) => {
  const ctx = await setup(t);
  ctx.service.connect({ host: '192.0.2.5', port: 1100 });
  ctx.sockets[0].emit('error', Object.assign(new Error('x'), { code: 'ECONNREFUSED' }));
  await flush();
  const hints = ctx.emitted.filter(([c]) => c === 'hints').at(-1)[1].hints.map((h) => h.id);
  assert.deepEqual(hints, ['connect_refused', 'maybe_booting']);
  assert.equal(ctx.clock.pendingTimers(), 0, 'no timers are left running');
});

test('hints: a user disconnect gives no hints', async (t) => {
  const ctx = await setup(t);
  await connected(ctx);
  ctx.service.disconnect();
  await flush();
  const last = ctx.emitted.filter(([c]) => c === 'hints').at(-1)[1].hints;
  assert.deepEqual(last, []);
  assert.equal(ctx.clock.pendingTimers(), 0);
});

test('shutdown leaves no timers and closes the connection', async (t) => {
  const ctx = await setup(t);
  await connected(ctx);
  await ctx.service.startPeriodic({ device: 'Matrix', command: 'Get power', intervalMs: 1000 });
  ctx.service.shutdown();
  await flush();
  ctx.clock.advance(5000); // let the close-grace timer finish too
  await flush();
  assert.equal(ctx.clock.pendingTimers(), 0);
  assert.equal(ctx.connection.getState(), 'closed');
});


test('a large TCP chunk is drawn only in part with its real size, and a split character still decodes', async (t) => {
  const ctx = await setup(t);
  await connected(ctx);
  ctx.sockets[0].emit('data', Buffer.alloc(60000, 0x41));
  const entry = ctx.emitted.filter(([c, p]) => c === 'log' && p.dir === 'rx')[0][1];
  assert.equal(entry.length, 60000);
  assert.equal(entry.shown, 4096);
  assert.equal(entry.rows.reduce((n, row) => n + row.cells.length, 0), 4096, 'the screen gets only what it can show');
  // The decoder saw the whole chunk: the next chunk's first byte completes a split character.
  const euro = Buffer.from('€');
  ctx.sockets[0].emit('data', Buffer.concat([Buffer.from('x'), euro.subarray(0, 2)]));
  ctx.sockets[0].emit('data', euro.subarray(2));
  const texts = ctx.emitted.filter(([c, p]) => c === 'log' && p.dir === 'rx').map(([, p]) => p.text);
  assert.equal(texts.at(-1), '€');
});
