// The relay service picks the TCP or the UDP relay by the requested transport, keeps a recording
// to one kind of traffic, and refuses to draft a definition from datagrams (phase 4b).
const test = require('node:test');
const assert = require('node:assert/strict');

const { createRelayService } = require('../../src/main/relay-service');
const { createRecorder, serializeRecording } = require('../../src/core/recording');
const { createFakeClock } = require('../helpers/fakes');

const enc = (text) => Uint8Array.from(Buffer.from(text, 'latin1'));
const START = { listenHost: '127.0.0.1', listenPort: 0, upstreamHost: '10.0.0.20', upstreamPort: 5000 };

function fakeRelay(name, calls) {
  let running = false;
  return {
    start: async (options, hooks) => {
      calls.push([name, options]);
      if (options.listenHost === '0.0.0.0' && !(await hooks.beforeListen({ upstreamAddress: '10.0.0.20', upstreamPort: options.upstreamPort }))) {
        return { ok: false, code: 'cancelled' };
      }
      running = true;
      return { ok: true, host: options.listenHost, port: 6000 };
    },
    stop: async () => { running = false; return { ok: true }; },
    getState: () => ({ running, lifecycle: running ? 'running' : 'idle', transport: name, connections: [] }),
  };
}

function setup({ withUdp = true, loadText } = {}) {
  const clock = createFakeClock();
  const calls = [];
  const confirmCalls = [];
  const emitted = [];
  const recorder = createRecorder({ now: clock.now });
  const service = createRelayService({
    relay: fakeRelay('tcp', calls),
    udpRelay: withUdp ? fakeRelay('udp', calls) : null,
    recorder,
    deviceService: { loadDraft: () => ({ ok: true }) },
    saveText: async () => ({ ok: true, fileName: 'x.json' }),
    loadText: async () => loadText ?? { ok: false, code: 'cancelled' },
    confirm: async (info) => { confirmCalls.push(info); return true; },
    emit: (channel, payload) => emitted.push([channel, payload]),
    now: clock.now,
    scheduler: clock.scheduler,
  });
  return { service, recorder, clock, calls, confirmCalls, emitted };
}

function recordDatagrams(recorder) {
  const id = recorder.openConnection();
  recorder.addChunk(id, 'up', enc('ID?\r'));
  recorder.addChunk(id, 'down', enc('A1\r'));
  recorder.closeConnection(id, 'stop');
}

test('the transport decides which relay starts; the default is TCP', async () => {
  const ctx = setup();
  assert.equal((await ctx.service.start(START)).ok, true);
  assert.equal(ctx.calls.at(-1)[0], 'tcp');
  await ctx.service.stop();
  assert.equal((await ctx.service.start({ ...START, transport: 'udp' })).ok, true);
  assert.equal(ctx.calls.at(-1)[0], 'udp');
  assert.equal(ctx.service.getState().relay.transport, 'udp');
  assert.equal(Object.hasOwn(ctx.calls.at(-1)[1], 'transport'), false, 'the relays get only their known fields');
});

test('an unknown transport is invalid and UDP without an implementation is refused', async () => {
  const ctx = setup();
  assert.equal((await ctx.service.start({ ...START, transport: 'sctp' })).code, 'invalid_arguments');
  const none = setup({ withUdp: false });
  assert.equal((await none.service.start({ ...START, transport: 'udp' })).code, 'udp_unsupported');
  assert.equal(ctx.calls.length, 0);
});

test('only one relay can run at a time', async () => {
  const ctx = setup();
  await ctx.service.start(START);
  assert.equal((await ctx.service.start({ ...START, transport: 'udp' })).code, 'already_running');
  assert.equal(ctx.calls.filter(([n]) => n === 'udp').length, 0);
});

test('listening on all interfaces for UDP adds the spoofing warning to the dialog', async () => {
  const ctx = setup();
  await ctx.service.start({ ...START, listenHost: '0.0.0.0', transport: 'udp' });
  assert.deepEqual(ctx.confirmCalls[0].reasons, ['relay_bind_all', 'udp_spoofable']);
  assert.equal(ctx.confirmCalls[0].target, '10.0.0.20:5000');
});

test('an empty recording switches kind; a recording with content blocks the switch until cleared', async () => {
  const ctx = setup();
  await ctx.service.start({ ...START, transport: 'udp' });
  assert.equal(ctx.recorder.transport(), 'udp');
  await ctx.service.stop();
  recordDatagrams(ctx.recorder);
  assert.equal((await ctx.service.start(START)).code, 'recording_transport_mismatch');
  assert.equal(ctx.calls.filter(([n]) => n === 'tcp').length, 0);
  ctx.service.clearRecording();
  assert.equal((await ctx.service.start(START)).ok, true);
  assert.equal(ctx.recorder.transport(), 'tcp');
});

test('drafting from a UDP recording is refused with a reason, live and loaded', async () => {
  const ctx = setup();
  await ctx.service.start({ ...START, transport: 'udp' });
  recordDatagrams(ctx.recorder);
  assert.deepEqual(await ctx.service.draft({ source: 'live' }), { ok: false, code: 'udp_draft_unsupported' });

  const text = serializeRecording(ctx.recorder.snapshot());
  const other = setup({ loadText: { ok: true, text, fileName: 'udp.json' } });
  const loaded = await other.service.loadRecording();
  assert.equal(loaded.ok, true);
  assert.equal(loaded.summary.transport, 'udp');
  assert.deepEqual(await other.service.draft({ source: 'loaded' }), { ok: false, code: 'udp_draft_unsupported' });
});

test('a UDP recording is saved with its kind and read back', async () => {
  const ctx = setup();
  await ctx.service.start({ ...START, transport: 'udp' });
  recordDatagrams(ctx.recorder);
  assert.equal(JSON.parse(serializeRecording(ctx.recorder.snapshot())).transport, 'udp');
});

test('stop and shutdown stop whichever relay runs', async () => {
  const ctx = setup();
  await ctx.service.start({ ...START, transport: 'udp' });
  assert.equal((await ctx.service.stop()).ok, true);
  assert.equal(ctx.service.getState().relay.running, false);
  await ctx.service.start(START);
  await ctx.service.shutdown();
  assert.equal(ctx.service.getState().relay.running, false);
});
