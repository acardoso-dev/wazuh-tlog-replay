'use strict';

// Limite do tipo Date. Horas vêm de documentos do índice e podem ser forjadas: um valor fora dele
// faria toISOString lançar erro, e uma única gravação derrubaria a lista inteira.
const MAX_DATE_MS = 8.64e15;

const isoFromMs = (ms) => (Number.isFinite(ms) && Math.abs(ms) <= MAX_DATE_MS ? new Date(ms).toISOString() : null);

/** `seconds` é o campo `time` do tlog. Devolve `null` se não der uma data válida. */
const isoFromSeconds = (seconds, offsetMs = 0) => (Number.isFinite(seconds) ? isoFromMs(seconds * 1000 + offsetMs) : null);

module.exports = { isoFromMs, isoFromSeconds };
