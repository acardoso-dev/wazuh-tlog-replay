'use strict';

const { t } = require('./i18n');
/**
 * Converte mensagens JSON do tlog para o formato asciicast v2.
 *
 * Campo `timing` do tlog, uma sequência de tokens:
 *   =WxH  tamanho da janela
 *   +N    avanço de N milissegundos
 *   >N    N caracteres de out_txt
 *   <N    N caracteres de in_txt
 *   ]T/B  saída binária: T caracteres de substituição em out_txt, B bytes em out_bin
 *   [T/B  entrada binária: T caracteres de substituição em in_txt, B bytes em in_bin
 *
 * As contagens são em caracteres Unicode (code points), não em unidades UTF-16.
 */

const { isoFromSeconds } = require('./safe_time');

const TOKEN = /([=<>[\]+])(\d+)(?:[x/](\d+))?/y;
// Cerca de 30 anos em milissegundos. Um número gigante viraria Infinity e quebraria o player.
const MAX_TIMING_VALUE = 1e12;
// Uma janela absurda faria o navegador de quem assiste reservar memória para cada célula.
const MAX_COLS = 1000;
const MAX_ROWS = 500;
const MAX_WARNINGS = 20;

const validPos = (value) => Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIMING_VALUE;

/** Uma gravação forjada pode gerar um aviso por mensagem: a tela precisa de poucos. */
function capWarnings(warnings) {
  if (warnings.length <= MAX_WARNINGS) return warnings;
  return [...warnings.slice(0, MAX_WARNINGS), `E mais ${warnings.length - MAX_WARNINGS} aviso(s).`];
}

function parseTiming(timing) {
  const tokens = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < timing.length) {
    const start = TOKEN.lastIndex;
    const match = TOKEN.exec(timing);
    if (!match) {
      throw new Error(t('timing.badToken', { position: start }));
    }
    const [, op, first, second] = match;
    const needsSecond = op === '=' || op === '[' || op === ']';
    if (needsSecond !== (second !== undefined)) {
      throw new Error(t('timing.malformedToken', { token: match[0] }));
    }
    const a = Number(first);
    const b = second === undefined ? 0 : Number(second);
    if (a > MAX_TIMING_VALUE || b > MAX_TIMING_VALUE) {
      throw new Error(t('timing.outOfRange', { position: start }));
    }
    tokens.push({ op, a, b });
  }
  return tokens;
}

/** Ordena por id, remove duplicatas e aponta buracos e conflitos. */
function normalizeMessages(messages) {
  const warnings = [];
  const byId = new Map();
  let conflicts = 0;

  for (const message of messages) {
    if (!Number.isInteger(message.id)) {
      warnings.push(t('warning.noId'));
      continue;
    }
    const previous = byId.get(message.id);
    if (previous === undefined) {
      byId.set(message.id, message);
    } else if (previous.timing !== message.timing || previous.out_txt !== message.out_txt) {
      conflicts += 1;
    }
  }
  if (conflicts > 0) {
    warnings.push(
      t('warning.conflicts', { count: conflicts })
    );
  }

  const ordered = [...byId.values()].sort((x, y) => x.id - y.id);
  const missing = [];
  let expected = 1;
  for (const { id } of ordered) {
    if (id > expected) {
      missing.push(id - 1 === expected ? `${expected}` : `${expected}-${id - 1}`);
    }
    expected = id + 1;
  }
  if (missing.length > 0) {
    warnings.push(
      t('warning.missing', { ids: `${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ', ...' : ''}` })
    );
  }
  return { ordered, warnings };
}

/** Consome caracteres de uma string por code point, respeitando o que `timing` manda. */
class CodePointReader {
  constructor(text) {
    this.chars = typeof text === 'string' ? Array.from(text) : [];
    this.position = 0;
  }

  take(count) {
    const slice = this.chars.slice(this.position, this.position + count).join('');
    const available = Math.min(count, this.chars.length - this.position);
    this.position += available;
    return { text: slice, short: available < count };
  }
}

