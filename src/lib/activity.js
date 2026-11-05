'use strict';

const { t } = require('./i18n');
const { capWarnings, normalizeMessages, parseTiming, validPos } = require('./tlog2asciicast');
const { isoFromSeconds } = require('./safe_time');

// Abaixo disso, a pausa faz parte do uso normal, como pensar entre dois comandos.
const IDLE_GAP_MS = 30000;

const ACTIVITY_TOKENS = new Set(['>', ']', '<', '[']);

/**
 * Resume quando uma sessão teve movimentação, sem devolver o conteúdo dela.
 *
 * O tlog não grava o encerramento, então `durationMs` vai até o último dado registrado. Um
 * comando silencioso, como `sleep`, aparece como ocioso, porque não produz saída.
 */
function buildActivity(messages, { idleGapMs = IDLE_GAP_MS } = {}) {
  const { ordered, warnings } = normalizeMessages(messages);
  const problems = new Set(warnings);
  const segments = [];
  let cursor = 0;
  let last = 0;

  const touch = (time) => {
    const moment = Math.max(time, last);
    last = moment;
    const current = segments[segments.length - 1];
    if (current && moment - current[1] < idleGapMs) {
      current[1] = moment;
    } else {
      segments.push([moment, moment]);
    }
  };

  // O início da sessão conta como movimentação: uma espera logo depois dele é ociosidade.
  if (ordered.length > 0) touch(0);

  for (const message of ordered) {
    let tokens;
    try {
      tokens = parseTiming(String(message.timing ?? ''));
    } catch (error) {
      problems.add(t('warning.badTiming', { id: message.id, reason: error.message }));
      continue;
    }
    if (validPos(message.pos)) cursor = message.pos;
    for (const { op, a } of tokens) {
      if (op === '+') cursor += a;
      else if (ACTIVITY_TOKENS.has(op)) touch(cursor);
    }
  }

  const first = ordered.find((message) => isoFromSeconds(message.time) !== null);
  const activeMs = segments.reduce((total, [start, end]) => total + end - start, 0);
  return {
    // `time` é a hora do pedaço; descontar `pos` chega ao início mesmo sem o primeiro pedaço.
    startedAt: first ? isoFromSeconds(first.time, validPos(first.pos) ? -first.pos : 0) : null,
    durationMs: last,
    activeMs,
    idleMs: last - activeMs,
    idleGapMs,
    segments,
    warnings: capWarnings([...problems]),
  };
}

module.exports = { IDLE_GAP_MS, buildActivity };
