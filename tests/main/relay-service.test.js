// Relay service: rules in the main process, with a fake relay, a real recorder and fake dialogs.
const test = require('node:test');
const assert = require('node:assert/strict');

const { createRelayService } = require('../../src/main/relay-service');
const { createRecorder, serializeRecording, parseRecordingText } = require('../../src/core/recording');
const { isValidatedDefinition, validateDefinition } = require('../../src/core/device-definition');
const { createFakeClock } = require('../helpers/fakes');

const enc = (text) => Uint8Array.from(Buffer.from(text, 'latin1'));

function setup({ relayStart, loadResult, saveResult, deviceResult, saveGate, loadGate, limits } = {}) {
  const clock = createFakeClock();
  const emitted = [];
  const confirmCalls = [];
  const saved = [];
  const handed = [];
  const startCalls = [];
  let running = false;
  let confirmAnswer = true;
  const recorder = createRecorder({ now: clock.now });
  const relay = {
    start: relayStart ?? (async (options, hooks) => {
      startCalls.push(options);
      if (options.listenHost === '0.0.0.0' && !(await hooks.beforeListen({ upstreamAddress: '10.0.0.20', upstreamPort: options.upstreamPort }))) {
        return { ok: false, code: 'cancelled' };
      }
      running = true;
      return { ok: true, host: options.listenHost, port: 6000 };
    }),
    stop: async () => { running = false; return { ok: true }; },
    getState: () => ({ running, connections: [] }),
  };
  const deviceService = { loadDraft: (definition, meta) => { handed.push([definition, meta]); return deviceResult ?? { ok: true, info: {} }; } };
  const service = createRelayService({
    relay,
    recorder,
    deviceService,
    saveText: async (request) => {
      if (saveGate) await saveGate;
      const text = request.makeText();
      if (typeof text !== 'string') return { ok: false, code: 'empty' };
      saved.push({ kind: request.kind, text });
      return saveResult ?? { ok: true, fileName: 'out.json' };
    },
    loadText: async () => {
      if (loadGate) await loadGate;
      return loadResult ?? { ok: false, code: 'cancelled' };
    },
    confirm: async (info) => { confirmCalls.push(info); return confirmAnswer; },
    emit: (channel, payload) => emitted.push([channel, payload]),
    now: clock.now,
    scheduler: clock.scheduler,
    limits,
  });
  const channel = (name) => emitted.filter(([c]) => c === name).map(([, p]) => p);
  return {
    service, recorder, clock, emitted, channel, confirmCalls, saved, handed, startCalls, setAnswer: (v) => { confirmAnswer = v; },
  };
}

const START = { listenHost: '127.0.0.1', listenPort: 0, upstreamHost: '10.0.0.20', upstreamPort: 5000 };

// One connection with stop-and-wait traffic: ID? twice (same reply), MUTE 1 silent.
function record(ctx, sessions = 2) {
  for (let s = 0; s < sessions; s += 1) {
    const id = ctx.recorder.openConnection();
    ctx.clock.advance(10);
    ctx.recorder.addChunk(id, 'down', enc('READY\r'));
    for (const [request, reply] of [['ID?', 'ID A1\r'], ['MUTE 1', null], ['ID?', 'ID A1\r']]) {
      ctx.clock.advance(1000);
      ctx.recorder.addChunk(id, 'up', enc(`${request}\r`));
      if (reply) { ctx.clock.advance(20); ctx.recorder.addChunk(id, 'down', enc(reply)); }
    }
    ctx.recorder.closeConnection(id, 'client_closed');
  }
}

test('start validates the arguments again and passes only known fields', async () => {
  const ctx = setup();
  for (const bad of [null, 5, { ...START, listenHost: 'localhost' }, { ...START, listenPort: 80 }, { ...START, listenPort: '6000' }]) {
    const result = await ctx.service.start(bad);
    assert.equal(result.ok, false);
    assert.match(result.code, /invalid_/);
  }
  assert.equal(ctx.startCalls.length, 0);
  assert.equal((await ctx.service.start({ ...START, extra: 'ignored', __proto__: { x: 1 } })).ok, true);
  assert.deepEqual(Object.keys(ctx.startCalls[0]).sort(), ['listenHost', 'listenPort', 'upstreamHost', 'upstreamPort']);
});

