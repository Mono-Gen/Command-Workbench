const test = require('node:test');
const assert = require('node:assert/strict');

const { isSendAllowed, canBePeriodic } = require('../../src/core/safety');

test('allows every command kind when read-only mode is off', () => {
  for (const command of [{ kind: 'query' }, { kind: 'set' }, {}, { kind: 'other' }]) {
    assert.deepEqual(isSendAllowed(command, { readOnly: false }), { allowed: true });
  }
});

test('allows only queries when read-only mode is on', () => {
  assert.deepEqual(isSendAllowed({ kind: 'query' }, { readOnly: true }), { allowed: true });
  assert.deepEqual(isSendAllowed({ kind: 'set' }, { readOnly: true }), {
    allowed: false,
    reason: 'read_only_blocks_set',
  });
  for (const command of [{}, { kind: 'other' }]) {
    assert.deepEqual(isSendAllowed(command, { readOnly: true }), {
      allowed: false,
      reason: 'read_only_blocks_unclassified',
    });
  }
});

test('allows only queries to be periodic', () => {
  assert.deepEqual(canBePeriodic({ kind: 'query' }), { allowed: true });
  for (const command of [{ kind: 'set' }, {}, { kind: 'other' }]) {
    assert.deepEqual(canBePeriodic(command), { allowed: false, reason: 'not_query' });
  }
});

test('all safety functions reject non-object commands', () => {
  const functions = [
    (command) => isSendAllowed(command, { readOnly: false }),
    (command) => canBePeriodic(command),
  ];
  for (const fn of functions) {
    for (const command of [null, undefined, 'query', 1, true]) {
      assert.throws(() => fn(command), TypeError);
    }
  }
});
