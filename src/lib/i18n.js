'use strict';

const en = require('./messages/en');
const ptBR = require('./messages/pt-BR');

// Para acrescentar um idioma: crie o catálogo em messages/ e registre-o aqui.
const CATALOGS = { en, 'pt-BR': ptBR };
const LOCALES = [
  { id: 'en', name: 'English' },
  { id: 'pt-BR', name: 'Português (Brasil)' },
];
const FALLBACK_LOCALE = 'en';
// O navegador avisa o servidor por este cabeçalho, porque o idioma é escolhido por usuário.
const LOCALE_HEADER = 'x-tlog-replay-locale';

let current = 'pt-BR';
let provider = null;

/** Aceita "en-US" ou "pt". Devolve um idioma do catálogo, ou null. */
function normalizeLocale(value) {
  if (typeof value !== 'string') return null;
  const lower = value.toLowerCase();
  return LOCALES.find(({ id }) => id.toLowerCase() === lower || lower.startsWith(`${id.slice(0, 2).toLowerCase()}`))?.id ?? null;
}

/** A escolha salva vale mais que o idioma do navegador. */
function preferredLocale(stored, browserLanguages = []) {
  return normalizeLocale(stored) ?? browserLanguages.map(normalizeLocale).find(Boolean) ?? FALLBACK_LOCALE;
}

const getLocale = () => provider?.() ?? current;

function setLocale(locale) {
  current = normalizeLocale(locale) ?? FALLBACK_LOCALE;
}

/** No servidor, cada requisição tem o próprio idioma, então ele não pode ficar em uma variável. */
function setLocaleProvider(next) {
  provider = next;
}

/** Só troca os parâmetros informados: mensagens do script de instalação têm ${VARIAVEL} do shell. */
function t(id, params = {}) {
  const message = CATALOGS[getLocale()]?.[id] ?? CATALOGS[FALLBACK_LOCALE][id] ?? id;
  return message.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

/** Singular e plural: as mensagens ficam em `id.one` e `id.other`. */
const tn = (id, count, params = {}) => t(`${id}.${count === 1 ? 'one' : 'other'}`, { count, ...params });

module.exports = {
  CATALOGS,
  FALLBACK_LOCALE,
  LOCALES,
  LOCALE_HEADER,
  getLocale,
  normalizeLocale,
  preferredLocale,
  setLocale,
  setLocaleProvider,
  t,
  tn,
};