test('listening on all interfaces asks natively and names the real target', async () => {
  const ctx = setup();
  const result = await ctx.service.start({ ...START, listenHost: '0.0.0.0' });
  assert.equal(result.ok, true);
  assert.deepEqual(ctx.confirmCalls, [{ reasons: ['relay_bind_all'], items: null, target: '10.0.0.20:5000' }]);

  const refused = setup();
  refused.setAnswer(false);
  assert.deepEqual(await refused.service.start({ ...START, listenHost: '0.0.0.0' }), { ok: false, code: 'cancelled' });
  assert.equal(refused.service.getState().relay.running, false);

  // Only a literal `true` counts as consent.
  const odd = setup();
  odd.setAnswer('yes');
  assert.equal((await odd.service.start({ ...START, listenHost: '0.0.0.0' })).code, 'cancelled');

  const loopback = setup();
  await loopback.service.start(START);
  assert.equal(loopback.confirmCalls.length, 0);

  const v6 = setup({ relayStart: async (o, hooks) => ({ ok: await hooks.beforeListen({ upstreamAddress: 'fd00::1', upstreamPort: 80 }) }) });
  await v6.service.start({ ...START, listenHost: '0.0.0.0' });
  assert.equal(v6.confirmCalls[0].target, '[fd00::1]:80');
});

test('state pushes and the tick timer follow the relay', async () => {
  const ctx = setup();
  await ctx.service.start(START);
  assert.equal(ctx.channel('relayState').length, 1);
  assert.equal(ctx.clock.pendingTimers(), 1);
  ctx.clock.advance(3000);
  assert.equal(ctx.channel('relayState').length, 4);
  await ctx.service.stop();
  assert.equal(ctx.clock.pendingTimers(), 0);
  // A relay that stops by itself also stops the timer.
  await ctx.service.start(START);
  ctx.service.handleRelayEvent({ type: 'stopped', t: 0 });
  assert.equal(ctx.clock.pendingTimers(), 0);
});

test('the screen log is rate limited, bounded, and carries no raw bytes object', async () => {
  const ctx = setup();
  await ctx.service.start(START);
  const big = new Uint8Array(5000).fill(0x41);
  for (let i = 0; i < 300; i += 1) ctx.service.handleRelayEvent({ type: 'data', t: 1, connectionId: 1, dir: 'up', bytes: i === 0 ? big : enc('X') });
  const logs = ctx.channel('relayLog');
  assert.equal(logs.length, 200);
  assert.equal(logs[0].length, 5000);
  assert.equal(logs[0].truncated, true);
  assert.equal(logs[0].text.length, 1024);
  assert.equal(logs[1].truncated, false);
  assert.ok(Array.isArray(logs[0].rows));
  assert.equal('bytes' in logs[0], false);
  ctx.clock.advance(1000);
  assert.deepEqual(ctx.channel('relayEvent').filter((e) => e.type === 'omitted'), [{ type: 'omitted', count: 100 }]);
});

test('small events pass through without payload bytes; peer-driven ones are limited', async () => {
  const ctx = setup();
  ctx.service.handleRelayEvent({ type: 'connection_opened', connectionId: 1, remote: 'x', bytes: new Uint8Array(3) });
  assert.equal('bytes' in ctx.channel('relayEvent')[0], false);
  for (let i = 0; i < 300; i += 1) ctx.service.handleRelayEvent({ type: 'refused', reason: 'rate_limit' });
  assert.ok(ctx.channel('relayEvent').filter((e) => e.type === 'refused').length <= 200);
});

test('clearing the recording drops a draft made from it, not one from a loaded file', async () => {
  const ctx = setup();
  record(ctx);
  assert.equal(ctx.service.draft({ source: 'live' }).ok, true);
  assert.notEqual(ctx.service.getState().draft, null);
  ctx.service.clearRecording();
  assert.equal(ctx.service.getState().draft, null);
  assert.equal(ctx.service.getState().recording.events, 0);
});

