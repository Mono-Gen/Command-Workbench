// Regression tests for holes found by the independent audit of the TCP layer and storage.
// Each test names the failure scenario it prevents.
const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createConnection } = require('../../src/main/connection');
const { createPeriodic } = require('../../src/main/periodic');
const { createCommandStore } = require('../../src/main/storage');
const { createFakeClock, FakeSocket, flush } = require('../helpers/fakes');

function connectionSetup(options = {}) {
  const clock = createFakeClock();
  const sockets = [];
  const events = [];
  const connection = createConnection({
    createSocket: () => { const s = new FakeSocket(); sockets.push(s); return s; },
    scheduler: clock.scheduler,
    now: clock.now,
    onEvent: (e) => events.push(e),
    ...options,
  });
  return { clock, sockets, events, connection };
}

async function connected(ctx) {
  ctx.connection.connect({ host: '192.0.2.1', port: 23 });
  ctx.sockets.at(-1).emit('connect');
  await flush();
}

// ---- connection ------------------------------------------------------------------------

test('after the peer half-closes (FIN), new sends are refused', async () => {
  const ctx = connectionSetup();
  await connected(ctx);
  ctx.sockets[0].emit('end');
  assert.deepEqual(await ctx.connection.send(Uint8Array.from([1])), { ok: false, code: 'not_connected' });
  assert.equal(ctx.sockets[0].written.length, 0);
});

test('a write whose callback never fires is resolved when the connection closes', async () => {
  const ctx = connectionSetup();
  await connected(ctx);
  ctx.sockets[0].write = (buffer) => { ctx.sockets[0].written.push(Uint8Array.from(buffer)); return true; };
  const first = ctx.connection.send(Uint8Array.from([1]));
  const second = ctx.connection.send(Uint8Array.from([2]));
  await flush();

  ctx.sockets[0].emit('close', true);
  const results = await Promise.all([first, second]);
  assert.deepEqual(results, [{ ok: false, code: 'not_connected' }, { ok: false, code: 'not_connected' }]);
});

test('the number of queued writes is capped', async () => {
  const ctx = connectionSetup({ maxQueuedWrites: 3 });
  await connected(ctx);
  ctx.sockets[0].write = () => true; // never completes
  const results = [];
  for (let i = 0; i < 5; i += 1) results.push(ctx.connection.send(Uint8Array.from([i])));
  const extra = await Promise.all(results.slice(3));
  assert.deepEqual(extra, [{ ok: false, code: 'queue_full' }, { ok: false, code: 'queue_full' }]);
  ctx.sockets[0].emit('close', true);
  await Promise.all(results);
});

test('an exception thrown by the event listener does not break sending', async () => {
  const reported = [];
  let throwOnSend = false;
  const ctx = connectionSetup({
    onEvent: (e) => { if (throwOnSend && e.type === 'send') throw new Error('listener bug'); },
    onListenerError: (error) => reported.push(error.message),
  });
  await connected(ctx);
  throwOnSend = true;
  assert.deepEqual(await ctx.connection.send(Uint8Array.from([1])), { ok: true });
  throwOnSend = false;
  assert.deepEqual(await ctx.connection.send(Uint8Array.from([2])), { ok: true });
  assert.deepEqual(reported, ['listener bug']);
  assert.equal(ctx.sockets[0].written.length, 2);
});

test('a listener that reads the history sees the event it was just notified about', async () => {
  // Found by the service tests: hints are computed from the history inside the listener, so the
  // event must already be recorded when the listener runs.
  const seen = [];
  let connection;
  const clock = createFakeClock();
  const sockets = [];
  connection = createConnection({
    createSocket: () => { const s = new FakeSocket(); sockets.push(s); return s; },
    scheduler: clock.scheduler,
    now: clock.now,
    onEvent: (event) => {
      if (event.type !== 'state' && event.type !== 'recv') {
        seen.push([event.type, connection.getHistory().map((e) => e.type)]);
      }
    },
  });
  connection.connect({ host: '192.0.2.1', port: 23 });
  sockets[0].emit('connect');
  await connection.send(Uint8Array.from([1]));
  sockets[0].emit('end');
  sockets[0].emit('close', false);
  await flush();
  assert.deepEqual(seen, [
    ['connect_ok', ['connect_ok']],
    ['send', ['connect_ok', 'send']],
    ['terminated', ['connect_ok', 'send', 'terminated']],
  ]);
});

// ---- periodic --------------------------------------------------------------------------

