// Tests for the periodic message sender: any saved command may run, the interval starts at one
// second, and timers must always be stopped.
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPeriodic } = require('../../src/main/periodic');
const { createFakeClock, flush } = require('../helpers/fakes');

const query = { kind: 'query', name: 'Get power' };

function setup(sendImpl) {
  const clock = createFakeClock();
  const sent = [];
  const stopped = [];
  const periodic = createPeriodic({
    send: sendImpl ?? (async (command) => { sent.push(command); return { ok: true }; }),
    scheduler: clock.scheduler,
    onStopped: (info) => stopped.push(info),
  });
  return { clock, sent, stopped, periodic };
}

test('start: set-kind and kind-less commands are allowed', () => {
  const { periodic, clock } = setup();
  for (const command of [{ kind: 'set' }, {}]) {
    assert.deepEqual(periodic.start(command, 5000), { ok: true });
    periodic.stop();
  }
  assert.equal(periodic.isRunning(), false);
  assert.equal(clock.pendingTimers(), 0);
});

test('start: a non-object command is a TypeError (programmer error)', () => {
  const { periodic } = setup();
  assert.throws(() => periodic.start(null, 5000), TypeError);
});

test('start: the interval must be an integer from 1000 to 3600000 ms', () => {
  const { periodic } = setup();
  for (const bad of [999, 0, -1, 1000.5, '5000', NaN, 3600001, undefined]) {
    assert.deepEqual(periodic.start(query, bad), { ok: false, code: 'invalid_interval' }, String(bad));
  }
  assert.deepEqual(periodic.start(query, 1000), { ok: true });
  periodic.stop();
  assert.deepEqual(periodic.start(query, 3600000), { ok: true });
});

test('start: refused while already running', () => {
  const { periodic } = setup();
  assert.deepEqual(periodic.start(query, 2000), { ok: true });
  assert.deepEqual(periodic.start(query, 2000), { ok: false, code: 'already_running' });
});

test('sends once per interval, the first one after the first interval', async () => {
  const { periodic, clock, sent } = setup();
  periodic.start(query, 2000);
  assert.equal(sent.length, 0, 'nothing is sent at start');
  clock.advance(1999);
  assert.equal(sent.length, 0);
  clock.advance(1);
  await flush();
  assert.equal(sent.length, 1);
  // Advance one interval at a time and let each send finish, otherwise a tick would be
  // skipped as "previous send still in flight" (tested separately below).
  clock.advance(2000);
  await flush();
  clock.advance(2000);
  await flush();
  assert.equal(sent.length, 3);
  // A frozen snapshot taken at start is passed (not the caller's mutable object).
  assert.ok(sent.every((command) => command.name === query.name && command.kind === 'query'));
  assert.ok(sent.every((command) => Object.isFrozen(command)));
});

test('skips a tick while the previous send is still in flight', async () => {
  let calls = 0;
  let finish;
  const { periodic, clock } = setup(() => {
    calls += 1;
    return new Promise((resolve) => { finish = () => resolve({ ok: true }); });
  });
  periodic.start(query, 1000);
  clock.advance(1000);
  clock.advance(1000);
  clock.advance(1000);
  await flush();
  assert.equal(calls, 1, 'ticks during an unfinished send are skipped');
  finish();
  await flush();
  clock.advance(1000);
  await flush();
  assert.equal(calls, 2);
});

test('a failed send stops the timer and reports why', async () => {
  const { periodic, clock, stopped } = setup(async () => ({ ok: false, code: 'not_connected' }));
  periodic.start(query, 1000);
  clock.advance(1000);
  await flush();
  assert.equal(periodic.isRunning(), false);
  assert.equal(clock.pendingTimers(), 0);
  assert.deepEqual(stopped, [{ reason: 'send_failed', detail: 'not_connected' }]);
});

test('a send that throws also stops the timer', async () => {
  const { periodic, clock, stopped } = setup(() => { throw new Error('boom'); });
  periodic.start(query, 1000);
  clock.advance(1000);
  await flush();
  assert.equal(periodic.isRunning(), false);
  assert.deepEqual(stopped, [{ reason: 'send_failed', detail: 'exception' }]);
});

test('a send that rejects also stops the timer', async () => {
  const { periodic, clock, stopped } = setup(() => Promise.reject(new Error('rejected')));
  periodic.start(query, 1000);
  clock.advance(1000);
  await flush();
  assert.equal(periodic.isRunning(), false);
  assert.deepEqual(stopped, [{ reason: 'send_failed', detail: 'exception' }]);
});

test('stop: clears the timer, reports once, and is idempotent', async () => {
  const { periodic, clock, stopped, sent } = setup();
  periodic.start(query, 1000);
  periodic.stop('connection_closed');
  periodic.stop('connection_closed');
  assert.equal(clock.pendingTimers(), 0);
  assert.deepEqual(stopped, [{ reason: 'connection_closed', detail: null }]);
  clock.advance(5000);
  await flush();
  assert.equal(sent.length, 0);
});

test('stop: defaults the reason to "user", and stopping when not running reports nothing', () => {
  const { periodic, stopped } = setup();
  periodic.stop();
  assert.deepEqual(stopped, []);
  periodic.start(query, 1000);
  periodic.stop();
  assert.deepEqual(stopped, [{ reason: 'user', detail: null }]);
});

test('a result that arrives after stop() does not trigger a second stop report', async () => {
  let finish;
  const { periodic, clock, stopped } = setup(() => new Promise((resolve) => { finish = () => resolve({ ok: false, code: 'not_connected' }); }));
  periodic.start(query, 1000);
  clock.advance(1000);
  await flush(); // let the tick call send, so a send is genuinely in flight
  periodic.stop('user');
  finish();
  await flush();
  assert.deepEqual(stopped, [{ reason: 'user', detail: null }]);
});

test('can be started again after it stopped', async () => {
  const { periodic, clock, sent } = setup();
  periodic.start(query, 1000);
  periodic.stop();
  assert.deepEqual(periodic.start(query, 1000), { ok: true });
  clock.advance(1000);
  await flush();
  assert.equal(sent.length, 1);
});
