'use strict';

const { DEFAULT_SETTINGS, SETTINGS, mergeStored, sameValue } = require('./settings');

const SETTINGS_TYPE = 'tlog-replay-settings';
const SETTINGS_ID = 'global';
const MAX_HISTORY = 20;
// A análise de sessões lê os ajustes a cada linha da lista.
const CACHE_MS = 5000;
const EDITOR_ROLES = ['all_access', 'tlog_replay_admin'];

/**
 * Oculto: fica fora da API e da tela de saved objects, então só as rotas do plugin o alteram.
 * Sem namespace e lido pelo cliente interno: é o mesmo para todos os tenants e espaços.
 */
const settingsType = {
  name: SETTINGS_TYPE,
  hidden: true,
  namespaceType: 'agnostic',
  mappings: { dynamic: false, properties: {} },
};

const statusOf = (error) => error?.output?.statusCode ?? error?.statusCode ?? error?.meta?.statusCode;

class SettingsConflictError extends Error {}

function createSettingsStore({ getRepository, logger, now = Date.now }) {
  let cached = null;
  let cachedAt = 0;

  async function read() {
    const repository = getRepository();
    if (!repository) throw new Error('Repositório indisponível.');
    try {
      const { attributes, version } = await repository.get(SETTINGS_TYPE, SETTINGS_ID);
      return {
        values: mergeStored(attributes.values),
        version,
        history: Array.isArray(attributes.history) ? attributes.history : [],
      };
    } catch (error) {
      if (statusOf(error) === 404) return { values: mergeStored(), version: undefined, history: [] };
      throw error;
    }
  }

  /** Para a análise: sem conseguir ler, usa o padrão, que é o que detecta mais. */
  async function getValues() {
    if (cached && now() - cachedAt < CACHE_MS) return cached;
    try {
      cached = (await read()).values;
    } catch (error) {
      logger.error(`Falha ao ler as configurações, usando o padrão: ${error.message}`);
      cached = DEFAULT_SETTINGS;
    }
    cachedAt = now();
    return cached;
  }

  async function save({ values, version, user }) {
    const current = await read();
    // Sem esta verificação, salvar uma tela antiga desfaria a alteração de outro administrador.
    if (current.version !== version) throw new SettingsConflictError();
    const changes = SETTINGS.filter(({ id }) => !sameValue(current.values[id], values[id])).map(({ id }) => ({
      id,
      from: current.values[id],
      to: values[id],
    }));
    if (changes.length === 0) return current;
    const entry = { at: new Date(now()).toISOString(), user, changes };
    const history = [entry, ...current.history].slice(0, MAX_HISTORY);
    let saved;
    try {
      saved = await getRepository().create(SETTINGS_TYPE, { values, history }, {
        id: SETTINGS_ID,
        overwrite: version !== undefined,
        ...(version !== undefined ? { version } : {}),
      });
    } catch (error) {
      if (statusOf(error) === 409) throw new SettingsConflictError();
      throw error;
    }
    cached = values;
    cachedAt = now();
    logger.info(`Configurações do Session Replay alteradas por ${JSON.stringify(user)}: ${JSON.stringify(changes)}`);
    return { values, version: saved.version, history };
  }

  return { getValues, read, save };
}

/** Papéis vêm do indexador, com as credenciais do próprio usuário. Em caso de dúvida, nega. */
async function currentAccount(client) {
  try {
    const { body } = await client.transport.request({ method: 'GET', path: '/_plugins/_security/api/account' });
    const roles = Array.isArray(body?.roles) ? body.roles : [];
    return {
      user: typeof body?.user_name === 'string' ? body.user_name : 'desconhecido',
      canEdit: roles.some((role) => EDITOR_ROLES.includes(role)),
    };
  } catch {
    return { user: 'desconhecido', canEdit: false };
  }
}

module.exports = { EDITOR_ROLES, SETTINGS_ID, SETTINGS_TYPE, SettingsConflictError, createSettingsStore, currentAccount, settingsType };