test('saving: nothing to save is refused; the saved text is a valid recording without identifying fields', async () => {
  const ctx = setup();
  assert.deepEqual(await ctx.service.saveRecording(), { ok: false, code: 'empty' });
  assert.equal(ctx.saved.length, 0);
  record(ctx, 1);
  assert.deepEqual(await ctx.service.saveRecording(), { ok: true, fileName: 'out.json' });
  assert.equal(ctx.saved[0].kind, 'recording');
  const parsed = parseRecordingText(ctx.saved[0].text);
  assert.equal(parsed.ok, true);
  const keys = Object.keys(JSON.parse(ctx.saved[0].text));
  for (const identifying of ['name', 'startedAt', 'target']) assert.equal(keys.includes(identifying), false, identifying);

  const failing = setup({ saveResult: { ok: false, code: 'cancelled' } });
  record(failing, 1);
  assert.deepEqual(await failing.service.saveRecording(), { ok: false, code: 'cancelled' });
});

test('loading: dialog failures pass through; a bad file is described with a bounded error list', async () => {
  assert.deepEqual(await setup().service.loadRecording(), { ok: false, code: 'cancelled' });

  const bad = setup({ loadResult: { ok: true, fileName: 'bad.json', text: '{"schemaVersion":1,"connections":[],"events":[{"x":1}],"extra":true}' } });
  const result = await bad.service.loadRecording();
  assert.equal(result.code, 'invalid_recording');
  assert.equal(result.fileName, 'bad.json');
  assert.ok(result.errors.length >= 1 && result.errors.length <= 50);
  assert.equal(bad.service.getState().loaded, null);

  const notJson = setup({ loadResult: { ok: true, fileName: 'x.json', text: 'not json' } });
  assert.equal((await notJson.service.loadRecording()).code, 'invalid_recording');

  const source = setup();
  record(source, 1);
  const text = serializeRecording(source.recorder.snapshot());
  const good = setup({ loadResult: { ok: true, fileName: 'rec.json', text } });
  const loaded = await good.service.loadRecording();
  assert.equal(loaded.ok, true);
  assert.equal(loaded.summary.connections, 1);
  assert.equal(good.service.getState().loaded.fileName, 'rec.json');
});

test('draft: arguments are checked, sources are separate, the summary has no definition', async () => {
  const ctx = setup();
  for (const bad of [null, {}, { source: 'x' }, { source: 'live', terminator: 'tab' }, { source: 'live', quietMs: -1 }, { source: 'live', quietMs: 1.5 }]) {
    assert.deepEqual(ctx.service.draft(bad), { ok: false, code: 'invalid_arguments' });
  }
  assert.deepEqual(ctx.service.draft({ source: 'live' }), { ok: false, code: 'empty' });
  assert.deepEqual(ctx.service.draft({ source: 'loaded' }), { ok: false, code: 'no_recording' });

  record(ctx);
  const result = ctx.service.draft({ source: 'live', terminator: 'cr', quietMs: 250 });
  assert.equal(result.ok, true);
  const { draft } = result;
  assert.deepEqual(draft.info.patterns.sort(), ['ID?', 'MUTE 1']);
  assert.equal(draft.info.hasGreeting, true);
  assert.equal(draft.replay.failed, 0);
  assert.equal(draft.holdout.evaluable, true);
  assert.ok(draft.homework.some((h) => h.code === 'no_variables'));
  const serialized = JSON.stringify(draft);
  assert.equal(serialized.includes('schemaVersion'), false, 'the page never receives the definition itself');
  assert.equal(ctx.service.getState().draft.source, 'live');
});

test('saveDraft writes definition JSON that validates; useDraft hands a validated definition over', async () => {
  const ctx = setup();
  assert.deepEqual(await ctx.service.saveDraft(), { ok: false, code: 'no_draft' });
  assert.deepEqual(ctx.service.useDraft(), { ok: false, code: 'no_draft' });
  record(ctx);
  ctx.service.draft({ source: 'live' });

  assert.deepEqual(await ctx.service.saveDraft(), { ok: true, fileName: 'out.json' });
  assert.equal(ctx.saved[0].kind, 'draft');
  assert.equal(validateDefinition(JSON.parse(ctx.saved[0].text)).ok, true);
  assert.ok(ctx.saved[0].text.endsWith('\n'));

  assert.deepEqual(ctx.service.useDraft(), { ok: true });
  assert.equal(ctx.handed.length, 1);
  assert.equal(isValidatedDefinition(ctx.handed[0][0]), true);
  assert.equal(ctx.handed[0][1].fileName, 'draft.json');

  const running = setup({ deviceResult: { ok: false, code: 'running' } });
  record(running);
  running.service.draft({ source: 'live' });
  assert.deepEqual(running.service.useDraft(), { ok: false, code: 'running' });
});

