// Tests for the device-role application service: the main-process side that the page talks to.
// The page is untrusted: it never passes file paths or definitions, only asks the main process to
// load one (through a native file dialog or the bundled samples) and to start/stop the server.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createDeviceService } = require('../../src/main/device-service');
const { createDeviceServer } = require('../../src/main/device-server');
const { bundledSampleStore } = require('../helpers/sample-store');
const { createFakeClock, flush } = require('../helpers/fakes');
const { FakeServer } = require('../helpers/fake-server');

const SAMPLES = path.join(__dirname, '..', '..', 'src', 'samples');
const CR = 0x0d;
const withCr = (text) => Uint8Array.from([...Buffer.from(text, 'utf8'), CR]);

function setup({ limits = {}, confirmAnswers = [], fileResult = null } = {}) {
  const clock = createFakeClock();
  const emitted = [];
  const confirmCalls = [];
  const answers = [...confirmAnswers];
  let fake;
  let service;
  const server = createDeviceServer({
    createServer: (handler) => { fake = new FakeServer(handler); return fake; },
    scheduler: clock.scheduler,
    now: clock.now,
    onEvent: (event) => service.handleServerEvent(event),
  });
  service = createDeviceService({
    server,
    chooseFile: async () => fileResult ?? { ok: false, code: 'cancelled' },
    sampleStore: bundledSampleStore(),
    confirm: async (info) => { confirmCalls.push(info); return answers.length ? answers.shift() : true; },
    emit: (channel, payload) => emitted.push([channel, payload]),
    now: clock.now,
    scheduler: clock.scheduler,
    limits,
  });
  const channel = (name) => emitted.filter(([c]) => c === name).map(([, p]) => p);
  return { service, server, clock, emitted, confirmCalls, channel, fake: () => fake };
}

const validText = () => fs.readFileSync(path.join(SAMPLES, 'matrix-switch.json'), 'utf8');

test('initial state: no definition, not running; the sample list is filled by a scan', async () => {
  const ctx = setup();
  const state = ctx.service.getState();
  assert.equal(state.definition, null);
  assert.equal(state.server.running, false);
  assert.deepEqual(state.samples.items, [], 'nothing before the first scan');
  const scanned = await ctx.service.refreshSamples();
  assert.equal(scanned.ok, true);
  const after = ctx.service.getState().samples;
  assert.equal(after.source, 'builtin');
  assert.equal(after.dir, null, 'the page is not told the path of the bundled samples');
  assert.deepEqual(after.items.map((s) => s.id), ['matrix-switch.json', 'quirky-player.json', 'udp-unit.json']);
  assert.ok(after.items.every((s) => s.ok === true && typeof s.name === 'string'));
  assert.ok(ctx.channel('deviceState').length >= 1, 'the new list is pushed to the page');
});

test('loadSample: loads a bundled sample and describes it', async () => {
  const ctx = setup();
  const result = await ctx.service.loadSample('matrix-switch.json');
  assert.equal(result.ok, true);
  const info = result.info;
  assert.deepEqual({ name: info.name, source: info.source, fileName: info.fileName, terminator: info.terminator }, { name: 'Sample matrix switch', source: 'sample', fileName: 'matrix-switch.json', terminator: 'cr' });
  assert.equal(info.connection.idleTimeoutMs, 60000);
  assert.equal(info.hasGreeting, true);
  const power = info.variables.find((v) => v.name === 'power');
  assert.deepEqual(power, { name: 'power', type: 'enum', initial: 'standby', values: ['standby', 'on'] });
  assert.deepEqual(info.variables.find((v) => v.name === 'out1'), { name: 'out1', type: 'int', initial: 1, min: 1, max: 4 });
  assert.ok(info.patterns.includes('PWR {state}'));
  assert.equal(info.commandCount, info.patterns.length);
  assert.equal(info.notificationCount, 1);
  assert.deepEqual(ctx.service.getState().definition, info);
});

