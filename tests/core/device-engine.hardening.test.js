// Regression tests for the independent audit: matching must stay cheap even for hostile
// definitions and messages (a LAN peer must not be able to stall the main thread).
const test = require('node:test');
const assert = require('node:assert/strict');

const { validateDefinition } = require('../../src/core/device-definition');
const { createDeviceEngine, MAX_MATCH_WORK } = require('../../src/core/device-engine');

function engineWith(commands, extra = {}) {
  const result = validateDefinition({ schemaVersion: 1, name: 'x', framing: { terminator: 'cr' }, commands, ...extra });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  return createDeviceEngine(result.definition);
}

const message = (text) => Uint8Array.from(Buffer.from(text, 'utf8'));

test('exports the per-message matching budget', () => {
  assert.equal(MAX_MATCH_WORK, 2000000);
});

test('a message that would need more matching work than the budget is treated as unknown', () => {
  // 499 commands that each scan the whole 4096-unit message without matching, then a catch-all.
  const commands = Array.from({ length: 499 }, (_, i) => ({ pattern: `*${'A'.repeat(200)}B${i % 10}`, reply: null }));
  commands.push({ pattern: '*', reply: 'caught' });
  const engine = engineWith(commands, { unknown: { reply: 'unknown' } });
  const outcome = engine.handleMessage(message('A'.repeat(4096)));
  assert.equal(outcome.outcome, 'unknown', 'the defensive cut-off applies');
  assert.equal(Buffer.from(outcome.effects[0].bytes).toString('utf8'), 'unknown');
});

test('the same definition still matches when the message is short (the budget is not reached)', () => {
  const commands = Array.from({ length: 499 }, (_, i) => ({ pattern: `*${'A'.repeat(200)}B${i % 10}`, reply: null }));
  commands.push({ pattern: '*', reply: 'caught' });
  const engine = engineWith(commands, { unknown: { reply: 'unknown' } });
  const outcome = engine.handleMessage(message('A'.repeat(100)));
  assert.equal(outcome.outcome, 'matched');
  assert.equal(Buffer.from(outcome.effects[0].bytes).toString('utf8'), 'caught');
});

test('hostile patterns finish quickly (case-sensitive and case-insensitive)', () => {
  for (const caseInsensitive of [false, true]) {
    const commands = Array.from({ length: 500 }, () => ({ pattern: `*${'A'.repeat(250)}B`, caseInsensitive, reply: null }));
    const engine = engineWith(commands);
    const started = process.hrtime.bigint();
    engine.handleMessage(message('A'.repeat(4096)));
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    // Before the fix this took more than a second; the bound is generous to avoid flakiness.
    assert.ok(ms < 400, `matching took ${ms.toFixed(0)} ms (caseInsensitive=${caseInsensitive})`);
  }
});

test('case-insensitive matching still folds ASCII only', () => {
  const engine = engineWith([{ pattern: 'Go {x}', caseInsensitive: true, reply: 'ok {capture.x}' }]);
  const outcome = engine.handleMessage(message('gO Ünï'));
  assert.equal(Buffer.from(outcome.effects[0].bytes).toString('utf8'), 'ok Ünï');
  assert.equal(engine.handleMessage(message('GO ünï')).outcome, 'matched');
  const strict = engineWith([{ pattern: 'é {x}', caseInsensitive: true, reply: 'ok' }]);
  assert.equal(strict.handleMessage(message('É 1')).outcome, 'unknown', 'only A-Z fold, not É');
});
