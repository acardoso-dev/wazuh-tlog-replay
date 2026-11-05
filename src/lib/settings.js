'use strict';

const { t } = require('./i18n');
const { KINDS, PROMPT_FORMATS } = require('./session_events');

const MAX_EXTRA = 50;
const MAX_EXTRA_LENGTH = 80;
// Só o comando e argumentos fixos: o texto vira parte de uma regra que roda no servidor.
const EXTRA_COMMAND = /^[\w./:+-]+( [\w./:+-]+)*$/;

const integer = (min, max) => (value) =>
  Number.isInteger(value) && value >= min && value <= max ? null : t('validation.integer', { min, max });

const subsetOf = (options, { required = false } = {}) => (value) => {
  if (!Array.isArray(value) || value.some((item) => !options.includes(item))) return t('validation.unknownOption');
  return required && value.length === 0 ? t('validation.chooseOne') : null;
};

function extraCommands(value) {
  if (!Array.isArray(value) || value.some((line) => typeof line !== 'string')) return t('validation.commandList');
  if (value.length > MAX_EXTRA) return t('validation.tooManyCommands', { max: MAX_EXTRA });
  const bad = value.find((line) => line.length > MAX_EXTRA_LENGTH || !EXTRA_COMMAND.test(line));
  return bad === undefined ? null : t('validation.badCommand', { command: bad });
}

const kindIds = KINDS.map(({ id }) => id);
const promptIds = PROMPT_FORMATS.map(({ id }) => id);

const GROUPS = [
  { id: 'detect', get title() { return t('settings.group.detect'); }, get help() { return t('settings.group.detectHelp'); } },
  { id: 'alerts', get title() { return t('settings.group.alerts'); }, help: '' },
  { id: 'timeline', get title() { return t('settings.group.timeline'); }, help: '' },
  { id: 'player', get title() { return t('settings.group.player'); }, help: '' },
];

/** Uma entrada por ajuste: a tela é montada daqui, e a validação é a mesma no navegador e no servidor. */
const SETTINGS = [
  {
    id: 'kinds',
    group: 'detect',
    type: 'multi',
    get label() { return t('settings.kinds.label'); },
    get help() { return t('settings.kinds.help'); },
    get options() { return KINDS.map(({ id, label, hint }) => ({ id, label, hint })); },
    def: kindIds,
    validate: subsetOf(kindIds),
    warn: (value) =>
      value.length < kindIds.length ? t('settings.kinds.warning') : '',
  },
  {
    id: 'extra',
    group: 'detect',
    type: 'lines',
    get label() { return t('settings.extra.label'); },
    get help() { return t('settings.extra.help'); },
    placeholder: 'kubectl delete\nterraform destroy',
    def: [],
    validate: extraCommands,
  },
  {
    id: 'prompts',
    group: 'detect',
    type: 'multi',
    get label() { return t('settings.prompts.label'); },
    get help() { return t('settings.prompts.help'); },
    get options() { return PROMPT_FORMATS.map(({ id, label, hint }) => ({ id, label, hint, mono: true })); },
    def: ['debian', 'rhel'],
    validate: subsetOf(promptIds, { required: true }),
  },
  {
    id: 'alertsEnabled',
    group: 'alerts',
    type: 'toggle',
    get label() { return t('settings.alertsEnabled.label'); },
    get help() { return t('settings.alertsEnabled.help'); },
    def: true,
    validate: (value) => (typeof value === 'boolean' ? null : t('validation.invalidValue')),
  },
  {
    id: 'idleSeconds',
    group: 'timeline',
    type: 'number',
    get label() { return t('settings.idleSeconds.label'); },
    get help() { return t('settings.idleSeconds.help'); },
    unit: 's',
    def: 30,
    validate: integer(5, 3600),
  },
  {
    id: 'pauseSeconds',
    group: 'player',
    type: 'number',
    get label() { return t('settings.pauseSeconds.label'); },
    get help() { return t('settings.pauseSeconds.help'); },
    unit: 's',
    def: 2,
    validate: integer(1, 60),
  },
];

const DEFAULT_SETTINGS = Object.freeze(Object.fromEntries(SETTINGS.map(({ id, def }) => [id, def])));

/** Mesmo valor, sem importar a ordem das opções. */
const sameValue = (a, b) =>
  JSON.stringify(Array.isArray(a) ? [...a].sort() : a) === JSON.stringify(Array.isArray(b) ? [...b].sort() : b);

function validateSettings(values) {
  const errors = {};
  for (const { id, validate } of SETTINGS) {
    const message = validate(values?.[id]);
    if (message) errors[id] = message;
  }
  return errors;
}

/** Corpo do PUT. Lança erro com a mensagem para o usuário. */
function parseSettingsBody(body) {
  const known = new Set(SETTINGS.map(({ id }) => id));
  const values = body?.values;
  if (typeof values !== 'object' || values === null || Array.isArray(values)) throw new Error(t('validation.invalidSettings'));
  const unknown = Object.keys(values).find((key) => !known.has(key));
  if (unknown) throw new Error(t('validation.unknownSetting'));
  const errors = Object.values(validateSettings(values));
  if (errors.length > 0) throw new Error(errors.join(' '));
  if (body.version !== undefined && (typeof body.version !== 'string' || body.version.length > 200)) {
    throw new Error(t('validation.invalidVersion'));
  }
  const clean = Object.fromEntries(SETTINGS.map(({ id }) => [id, values[id]]));
  clean.extra = [...new Set(clean.extra)];
  clean.kinds = [...new Set(clean.kinds)];
  clean.prompts = [...new Set(clean.prompts)];
  return { values: clean, version: body.version };
}

/** O que está gravado pode vir de outra versão: um valor inválido volta ao padrão, sem derrubar a tela. */
function mergeStored(stored) {
  return Object.fromEntries(
    SETTINGS.map(({ id, def, validate }) => {
      const value = stored?.[id];
      return [id, value !== undefined && !validate(value) ? value : def];
    })
  );
}

function displayValue(id, value) {
  const setting = SETTINGS.find((item) => item.id === id);
  if (!setting) return String(value);
  if (setting.type === 'toggle') return value ? t('settings.value.on') : t('settings.value.off');
  if (setting.type === 'multi') {
    const names = setting.options.filter((option) => value.includes(option.id)).map((option) => option.label);
    return names.length > 0 ? names.join(', ') : t('settings.value.none');
  }
  if (setting.type === 'lines') return value.length > 0 ? value.join(', ') : t('settings.value.none');
  return Number.isNaN(value) ? t('settings.value.empty') : `${value}${setting.unit ? ` ${setting.unit}` : ''}`;
}

module.exports = {
  DEFAULT_SETTINGS,
  GROUPS,
  SETTINGS,
  displayValue,
  mergeStored,
  parseSettingsBody,
  sameValue,
  validateSettings,
};