test('loadSample: only ids that the scan contains are accepted (no path tricks)', async () => {
  const ctx = setup();
  for (const id of ['nope.json', '../package.json', '..\\x.json', 'matrix-switch', '', null, 5, {}]) {
    assert.deepEqual(await ctx.service.loadSample(id), { ok: false, code: 'unknown_sample' }, String(id));
  }
  assert.equal(ctx.service.getState().definition, null);
});

test('loadSample: a sample that cannot be read is reported', async () => {
  const ctx = setup();
  const broken = createDeviceService({
    server: ctx.server,
    chooseFile: async () => ({ ok: false, code: 'cancelled' }),
    sampleStore: { list: async () => ({ ok: true, source: 'builtin', dir: '', items: [{ id: 'matrix-switch.json', name: 'M', ok: true }], omitted: 0 }), read: async () => ({ ok: false, code: 'ENOENT' }) },
    confirm: async () => true,
  });
  assert.deepEqual(await broken.loadSample('matrix-switch.json'), { ok: false, code: 'read_failed', errno: 'ENOENT' });
});

test('loadFile: a chosen file is parsed; the page never sees the path, only the file name', async () => {
  const ctx = setup({ fileResult: { ok: true, fileName: 'my-device.json', text: validText() } });
  const result = await ctx.service.loadFile();
  assert.equal(result.ok, true);
  assert.deepEqual({ source: result.info.source, fileName: result.info.fileName }, { source: 'file', fileName: 'my-device.json' });
});

test('loadFile: cancelling, read errors and oversized files are passed through', async () => {
  for (const fileResult of [{ ok: false, code: 'cancelled' }, { ok: false, code: 'read_failed', errno: 'EACCES' }, { ok: false, code: 'file_too_large' }]) {
    const ctx = setup({ fileResult });
    assert.deepEqual(await ctx.service.loadFile(), fileResult);
    assert.equal(ctx.service.getState().definition, null);
  }
});

test('loadFile: an invalid definition returns every error with its JSON Pointer and keeps the previous definition', async () => {
  const ctx = setup();
  await ctx.service.loadSample('matrix-switch.json');
  const broken = JSON.parse(validText());
  broken.commands[0].bogus = 1;
  broken.connection.maxConnections = 99;
  const bad = setup({ fileResult: { ok: true, fileName: 'bad.json', text: JSON.stringify(broken) } });
  const result = await bad.service.loadFile();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid_definition');
  assert.equal(result.fileName, 'bad.json');
  assert.deepEqual(result.errors.map((e) => `${e.pointer}:${e.code}`).sort(), ['/commands/0:unknown_field', '/connection/maxConnections:invalid_value']);
  assert.equal(bad.service.getState().definition, null);

  const ctx2 = setup({ fileResult: { ok: true, fileName: 'x.json', text: '{ broken' } });
  await ctx2.service.loadSample('matrix-switch.json');
  const r2 = await ctx2.service.loadFile();
  assert.equal(r2.code, 'invalid_definition');
  assert.equal(ctx2.service.getState().definition.name, 'Sample matrix switch', 'the previous definition stays loaded');
});

test('the error list sent to the page is capped', async () => {
  const many = JSON.parse(validText());
  for (let i = 0; i < 300; i += 1) many.commands.push({ pattern: '{a}{b}', reply: null });
  const ctx = setup({ fileResult: { ok: true, fileName: 'many.json', text: JSON.stringify(many) } });
  const result = await ctx.service.loadFile();
  assert.equal(result.ok, false);
  assert.ok(result.errors.length <= 50, `at most 50 errors are sent (got ${result.errors.length})`);
  assert.ok(result.totalErrors >= 300);
});

test('start needs a definition', async () => {
  const ctx = setup();
  assert.deepEqual(await ctx.service.start({ host: '127.0.0.1', port: 0 }), { ok: false, code: 'no_definition' });
});

