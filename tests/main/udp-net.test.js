// Shared UDP helpers: notice throttle, close-and-wait, default interface list.
const test = require('node:test');
const assert = require('node:assert/strict');

const { releaseThen, createNoticeThrottle, defaultInterfaces } = require('../../src/main/udp-net');
const { FakeUdp } = require('../helpers/fake-udp');

test('a notice kind is passed on at most once per interval and kinds are independent', () => {
  let t = 0;
  const notice = createNoticeThrottle(() => t, 1000);
  const seen = [];
  notice('a', () => seen.push('a1'));
  notice('a', () => seen.push('a2'));
  notice('b', () => seen.push('b1'));
  t = 999;
  notice('a', () => seen.push('a3'));
  t = 1000;
  notice('a', () => seen.push('a4'));
  assert.deepEqual(seen, ['a1', 'b1', 'a4']);
});

test('releaseThen calls back once, only after the close event', async () => {
  const socket = new FakeUdp();
  const realClose = socket.close.bind(socket);
  let fire;
  socket.close = () => { socket.closed = true; fire = () => socket.emit('close'); };
  let calls = 0;
  releaseThen(socket, () => { calls += 1; });
  assert.equal(calls, 0);
  fire();
  fire();
  assert.equal(calls, 1);
  assert.ok(realClose);
});

test('releaseThen does not hang on a socket that is not running any more', () => {
  const socket = new FakeUdp();
  socket.close();
  let calls = 0;
  releaseThen(socket, () => { calls += 1; });
  assert.equal(calls, 1, 'close() throws for a closed socket, so the callback runs at once');
});

test('defaultInterfaces lists only well-formed IPv4 entries', () => {
  for (const entry of defaultInterfaces()) {
    assert.match(entry.address, /^\d+\.\d+\.\d+\.\d+$/);
    assert.match(entry.netmask, /^\d+\.\d+\.\d+\.\d+$/);
  }
});
