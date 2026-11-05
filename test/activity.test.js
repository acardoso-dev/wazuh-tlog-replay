'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { buildActivity } = require('../src/lib/activity');
const { buildChunkBody } = require('../src/lib/queries');

const message = (id, pos, timing, extra = {}) => ({ id, pos, timing, ...extra });

test('separa atividade e ociosidade dentro do mesmo pedaço', () => {
  const result = buildActivity([message(1, 0, '=80x24>5+1000>5+60000>5+500>5')]);
  assert.deepStrictEqual(result.segments, [
    [0, 1000],
    [61000, 61500],
  ]);
  assert.strictEqual(result.durationMs, 61500);
  assert.strictEqual(result.activeMs, 1500);
  assert.strictEqual(result.idleMs, 60000);
});

test('encontra a ociosidade entre pedaços pela posição de cada um', () => {
  const result = buildActivity([message(1, 0, '>1+1000>1'), message(2, 50000, '>1+2000>1')]);
  assert.deepStrictEqual(result.segments, [
    [0, 1000],
    [50000, 52000],
  ]);
});

test('uma pausa menor que o limite não conta como ociosidade', () => {
  const result = buildActivity([message(1, 0, '>1+29999>1')]);
  assert.deepStrictEqual(result.segments, [[0, 29999]]);
  assert.strictEqual(result.idleMs, 0);
});

test('uma pausa igual ao limite conta como ociosidade', () => {
  const result = buildActivity([message(1, 0, '>1+30000>1')]);
  assert.deepStrictEqual(result.segments, [
    [0, 0],
    [30000, 30000],
  ]);
});

test('uma espera longa logo depois do início é ociosidade', () => {
  const result = buildActivity([message(1, 45000, '>1')]);
  assert.deepStrictEqual(result.segments, [
    [0, 0],
    [45000, 45000],
  ]);
});

test('tamanho da janela e avanço de tempo sem dados não são atividade', () => {
  const result = buildActivity([message(1, 0, '=80x24>1+90000=100x30')]);
  assert.deepStrictEqual(result.segments, [[0, 0]]);
  assert.strictEqual(result.durationMs, 0);
});

test('saída binária e entrada contam como atividade', () => {
  assert.strictEqual(buildActivity([message(1, 0, '>1+40000]1/3')]).durationMs, 40000);
  assert.strictEqual(buildActivity([message(1, 0, '>1+40000<1')]).durationMs, 40000);
  assert.strictEqual(buildActivity([message(1, 0, '>1+40000[1/3')]).durationMs, 40000);
});

test('sessão de um pedaço instantâneo e lista vazia', () => {
  assert.deepStrictEqual(buildActivity([message(1, 0, '>5')]).segments, [[0, 0]]);
  const empty = buildActivity([]);
  assert.deepStrictEqual(empty.segments, []);
  assert.strictEqual(empty.durationMs, 0);
  assert.strictEqual(empty.startedAt, null);
});

test('calcula o início real, mesmo sem o primeiro pedaço', () => {
  const result = buildActivity([message(3, 5000, '>1', { time: 1000005 })]);
  assert.strictEqual(result.startedAt, new Date(1000000000).toISOString());
});

test('avisa quando faltam pedaços, porque o buraco pareceria ociosidade', () => {
  const result = buildActivity([message(1, 0, '>1'), message(3, 90000, '>1')]);
  assert.ok(result.warnings.some((warning) => warning.includes('Faltam pedaços')));
});

test('ignora timing inválido, avisando, e o relógio nunca volta', () => {
  const invalid = buildActivity([message(1, 0, '>1'), message(2, 100, 'xx')]);
  assert.ok(invalid.warnings.some((warning) => warning.includes('timing inválido')));
  assert.strictEqual(buildActivity([message(1, 5000, '>1'), message(2, 1000, '>1')]).durationMs, 5000);
});

test('não devolve o conteúdo da sessão', () => {
  const result = buildActivity([message(1, 0, '>6', { out_txt: 'segredo' })]);
  assert.ok(!JSON.stringify(result).includes('segredo'));
});

test('a consulta de atividade pede só os campos necessários', () => {
  const body = buildChunkBody('abc', undefined, ['id', 'pos', 'time', 'timing']);
  assert.deepStrictEqual(body._source, ['id', 'pos', 'time', 'timing']);
});

test('funciona com a gravação real', () => {
  const lines = readFileSync(join(__dirname, '../samples/real-session.log'), 'utf8').trim().split('\n');
  const result = buildActivity(lines.map((line) => JSON.parse(line)));
  assert.deepStrictEqual(result.warnings, []);
  assert.ok(result.segments.length > 0);
  assert.strictEqual(result.activeMs + result.idleMs, result.durationMs);
});