test('start on 127.0.0.1 needs no dialog and reports the port; the definition cannot be replaced while running', async () => {
  const ctx = setup();
  await ctx.service.loadSample('matrix-switch.json');
  const result = await ctx.service.start({ host: '127.0.0.1', port: 0 });
  assert.equal(result.ok, true);
  assert.equal(ctx.confirmCalls.length, 0);
  assert.equal(ctx.service.getState().server.running, true);
  assert.deepEqual(await ctx.service.loadSample('quirky-player.json'), { ok: false, code: 'running' });
  assert.deepEqual(await ctx.service.loadFile(), { ok: false, code: 'running' });
});

test('start on all interfaces asks for a native confirmation first; declining does not start', async () => {
  const ctx = setup({ confirmAnswers: [false, true] });
  await ctx.service.loadSample('matrix-switch.json');
  assert.deepEqual(await ctx.service.start({ host: '0.0.0.0', port: 0 }), { ok: false, code: 'cancelled' });
  assert.equal(ctx.fake(), undefined, 'nothing was started');
  assert.deepEqual(ctx.confirmCalls[0].reasons, ['bind_all']);

  const result = await ctx.service.start({ host: '0.0.0.0', port: 0 });
  assert.equal(result.ok, true);
  assert.equal(ctx.service.getState().server.lan, true);
});

test('a second confirmation cannot open while one is pending', async () => {
  const ctx = setup();
  await ctx.service.loadSample('matrix-switch.json');
  let release;
  const slow = createDeviceService({
    server: ctx.server,
    chooseFile: async () => ({ ok: false, code: 'cancelled' }),
    sampleStore: bundledSampleStore(),
    confirm: () => new Promise((resolve) => { release = resolve; }),
  });
  await slow.loadSample('matrix-switch.json');
  const first = slow.start({ host: '0.0.0.0', port: 0 });
  await flush();
  assert.deepEqual(await slow.start({ host: '0.0.0.0', port: 0 }), { ok: false, code: 'busy' });
  release(false);
  assert.deepEqual(await first, { ok: false, code: 'cancelled' });
});

test('start: the arguments are validated again here (the page is untrusted)', async () => {
  const ctx = setup();
  await ctx.service.loadSample('matrix-switch.json');
  for (const bad of [null, {}, { host: 'localhost', port: 0 }, { host: '192.0.2.1', port: 0 }, { host: '127.0.0.1', port: -1 }, { host: '127.0.0.1', port: 70000 }, { host: '127.0.0.1', port: '80' }]) {
    const result = await ctx.service.start(bad);
    assert.equal(result.ok, false, JSON.stringify(bad));
    assert.ok(['invalid_host', 'invalid_port', 'invalid_arguments'].includes(result.code), `${JSON.stringify(bad)} -> ${result.code}`);
  }
  assert.equal(ctx.fake(), undefined);
});

test('stop: stops the server, and the definition can be replaced again', async () => {
  const ctx = setup();
  await ctx.service.loadSample('matrix-switch.json');
  await ctx.service.start({ host: '127.0.0.1', port: 0 });
  assert.deepEqual(await ctx.service.stop(), { ok: true });
  assert.equal(ctx.service.getState().server.running, false);
  assert.equal((await ctx.service.loadSample('quirky-player.json')).ok, true);
});

test('traffic is pushed to the page as ready-to-display log entries (hex cells and text)', async () => {
  const ctx = setup();
  await ctx.service.loadSample('matrix-switch.json');
  await ctx.service.start({ host: '127.0.0.1', port: 0 });
  const socket = ctx.fake().accept();
  await flush();
  socket.emit('data', Buffer.from(withCr('PWR?')));
  await flush();

  const logs = ctx.channel('deviceLog');
  const tx = logs.find((l) => l.dir === 'tx');
  assert.equal(tx.text, `SAMPLE MATRIX READY${String.fromCharCode(13)}`);
  const rx = logs.find((l) => l.dir === 'rx');
  assert.deepEqual({ dir: rx.dir, length: rx.length, text: rx.text, outcome: rx.outcome }, { dir: 'rx', length: 4, text: 'PWR?', outcome: 'matched' });
  assert.deepEqual(rx.rows[0].cells.map((c) => c.hex), ['50', '57', '52', '3F']);
  assert.ok(logs.every((l) => l.bytes === undefined), 'raw bytes are not sent to the page');
});

