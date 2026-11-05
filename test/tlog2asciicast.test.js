'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseTiming, convert, toCast } = require('../src/lib/tlog2asciicast');

const message = (overrides) => ({
  id: 1,
  pos: 0,
  timing: '',
  in_txt: '',
  in_bin: [],
  out_txt: '',
  out_bin: [],
  ...overrides,
});
const output = (result) =>
  result.events.filter((event) => event[1] === 'o').map((event) => event[2]).join('');

test('interpreta todos os tokens de timing', () => {
  assert.deepEqual(parseTiming('=100x30+5>2<3]2/4[1/1'), [
    { op: '=', a: 100, b: 30 },
    { op: '+', a: 5, b: 0 },
    { op: '>', a: 2, b: 0 },
    { op: '<', a: 3, b: 0 },
    { op: ']', a: 2, b: 4 },
    { op: '[', a: 1, b: 1 },
  ]);
});

test('rejeita timing malformado', () => {
  assert.throws(() => parseTiming('+5?3'));
  assert.throws(() => parseTiming('=100'));
  assert.throws(() => parseTiming('>1/2'));
});

test('calcula os tempos a partir de pos e dos atrasos', () => {
  const result = convert([
    message({ id: 1, pos: 0, timing: '=80x24+100>1+50>1', out_txt: 'ab' }),
    message({ id: 2, pos: 1000, timing: '+500>1', out_txt: 'c' }),
  ]);
  assert.deepEqual(result.header.width, 80);
  assert.deepEqual(result.events, [
    [0.1, 'o', 'a'],
    [0.15, 'o', 'b'],
    [1.5, 'o', 'c'],
  ]);
});

test('conta caracteres por code point, inclusive fora do BMP', () => {
  const result = convert([message({ timing: '>2+10>1', out_txt: '😀é✓' })]);
  assert.deepEqual(result.events, [
    [0, 'o', '😀é'],
    [0.01, 'o', '✓'],
  ]);
  assert.deepEqual(result.warnings, []);
});

test('decodifica UTF-8 cortado entre mensagens binárias', () => {
  const result = convert([
    message({ id: 1, timing: ']1/1', out_txt: '�', out_bin: [0xc3] }),
    message({ id: 2, pos: 1, timing: ']1/1', out_txt: '�', out_bin: [0xa9] }),
  ]);
  assert.equal(output(result), 'é');
});

test('aceita bytes negativos no array binário', () => {
  const result = convert([message({ timing: ']1/2', out_txt: '�', out_bin: [-61, -87] })]);
  assert.equal(output(result), 'é');
});

test('registra mudança de tamanho da janela como evento', () => {
  const result = convert([message({ timing: '=80x24+10=120x40>1', out_txt: 'x' })]);
  assert.equal(result.header.width, 80);
  assert.deepEqual(result.events, [
    [0.01, 'r', '120x40'],
    [0.01, 'o', 'x'],
  ]);
});

test('não expõe a entrada do usuário por padrão', () => {
  const messages = [message({ timing: '<6>2', in_txt: 'senha!', out_txt: 'ok' })];
  const hidden = convert(messages);
  assert.equal(output(hidden), 'ok');
  assert.ok(!JSON.stringify(hidden.events).includes('senha'));
  const shown = convert(messages, { includeInput: true });
  assert.ok(JSON.stringify(shown.events).includes('senha!'));
});

test('ordena pedaços fora de ordem e ignora duplicatas idênticas', () => {
  const second = message({ id: 2, pos: 10, timing: '>1', out_txt: 'b' });
  const result = convert([second, message({ timing: '>1', out_txt: 'a' }), second]);
  assert.equal(output(result), 'ab');
  assert.deepEqual(result.warnings, []);
});

test('avisa sobre pedaços ausentes', () => {
  const result = convert([
    message({ id: 1, timing: '>1', out_txt: 'a' }),
    message({ id: 4, pos: 9, timing: '>1', out_txt: 'd' }),
  ]);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /ids 2-3/);
});

test('avisa quando o início da gravação não está no índice', () => {
  const result = convert([message({ id: 3, timing: '>1', out_txt: 'c' })]);
  assert.match(result.warnings[0], /ids 1-2/);
});

test('avisa sobre id repetido com conteúdo diferente', () => {
  const result = convert([
    message({ timing: '>1', out_txt: 'a' }),
    message({ timing: '>1', out_txt: 'X' }),
  ]);
  assert.equal(output(result), 'a');
  assert.match(result.warnings[0], /adulterada/);
});

test('sobrevive a timing inválido e a texto mais curto que o esperado', () => {
  const result = convert([
    message({ id: 1, timing: '??', out_txt: 'perdido' }),
    message({ id: 2, timing: '>5', out_txt: 'ab' }),
  ]);
  assert.equal(output(result), 'ab');
  assert.equal(result.warnings.length, 2);
});

test('mantém os tempos crescentes mesmo se pos voltar', () => {
  const result = convert([
    message({ id: 1, pos: 100, timing: '>1', out_txt: 'a' }),
    message({ id: 2, pos: 50, timing: '>1', out_txt: 'b' }),
  ]);
  const times = result.events.map((event) => event[0]);
  assert.deepEqual(times, [...times].sort((x, y) => x - y));
});

test('devolve um cast válido para lista vazia', () => {
  const lines = toCast(convert([])).trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).version, 2);
});

test('gravação real do tlog 14: reconstrói toda a saída', () => {
  const file = path.join(__dirname, '..', 'samples', 'real-session.log');
  const messages = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(messages.length > 1, 'a amostra precisa ter vários pedaços');

  const result = convert(messages);
  const text = output(result);

  assert.deepEqual(result.warnings, []);
  assert.equal(result.header.width, 100);
  assert.equal(result.header.height, 30);
  assert.match(text, /acentuação: São Paulo ✓ 日本語/);
  assert.match(text, /bytes invalidos: �� fim/);
  assert.match(text, /progresso 3\/3/);
  assert.ok(text.includes('\r\nfim-da-sessao\r\n'));

  const numbers = text.split('\r\n').filter((line) => /^\d+$/.test(line)).map(Number);
  assert.deepEqual(numbers, Array.from({ length: 1500 }, (_, index) => index + 1));

  // O script da amostra dorme cerca de 2,2 s no total.
  assert.ok(result.durationSeconds > 2 && result.durationSeconds < 5, `duração: ${result.durationSeconds}`);
});
