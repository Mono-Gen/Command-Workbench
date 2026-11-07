// The complete definitions shown in the documentation must be valid and must behave as the text
// around them says (both languages), so the guide cannot drift away from the implementation.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseDefinitionText } = require('../../src/core/device-definition');
const { createDeviceEngine } = require('../../src/core/device-engine');

const docsDir = path.join(__dirname, '..', '..', 'docs');
const CR = String.fromCharCode(13);

function completeExamples(file) {
  // The documents may use LF or CRLF line endings depending on the checkout, so normalize first.
  const text = fs.readFileSync(path.join(docsDir, file), 'utf8').split(String.fromCharCode(13)).join('');
  const blocks = [...text.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]);
  return blocks.filter((b) => b.includes('"schemaVersion"'));
}

for (const file of ['device-definition.md', 'device-definition_JP.md']) {
  test(`${file}: the first example is valid and behaves as described`, () => {
    const examples = completeExamples(file);
    assert.equal(examples.length, 1, 'exactly one complete example');
    const result = parseDefinitionText(examples[0]);
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    const engine = createDeviceEngine(result.definition);
    const talk = (text) => engine.handleMessage(Uint8Array.from(Buffer.from(text, 'utf8')));
    const lines = (o) => o.effects.map((e) => Buffer.from(e.bytes).toString('utf8').split(CR).join('<CR>'));

    assert.equal(Buffer.from(engine.greeting()).toString('utf8'), `HELLO${CR}`);
    assert.deepEqual(lines(talk('PWR ?')), ['PWR standby<CR>']);
    assert.deepEqual(lines(talk('PWR 1')), ['EVT PWR on<CR>'], 'silent set, notification only');
    assert.deepEqual(lines(talk('PWR 7')), ['ERR 1<CR>'], 'not in the map: invalid reply, nothing changes');
    assert.equal(engine.getState().values.power, 'on');
    assert.deepEqual(lines(talk('HELLO?')), ['ERR 2<CR>']);
  });

  test(`${file}: the documented order pitfall is real (the generic pattern first captures "?")`, () => {
    const [example] = completeExamples(file);
    const definition = JSON.parse(example);
    definition.commands.reverse();
    const result = parseDefinitionText(JSON.stringify(definition));
    assert.equal(result.ok, true);
    const engine = createDeviceEngine(result.definition);
    const reply = engine.handleMessage(Uint8Array.from(Buffer.from('PWR ?', 'utf8')));
    assert.equal(Buffer.from(reply.effects[0].bytes).toString('utf8'), `ERR 1${CR}`, 'with the wrong order the query is answered with an error');
  });
}

test('both languages document the same limits', () => {
  for (const file of ['device-definition.md', 'device-definition_JP.md']) {
    const text = fs.readFileSync(path.join(docsDir, file), 'utf8');
    for (const number of ['4096', '1000-3600000', '1 MiB'.replace('1 MiB', '1 MiB')]) {
      if (file.endsWith('_JP.md') && number === '1000-3600000') {
        assert.ok(text.includes('1000〜3600000'), `${file}: idle range`);
      } else if (file.endsWith('_JP.md') && number === '1 MiB') {
        assert.ok(text.includes('1 MiB'), `${file}: file size`);
      } else {
        assert.ok(text.includes(number), `${file}: ${number}`);
      }
    }
  }
});