test('lifecycle and variable changes are pushed as events and as a fresh state', async () => {
  const ctx = setup();
  await ctx.service.loadSample('matrix-switch.json');
  await ctx.service.start({ host: '127.0.0.1', port: 0 });
  const socket = ctx.fake().accept();
  await flush();
  socket.emit('data', Buffer.from(withCr('PWR 1')));
  await flush();

  const types = ctx.channel('deviceEvent').map((e) => e.type);
  for (const expected of ['listening', 'connection_opened', 'variables']) assert.ok(types.includes(expected), expected);
  // Event-driven pushes are spaced out; the next one-second tick delivers the latest state.
  ctx.clock.advance(1000);
  const states = ctx.channel('deviceState');
  assert.equal(states.at(-1).variables.power, 'on');
  assert.equal(states.at(-1).connections.length, 1);
});

test('the state is refreshed every second while running, and the timer stops with the server', async () => {
  const ctx = setup();
  await ctx.service.loadSample('matrix-switch.json');
  await ctx.service.start({ host: '127.0.0.1', port: 0 });
  const before = ctx.channel('deviceState').length;
  ctx.clock.advance(3000);
  assert.equal(ctx.channel('deviceState').length, before + 3);
  await ctx.service.stop();
  const after = ctx.channel('deviceState').length;
  ctx.clock.advance(5000);
  assert.equal(ctx.channel('deviceState').length, after, 'no more refreshes after stop');
  assert.equal(ctx.clock.pendingTimers(), 0);
});

test('faults are passed to the server and validated there', async () => {
  const ctx = setup();
  assert.deepEqual(await ctx.service.setFault({ muted: true }), { ok: false, code: 'not_running' });
  await ctx.service.loadSample('matrix-switch.json');
  await ctx.service.start({ host: '127.0.0.1', port: 0 });
  assert.equal((await ctx.service.setFault({ dropNextReplies: 2 })).ok, true);
  assert.deepEqual(await ctx.service.setFault({ extraDelayMs: -5 }), { ok: false, code: 'invalid_arguments' });
  ctx.fake().accept();
  assert.equal((await ctx.service.closeAll()).closed, 1);
});

test('events pushed to the page are limited per second, and the omission is reported', async () => {
  const ctx = setup({ limits: { logEventsPerSecond: 3 } });
  await ctx.service.loadSample('matrix-switch.json');
  await ctx.service.start({ host: '127.0.0.1', port: 0 });
  const socket = ctx.fake().accept();
  await flush();
  const base = ctx.channel('deviceLog').length;
  for (let i = 0; i < 10; i += 1) socket.emit('data', Buffer.from(withCr('VER?')));
  await flush();
  assert.ok(ctx.channel('deviceLog').length - base <= 3, 'at most 3 log entries per second reach the page');

  ctx.clock.advance(1000);
  const omitted = ctx.channel('deviceEvent').filter((e) => e.type === 'omitted');
  assert.equal(omitted.length, 1);
  assert.ok(omitted[0].count >= 7);
});

test('shutdown stops the server and every timer', async () => {
  const ctx = setup();
  await ctx.service.loadSample('quirky-player.json');
  await ctx.service.start({ host: '127.0.0.1', port: 0 });
  ctx.fake().accept();
  await ctx.service.shutdown();
  assert.equal(ctx.service.getState().server.running, false);
  assert.equal(ctx.clock.pendingTimers(), 0);
});