test('shutdown stops the relay and the timer', async () => {
  const ctx = setup();
  await ctx.service.start(START);
  await ctx.service.shutdown();
  assert.equal(ctx.service.getState().relay.running, false);
  assert.equal(ctx.clock.pendingTimers(), 0);
});

test('a draft from the live recording becomes stale when more is recorded, and again after a clear', async () => {
  const ctx = setup();
  record(ctx, 1);
  ctx.service.draft({ source: 'live' });
  assert.equal(ctx.service.getState().draft.stale, false);
  record(ctx, 1);
  assert.equal(ctx.service.getState().draft.stale, true, 'more was recorded after the draft');
  ctx.clock.advance(2000);
  ctx.service.draft({ source: 'live' });
  assert.equal(ctx.service.getState().draft.stale, false);
});

test('a draft from a loaded file is never stale', async () => {
  const source = setup();
  record(source, 2);
  const text = serializeRecording(source.recorder.snapshot());
  const ctx = setup({ loadResult: { ok: true, fileName: 'rec.json', text } });
  await ctx.service.loadRecording();
  ctx.service.draft({ source: 'loaded' });
  record(ctx, 1);
  assert.equal(ctx.service.getState().draft.stale, false);
});

test('drafting cannot be repeated faster than the cool-down', async () => {
  const ctx = setup();
  record(ctx);
  assert.equal(ctx.service.draft({ source: 'live' }).ok, true);
  assert.deepEqual(ctx.service.draft({ source: 'live' }), { ok: false, code: 'busy' });
  ctx.clock.advance(999);
  assert.equal(ctx.service.draft({ source: 'live' }).code, 'busy');
  ctx.clock.advance(1);
  assert.equal(ctx.service.draft({ source: 'live' }).ok, true);
});

test('a very large recording is drafted without the extra checks, and says so', async () => {
  const ctx = setup({ limits: { checkMaxEvents: 3 } });
  record(ctx);
  const { draft } = ctx.service.draft({ source: 'live' });
  assert.deepEqual(draft.holdout, { evaluable: false, reason: 'too_large' });
  assert.equal(draft.replay.skipped, true);
  assert.equal(draft.replay.checked, 0);
  assert.ok(draft.info.patterns.length > 0, 'the draft itself is still made');
});

test('only one file dialog at a time; the text is made after the place was chosen', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const ctx = setup({ saveGate: gate });
  record(ctx, 1);
  const first = ctx.service.saveRecording();
  assert.deepEqual(await ctx.service.saveRecording(), { ok: false, code: 'busy' });
  assert.deepEqual(await ctx.service.loadRecording(), { ok: false, code: 'busy' }, 'a load cannot open beside a save');
  assert.equal(ctx.saved.length, 0, 'nothing was produced while the dialog is open');
  record(ctx, 1); // recorded while the dialog was open: it is part of the saved text
  release();
  assert.equal((await first).ok, true);
  assert.equal(parseRecordingText(ctx.saved[0].text).recording.connections.length, 2);
  assert.equal((await ctx.service.saveRecording()).ok, true, 'free again afterwards');
});

test('a dialog that fails or throws frees the lock', async () => {
  const ctx = setup();
  const boom = createRelayService({
    relay: { getState: () => ({}) }, recorder: ctx.recorder, deviceService: {}, confirm: async () => true,
    saveText: async () => { throw new Error('dialog crashed'); },
    loadText: async () => { throw new Error('dialog crashed'); },
  });
  record(ctx, 1);
  await assert.rejects(boom.saveRecording(), /dialog crashed/);
  await assert.rejects(boom.loadRecording(), /dialog crashed/);
  await assert.rejects(boom.saveRecording(), /dialog crashed/, 'not stuck on busy');
});

test('clearing while the save dialog is open saves nothing instead of an empty file', async () => {
  let release;
  const ctx = setup({ saveGate: new Promise((resolve) => { release = resolve; }) });
  record(ctx, 1);
  const pending = ctx.service.saveRecording();
  ctx.service.clearRecording();
  release();
  assert.deepEqual(await pending, { ok: false, code: 'empty' });
  assert.equal(ctx.saved.length, 0);
});
