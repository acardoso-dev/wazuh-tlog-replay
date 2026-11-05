'use strict';

const { KINDS, PROMPT_FORMATS } = require('./session_events');

const MAX_EXTRA = 50;
const MAX_EXTRA_LENGTH = 80;
// Só o comando e argumentos fixos: o texto vira parte de uma regra que roda no servidor.
const EXTRA_COMMAND = /^[\w./:+-]+( [\w./:+-]+)*$/;

const integer = (min, max) => (value) =>
  Number.isInteger(value) && value >= min && value <= max ? null : `Use um número inteiro de ${min} a ${max}.`;

const subsetOf = (options, { required = false } = {}) => (value) => {
  if (!Array.isArray(value) || value.some((item) => !options.includes(item))) return 'Opção desconhecida.';
  return required && value.length === 0 ? 'Escolha pelo menos uma opção.' : null;
};

function extraCommands(value) {
  if (!Array.isArray(value) || value.some((line) => typeof line !== 'string')) return 'Informe uma lista de comandos.';
  if (value.length > MAX_EXTRA) return `Use no máximo ${MAX_EXTRA} comandos.`;
  const bad = value.find((line) => line.length > MAX_EXTRA_LENGTH || !EXTRA_COMMAND.test(line));
  return bad === undefined ? null : `"${bad}" não é válido: use só o comando e seus argumentos fixos, sem expressão regular.`;
}

const kindIds = KINDS.map(({ id }) => id);
const promptIds = PROMPT_FORMATS.map(({ id }) => id);

const GROUPS = [
  { id: 'detect', title: 'Detecção', help: 'Vale também para gravações antigas, porque a detecção roda na leitura.' },
  { id: 'alerts', title: 'Alertas do Wazuh', help: '' },
  { id: 'timeline', title: 'Timeline', help: '' },
  { id: 'player', title: 'Player', help: '' },
];

/** Uma entrada por ajuste: a tela é montada daqui, e a validação é a mesma no navegador e no servidor. */
const SETTINGS = [
  {
    id: 'kinds',
    group: 'detect',
    type: 'multi',
    label: 'Tipos reconhecidos',
    help: 'Desligar um tipo o remove dos pontos, chips e filtros.',
    options: KINDS.map(({ id, label, hint }) => ({ id, label, hint })),
    def: kindIds,
    validate: subsetOf(kindIds),
    warn: (value) =>
      value.length < kindIds.length ? 'Com um tipo desligado, esses comandos deixam de aparecer para todos os usuários.' : '',
  },
  {
    id: 'extra',
    group: 'detect',
    type: 'lines',
    label: 'Comandos críticos extras',
    help: 'Um por linha. Entram como Destrutivo e também valem com sudo na frente.',
    placeholder: 'kubectl delete\nterraform destroy',
    def: [],
    validate: extraCommands,
  },
  {
    id: 'prompts',
    group: 'detect',
    type: 'multi',
    label: 'Formatos de prompt',
    help: 'A detecção só lê linhas com um destes prompts. Comandos em outros formatos não são vistos.',
    options: PROMPT_FORMATS.map(({ id, label, hint }) => ({ id, label, hint, mono: true })),
    def: ['debian', 'rhel'],
    validate: subsetOf(promptIds, { required: true }),
  },
  {
    id: 'alertsEnabled',
    group: 'alerts',
    type: 'toggle',
    label: 'Ligar comandos aos alertas',
    help: 'Desligado, as sessões mostram só o que está na captura, e o plugin não consulta os alertas. O fim da sessão passa a ser a última saída gravada.',
    def: true,
    validate: (value) => (typeof value === 'boolean' ? null : 'Valor inválido.'),
  },
  {
    id: 'idleSeconds',
    group: 'timeline',
    type: 'number',
    label: 'Tempo para considerar ociosa',
    help: 'Pausa sem dados gravados que aparece como ociosa na timeline.',
    unit: 's',
    def: 30,
    validate: integer(5, 3600),
  },
  {
    id: 'pauseSeconds',
    group: 'player',
    type: 'number',
    label: 'Pausa máxima no replay',
    help: 'Pausas maiores são encurtadas para este valor. O salto pelos horários continua certo.',
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
  if (typeof values !== 'object' || values === null || Array.isArray(values)) throw new Error('Configurações inválidas.');
  const unknown = Object.keys(values).find((key) => !known.has(key));
  if (unknown) throw new Error('Configuração desconhecida.');
  const errors = Object.values(validateSettings(values));
  if (errors.length > 0) throw new Error(errors.join(' '));
  if (body.version !== undefined && (typeof body.version !== 'string' || body.version.length > 200)) {
    throw new Error('Versão inválida.');
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
  if (setting.type === 'toggle') return value ? 'Ligado' : 'Desligado';
  if (setting.type === 'multi') {
    const names = setting.options.filter((option) => value.includes(option.id)).map((option) => option.label);
    return names.length > 0 ? names.join(', ') : 'nenhum';
  }
  if (setting.type === 'lines') return value.length > 0 ? value.join(', ') : 'nenhum';
  return Number.isNaN(value) ? 'vazio' : `${value}${setting.unit ? ` ${setting.unit}` : ''}`;
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