test('samples: a listed but unusable file is shown with its reason and cannot be loaded', async () => {
  const ctx = setup();
  const store = {
    list: async () => ({
      ok: true, source: 'folder', dir: 'C:/app/samples', omitted: 2,
      items: [{ id: 'good.json', name: 'Good', ok: true }, { id: 'bad.json', name: 'bad.json', ok: false, reason: 'invalid_json' }],
    }),
    read: async (id) => (id === 'bad.json' ? { ok: false, code: 'sample_unreadable', reason: 'invalid_json' } : { ok: false, code: 'unknown_sample' }),
  };
  const service = createDeviceService({
    server: createDeviceServer({ createServer: (h) => new FakeServer(h) }),
    chooseFile: async () => ({ ok: false, code: 'cancelled' }),
    sampleStore: store,
    confirm: async () => true,
    emit: () => {},
  });
  await service.refreshSamples();
  const view = service.getState().samples;
  assert.equal(view.source, 'folder');
  assert.equal(view.dir, 'C:/app/samples');
  assert.equal(view.omitted, 2);
  assert.deepEqual(view.items.map((i) => [i.id, i.ok, i.reason]), [['good.json', true, undefined], ['bad.json', false, 'invalid_json']]);
  assert.deepEqual(await service.loadSample('bad.json'), { ok: false, code: 'sample_unreadable', reason: 'invalid_json' });
  assert.ok(ctx);
});

function serviceWithStore(store, extra = {}) {
  return createDeviceService({
    server: createDeviceServer({ createServer: (h) => new FakeServer(h) }),
    chooseFile: async () => ({ ok: false, code: 'cancelled' }),
    sampleStore: store,
    confirm: async () => true,
    emit: () => {},
    ...extra,
  });
}

test('samples: scans run one at a time, are not repeated at once, and a failed scan is reported', async () => {
  let t = 0;
  const resolvers = [];
  const store = {
    list: () => new Promise((resolve) => { resolvers.push(resolve); }),
    read: async () => ({ ok: false, code: 'unknown_sample' }),
  };
  const service = serviceWithStore(store, { now: () => t });
  const first = service.refreshSamples();
  const second = service.refreshSamples();
  assert.equal(resolvers.length, 1, 'a second request while one runs does not start another scan');
  resolvers[0]({ ok: true, source: 'folder', dir: 'D', items: [{ id: 'a.json', name: 'A', ok: true }], omitted: 0 });
  assert.deepEqual((await first).samples.items.map((i) => i.id), ['a.json']);
  assert.deepEqual((await second).samples.items.map((i) => i.id), ['a.json']);

  t = 100;
  await service.refreshSamples();
  assert.equal(resolvers.length, 1, 'just scanned: the last result is returned');

  t = 1000;
  const third = service.refreshSamples();
  resolvers[1]({ ok: false, source: 'folder', dir: 'D', code: 'EACCES', items: [], omitted: 0 });
  assert.equal((await third).ok, false);
  assert.equal(service.getState().samples.error, 'EACCES');
});

test('definition loads: start is refused while one is on its way, and only the newest load is applied', async () => {
  const gates = [];
  const text = (name) => JSON.stringify({ schemaVersion: 1, name, commands: [{ pattern: 'A', reply: 'B[CR]' }], framing: { terminator: 'cr' } });
  const store = {
    list: async () => ({ ok: true, source: 'builtin', dir: '', items: [], omitted: 0 }),
    read: (id) => new Promise((resolve) => { gates.push(() => resolve({ ok: true, text: text(id), fileName: id })); }),
  };
  const service = serviceWithStore(store);
  const slow = service.loadSample('slow.json');
  const fast = service.loadSample('fast.json');
  assert.deepEqual(await service.start({ host: '127.0.0.1', port: 0 }), { ok: false, code: 'busy' });
  gates[1]();
  assert.equal((await fast).ok, true);
  gates[0]();
  assert.deepEqual(await slow, { ok: false, code: 'busy' }, 'the older request is dropped');
  assert.equal(service.getState().definition.name, 'fast.json');
});