function convert(messages, options = {}) {
  const includeInput = options.includeInput === true;
  const { ordered, warnings } = normalizeMessages(messages);
  const problems = new Set(warnings);
  const events = [];
  let width;
  let height;

  const decoders = { o: new TextDecoder('utf-8'), i: new TextDecoder('utf-8') };
  let lastTime = 0;

  const push = (timeMs, code, data) => {
    if (data === '') {
      return;
    }
    // O relógio nunca volta: o player exige tempos crescentes.
    const time = Math.max(timeMs, lastTime);
    lastTime = time;
    const last = events[events.length - 1];
    if (last && last[0] === time && last[1] === code && code !== 'r') {
      last[2] += data;
    } else {
      events.push([time, code, data]);
    }
  };

  // Bytes de um caractere cortado entre mensagens ficam retidos no decoder até o
  // próximo token binário. Texto no meio significa que o caractere ficou incompleto.
  const flushDecoder = (timeMs, code) => push(timeMs, code, decoders[code].decode());

  let cursor = 0;
  for (const message of ordered) {
    let tokens;
    try {
      tokens = parseTiming(String(message.timing ?? ''));
    } catch (error) {
      problems.add(t('warning.badTiming', { id: message.id, reason: error.message }));
      continue;
    }

    if (validPos(message.pos)) {
      cursor = message.pos;
    }
    const outText = new CodePointReader(message.out_txt);
    const inText = new CodePointReader(message.in_txt);
    const outBin = Array.isArray(message.out_bin) ? message.out_bin : [];
    const inBin = Array.isArray(message.in_bin) ? message.in_bin : [];
    let outBinPosition = 0;
    let inBinPosition = 0;

    const takeText = (reader, code, count) => {
      flushDecoder(cursor, code);
      const { text, short } = reader.take(count);
      if (short) {
        problems.add(t('warning.shortText', { id: message.id }));
      }
      push(cursor, code, text);
    };

    const takeBinary = (reader, code, bytes, position, replacements, count) => {
      reader.take(replacements); // caracteres de substituição, os bytes reais vêm do array
      const slice = bytes.slice(position, position + count).map((value) => value & 0xff);
      if (slice.length < count) {
        problems.add(t('warning.shortBytes', { id: message.id }));
      }
      push(cursor, code, decoders[code].decode(Uint8Array.from(slice), { stream: true }));
      return position + count;
    };

    for (const { op, a, b } of tokens) {
      if (op === '+') {
        cursor += a;
      } else if (op === '=') {
        // Sem terminal, o tlog grava 0x0: não é um tamanho que o player consiga usar.
        if (a > 0 && b > 0) {
          if (a > MAX_COLS || b > MAX_ROWS) {
            problems.add(t('warning.windowSize', { size: `${a}x${b}` }));
          }
          const cols = Math.min(a, MAX_COLS);
          const rows = Math.min(b, MAX_ROWS);
          if (width === undefined) {
            width = cols;
            height = rows;
          } else {
            push(cursor, 'r', `${cols}x${rows}`);
          }
        }
      } else if (op === '>') {
        takeText(outText, 'o', a);
      } else if (op === ']') {
        outBinPosition = takeBinary(outText, 'o', outBin, outBinPosition, a, b);
      } else if (includeInput && op === '<') {
        takeText(inText, 'i', a);
      } else if (includeInput && op === '[') {
        inBinPosition = takeBinary(inText, 'i', inBin, inBinPosition, a, b);
      }
    }
  }
  flushDecoder(cursor, 'o');
  if (includeInput) {
    flushDecoder(cursor, 'i');
  }

  const first = ordered[0] || {};
  const header = { version: 2, width: width || 80, height: height || 24 };
  if (isoFromSeconds(first.time) !== null) {
    header.timestamp = Math.floor(first.time);
  }
  if (first.term) {
    header.env = { TERM: String(first.term) };
  }
  if (first.user || first.host) {
    header.title = `${first.user ?? '?'}@${first.host ?? '?'}`;
  }

  return {
    header,
    events: events.map(([time, code, data]) => [time / 1000, code, data]),
    warnings: capWarnings([...problems]),
    durationSeconds: lastTime / 1000,
    messageCount: ordered.length,
  };
}

function toCast({ header, events }) {
  return [header, ...events].map((line) => JSON.stringify(line)).join('\n') + '\n';
}

module.exports = { MAX_COLS, MAX_ROWS, MAX_TIMING_VALUE, MAX_WARNINGS, capWarnings, parseTiming, normalizeMessages, convert, toCast, validPos };
