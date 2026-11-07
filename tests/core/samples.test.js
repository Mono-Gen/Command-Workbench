// The bundled sample definitions must stay valid and behave as their descriptions say: they are
// the first thing a beginner loads, and the examples the definition guide points to.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseDefinitionText } = require('../../src/core/device-definition');
const { createDeviceEngine } = require('../../src/core/device-engine');

const dir = path.join(__dirname, '..', '..', 'src', 'samples');
const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);

function load(file) {
  const result = parseDefinitionText(fs.readFileSync(path.join(dir, file), 'utf8'));
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  return createDeviceEngine(result.definition);
}

const talk = (engine, text) => engine.handleMessage(Uint8Array.from(Buffer.from(text, 'utf8')));
const lines = (outcome) => outcome.effects.map((e) => Buffer.from(e.bytes).toString('utf8').split(CR).join('<CR>').split(LF).join('<LF>'));

test('every sample file in src/samples is valid', () => {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.deepEqual(files.sort(), ['matrix-switch.json', 'quirky-player.json', 'udp-unit.json']);
  for (const file of files) load(file);
});

test('matrix switch: needs power before routing, silent success, notification on power change', () => {
  const engine = load('matrix-switch.json');
  assert.equal(Buffer.from(engine.greeting()).toString('utf8'), `SAMPLE MATRIX READY${CR}`);

  assert.deepEqual(lines(talk(engine, 'PWR?')), ['PWR standby<CR>']);
  assert.deepEqual(lines(talk(engine, 'OUT1 3')), ['ERR 10<CR>'], 'routing is refused while in standby');
  assert.equal(engine.getState().values.out1, 1);

  const on = talk(engine, 'PWR 1');
  assert.deepEqual(lines(on), ['EVT PWR on<CR>'], 'the set is silent; the notification is sent');

  assert.deepEqual(lines(talk(engine, 'OUT1 3')), [], 'a successful setting is silent');
  assert.deepEqual(lines(talk(engine, 'OUT1?')), ['OUT1 3<CR>']);
  assert.deepEqual(lines(talk(engine, 'OUT1 9')), ['ERR 1<CR>'], 'out of range input');
  assert.deepEqual(lines(talk(engine, 'PWR 7')), ['ERR 1<CR>']);
  assert.deepEqual(lines(talk(engine, 'HELLO')), ['ERR 2<CR>']);
  assert.deepEqual(lines(talk(engine, 'STATUS?')), ['PWR on<CR>OUT 3 2 3 4<CR>']);
});

test('quirky player: slow reply, state-dependent errors, silence to unknown commands', () => {
  const engine = load('quirky-player.json');
  assert.equal(Buffer.from(engine.greeting()).toString('utf8'), `PLAYER 2.1${CR}${LF}`);

  const play = talk(engine, 'PLAY');
  assert.equal(play.effects[0].delayMs, 300);
  assert.deepEqual(lines(play), ['OK<CR><LF>', 'EVT playing<CR><LF>'].slice(0, 2));
  assert.deepEqual(lines(talk(engine, 'PLAY')), ['BUSY<CR><LF>']);
  assert.deepEqual(lines(talk(engine, 'PAUSE')), ['EVT paused<CR><LF>']);
  assert.deepEqual(lines(talk(engine, 'PAUSE')), ['NOT PLAYING<CR><LF>']);
  assert.deepEqual(lines(talk(engine, 'TRACK 100')), ['RANGE 1-99<CR><LF>']);
  assert.deepEqual(lines(talk(engine, 'TRACK 5')), []);
  assert.deepEqual(lines(talk(engine, 'STATE?')), ['STATE paused TRACK 5<CR><LF>']);
  assert.deepEqual(lines(talk(engine, 'WHAT')), [], 'unknown commands get no reply at all');
});

test('UDP unit: declares UDP without a greeting, answers each request, announces level changes to all', () => {
  const parsed = parseDefinitionText(fs.readFileSync(path.join(dir, 'udp-unit.json'), 'utf8'));
  assert.equal(parsed.ok, true, JSON.stringify(parsed.errors));
  assert.equal(parsed.definition.transport, 'udp');
  assert.equal(parsed.definition.greeting, null);
  const engine = createDeviceEngine(parsed.definition);
  assert.deepEqual(lines(talk(engine, 'ID?')), ['UNIT 1.0<CR>']);
  assert.deepEqual(lines(talk(engine, 'LEVEL?')), ['LEVEL=5<CR>']);
  const set = talk(engine, 'LEVEL 7');
  assert.deepEqual(lines(set), ['OK<CR>', 'EVT LEVEL=7<CR>']);
  assert.deepEqual(set.effects.map((e) => e.to), ['sender', 'all']);
  assert.deepEqual(lines(talk(engine, 'LEVEL 11')), ['RANGE 0-10<CR>']);
  assert.deepEqual(lines(talk(engine, 'MUTE 1')), ['OK<CR>']);
  assert.deepEqual(lines(talk(engine, 'MUTE?')), ['MUTE=on<CR>']);
  assert.deepEqual(lines(talk(engine, 'NOPE')), ['ERR 2<CR>']);
});