test('periodic: changing the command object after start cannot change the snapshot', async () => {
  const clock = createFakeClock();
  const sent = [];
  const periodic = createPeriodic({ send: async (c) => { sent.push(c.name); return { ok: true }; }, scheduler: clock.scheduler });
  const command = { kind: 'query', name: 'x' };
  periodic.start(command, 1000);
  command.name = 'changed';
  clock.advance(1000);
  await flush();
  assert.deepEqual(sent, ['x'], 'the snapshot taken at start is what gets sent');
});

test('periodic: a restart is not blocked by a send left over from the previous run', async () => {
  const clock = createFakeClock();
  let calls = 0;
  const periodic = createPeriodic({
    send: () => { calls += 1; return calls === 1 ? new Promise(() => {}) : Promise.resolve({ ok: true }); },
    scheduler: clock.scheduler,
    sendTimeoutMs: 60000,
  });
  periodic.start({ kind: 'query' }, 1000);
  clock.advance(1000);
  await flush();
  periodic.stop();
  periodic.start({ kind: 'query' }, 1000);
  clock.advance(1000);
  await flush();
  assert.equal(calls, 2, 'the new run sends even though the old send never finished');
});

test('periodic: a send that hangs stops the timer after the send timeout', async () => {
  const clock = createFakeClock();
  const stopped = [];
  const periodic = createPeriodic({
    send: () => new Promise(() => {}),
    scheduler: clock.scheduler,
    sendTimeoutMs: 5000,
    onStopped: (info) => stopped.push(info),
  });
  periodic.start({ kind: 'query' }, 1000);
  clock.advance(1000);
  await flush();
  assert.equal(periodic.isRunning(), true);
  clock.advance(5000);
  await flush();
  assert.equal(periodic.isRunning(), false);
  assert.deepEqual(stopped, [{ reason: 'send_failed', detail: 'timeout' }]);
  assert.equal(clock.pendingTimers(), 0);
});

// ---- storage ---------------------------------------------------------------------------

async function tempDir(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pw-hardening-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

const sample = {
  schemaVersion: 1,
  devices: [{ name: 'D', host: 'h', port: 1, commands: [{ name: 'c', text: 'A', mode: 'text', appendTerminator: 'none', kind: 'query' }] }],
};

test('storage: save before load is refused and cannot overwrite a broken file', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'workbench-commands.json');
  await fsp.writeFile(file, '{ broken');
  const store = createCommandStore({ fs: fsp, dir, sleep: async () => {} });

  assert.deepEqual(await store.save(sample), { ok: false, code: 'not_loaded' });
  assert.equal(await fsp.readFile(file, 'utf8'), '{ broken');
});

test('storage: a save started right after load() waits for it and is blocked by a broken file', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'workbench-commands.json');
  await fsp.writeFile(file, '{ broken');
  const store = createCommandStore({ fs: fsp, dir, sleep: async () => {} });

  const loading = store.load();
  const saving = store.save(sample);
  assert.equal((await loading).status, 'corrupt');
  assert.deepEqual(await saving, { ok: false, code: 'blocked_by_unreadable_file' });
  assert.equal(await fsp.readFile(file, 'utf8'), '{ broken');
});

test('storage: after a load of a missing file, saving is allowed', async (t) => {
  const dir = await tempDir(t);
  const store = createCommandStore({ fs: fsp, dir, sleep: async () => {} });
  assert.equal((await store.load()).status, 'missing');
  assert.deepEqual(await store.save(sample), { ok: true });
});

test('storage: temp file names are random, and a file we did not create is never deleted', async (t) => {
  const dir = await tempDir(t);
  const unlinked = [];
  const collidingFs = {
    ...fsp,
    open: async () => { throw Object.assign(new Error('exists'), { code: 'EEXIST' }); },
    unlink: async (p) => { unlinked.push(p); },
  };
  const store = createCommandStore({ fs: collidingFs, dir, sleep: async () => {} });
  await store.load();
  assert.deepEqual(await store.save(sample), { ok: false, code: 'write_failed', errno: 'EEXIST' });
  assert.deepEqual(unlinked, [], 'a temp path we failed to create must not be removed');

  const names = new Set();
  const recordingFs = { ...fsp, open: async (p, flags) => { names.add(path.basename(p)); return fsp.open(p, flags); } };
  const store2 = createCommandStore({ fs: recordingFs, dir, sleep: async () => {} });
  await store2.load();
  await store2.save(sample);
  await store2.save(sample);
  assert.equal(names.size, 2, 'every save uses a different temp name');
  for (const name of names) assert.match(name, /^workbench-commands\.json\.[0-9a-f]{8}\.tmp$/);
});
