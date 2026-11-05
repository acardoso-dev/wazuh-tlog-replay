'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { withMarkers } = require('../src/lib/replay_markers');

const cast = `${['{"version":2}', '[0,"o","a"]', '[5,"o","b"]', '[9,"o","c"]'].join('\n')}\n`;
const lines = (text) => text.trim().split('\n').map(JSON.parse);
const event = (t, command = 'sudo id') => ({ t, label: 'sudo', command });

test('sem eventos, a gravação não muda', () => {
  assert.equal(withMarkers(cast, []), cast);
  assert.equal(withMarkers(cast, undefined), cast);
});

test('coloca o marcador na ordem, depois dos dados com a mesma hora', () => {
  const output = lines(withMarkers(cast, [event(5000), event(7000)]));
  assert.deepEqual(output.map((line) => line[1] ?? 'h'), ['h', 'o', 'o', 'm', 'm', 'o']);
  assert.equal(output[3][0], 5);
  assert.equal(output[3][2], 'sudo: sudo id');
});

test('mantém o marcador posterior ao último dado', () => {
  const output = lines(withMarkers(cast, [event(20000)]));
  assert.deepEqual(output.at(-1), [20, 'm', 'sudo: sudo id']);
});

test('texto hostil não quebra o formato da gravação', () => {
  const output = lines(withMarkers(cast, [event(1000, 'echo "a"\n\u001b[2J')]));
  assert.equal(output[2][2], 'sudo: echo "a"\n\u001b[2J');
  assert.equal(output.length, 5);
});
