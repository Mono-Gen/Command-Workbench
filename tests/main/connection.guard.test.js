// Tests for the write-time guard and the connection id (used to pin confirmations).
const test = require('node:test');
const assert = require('node:assert/strict');

const { createConnection } = require('../../src/main/connection');
const { createFakeClock, FakeSocket, flush } = require('../helpers/fakes');

function setup() {
  const clock = createFakeClock();
  const sockets = [];
  const connection = createConnection({
    createSocket: () => { const s = new FakeSocket(); sockets.push(s); return s; },
    scheduler: clock.scheduler,
    now: clock.now,
  });
  return { connection, sockets };
}

async function connected(ctx) {
  const result = ctx.connection.connect({ host: '192.0.2.1', port: 23 });
  ctx.sockets.at(-1).emit('connect');
  await flush();
  return result.id;
}

test('getId: null before any connection, then the id of the current attempt, changing on reconnect', async () => {
  const ctx = setup();
  assert.equal(ctx.connection.getId(), null);
  const first = await connected(ctx);
  assert.equal(ctx.connection.getId(), first);
  ctx.sockets[0].emit('close', false);
  await flush();
  const second = await connected(ctx);
  assert.notEqual(second, first);
  assert.equal(ctx.connection.getId(), second);
});

test('guard: a send proceeds only while the guard returns true, checked when the write starts', async () => {
  const ctx = setup();
  await connected(ctx);
  let allowed = true;
  assert.deepEqual(await ctx.connection.send(Uint8Array.from([1]), { guard: () => allowed }), { ok: true });
  allowed = false;
  assert.deepEqual(await ctx.connection.send(Uint8Array.from([2]), { guard: () => allowed }), { ok: false, code: 'blocked', reason: 'changed_before_send' });
  assert.deepEqual(ctx.sockets[0].written.map((b) => b[0]), [1]);
});

test('guard: only an explicit true allows the write; a throwing guard blocks it', async () => {
  const ctx = setup();
  await connected(ctx);
  for (const guard of [() => 1, () => 'yes', () => undefined, () => { throw new Error('bug'); }]) {
    assert.deepEqual(await ctx.connection.send(Uint8Array.from([9]), { guard }), { ok: false, code: 'blocked', reason: 'changed_before_send' });
  }
  assert.equal(ctx.sockets[0].written.length, 0);
});

test('guard: a blocked send leaves the queue usable and records no send event', async () => {
  const ctx = setup();
  await connected(ctx);
  await ctx.connection.send(Uint8Array.from([1]), { guard: () => false });
  assert.deepEqual(await ctx.connection.send(Uint8Array.from([2])), { ok: true });
  assert.equal(ctx.connection.getHistory().filter((e) => e.type === 'send').length, 1);
});
