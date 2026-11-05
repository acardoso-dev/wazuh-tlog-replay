'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const path = require('node:path');
const { FALLBACK_LOCALE, LOCALE_HEADER, normalizeLocale, setLocaleProvider, t } = require('../lib/i18n');
const { loadAssets, parseAssetFile } = require('../lib/assets');
const { convert, toCast } = require('../lib/tlog2asciicast');
const { buildInsights } = require('../lib/insights');
const { buildDiagnostics } = require('../lib/diagnostics');
const { LimiterBusyError, createLimiter } = require('../lib/limiter');
const { buildMachines, installDefaults } = require('../lib/machines');
const { parseSettingsBody } = require('../lib/settings');
const {
  SETTINGS_TYPE,
  SettingsConflictError,
  createSettingsStore,
  currentAccount,
  settingsType,
} = require('../lib/settings_store');
const {
  ACTIVITY_FIELDS,
  ALERT_PATTERN,
  INDEX_PATTERN,
  INVENTORY_PATTERN,
  buildAgentLookupBody,
  parseAgentLookup,
  MAX_MESSAGES,
  parseListParams,
  parseRec,
  buildListBody,
  parseListResponse,
  fetchAllChunks,
} = require('../lib/queries');

// O idioma vem de cada requisição. Um validador roda antes do handler e não vê a requisição, então
// suas mensagens, que a tela não provoca, saem no idioma padrão.
const requestLocale = new AsyncLocalStorage();
setLocaleProvider(() => requestLocale.getStore() ?? FALLBACK_LOCALE);

const localized = (router) => {
  const wrap = (handler) => (context, request, response) =>
    requestLocale.run(normalizeLocale(request.headers?.[LOCALE_HEADER]) ?? FALLBACK_LOCALE, () => handler(context, request, response));
  return {
    get: (config, handler) => router.get(config, wrap(handler)),
    put: (config, handler) => router.put(config, wrap(handler)),
  };
};

// Uma função de validação evita depender de @osd/config-schema em tempo de build.
const validated = (parse) => (data, result) => {
  try {
    return result.ok(parse(data));
  } catch (error) {
    return result.badRequest(error.message);
  }
};

// Quantas gravações são lidas juntas, somando todos os usuários, e quantas podem esperar a vez.
const MAX_ANALYSES = 6;
const MAX_WAITING = 200;

const failure = (logger, response, error, deniedMessage = t('server.denied')) => {
  if (error instanceof LimiterBusyError) {
    return response.customError({ statusCode: 429, body: { message: t('server.busy') } });
  }
  const statusCode = error.statusCode || error.meta?.statusCode;
  // Permissão negada no índice chega aqui como 403 e precisa continuar sendo 403.
  if (statusCode === 401 || statusCode === 403) {
    return response.customError({ statusCode, body: { message: deniedMessage } });
  }
  logger.error(`Falha ao consultar gravações: ${error.message}`);
  return response.customError({
    statusCode: 502,
    body: { message: t('server.queryFailed') },
  });
};

class TlogReplayServerPlugin {
  constructor(initializerContext) {
    this.logger = initializerContext.logger.get();
    this.repository = null;
  }

  setup(core) {
    const router = localized(core.http.createRouter());
    const { logger } = this;
    const assets = loadAssets(path.join(__dirname, '..', 'assets'));
    core.savedObjects.registerType(settingsType);
    const store = createSettingsStore({ getRepository: () => this.repository, logger });
    const limit = createLimiter({ concurrency: MAX_ANALYSES, queue: MAX_WAITING });
    // Lança 403 se o usuário logado não puder ler as gravações.
    const assertCanRead = (client) =>
      client.search({
        index: INDEX_PATTERN,
        ignore_unavailable: true,
        allow_no_indices: true,
        body: { size: 0, query: { match_none: {} } },
      });

    router.get(
      { path: '/api/tlog_replay/settings', validate: false },
      async (context, request, response) => {
        const client = context.core.opensearch.client.asCurrentUser;
        const { canEdit } = await currentAccount(client);
        if (!canEdit) {
          // As regras de detecção só interessam a quem pode ver as gravações.
          try {
            await assertCanRead(client);
          } catch (error) {
            return failure(logger, response, error);
          }
        }
        try {
          const { values, version, history } = await store.read();
          return response.ok({ body: { values, version: version ?? null, canEdit, history: canEdit ? history : [] } });
        } catch (error) {
          logger.error(`Falha ao ler as configurações: ${error.message}`);
          return response.customError({ statusCode: 502, body: { message: t('server.settingsReadFailed') } });
        }
      }
    );

    router.put(
      {
        path: '/api/tlog_replay/settings',
        validate: { body: validated(parseSettingsBody) },
      },
      async (context, request, response) => {
        const client = context.core.opensearch.client.asCurrentUser;
        const { canEdit, user } = await currentAccount(client);
        if (!canEdit) {
          return response.customError({ statusCode: 403, body: { message: t('server.settingsAdminOnly') } });
        }
        try {
          const { values, version, history } = await store.save({ ...request.body, user });
          return response.ok({ body: { values, version: version ?? null, canEdit, history } });
        } catch (error) {
          if (error instanceof SettingsConflictError) {
            return response.customError({
              statusCode: 409,
              body: { message: t('server.settingsConflict') },
            });
          }
          logger.error(`Falha ao salvar as configurações: ${error.message}`);
          return response.customError({ statusCode: 502, body: { message: t('server.settingsSaveFailed') } });
        }
      }
    );

    router.get(
      { path: '/api/tlog_replay/machines', validate: false },
      async (context, request, response) => {
        try {
          return response.ok({ body: await buildMachines(context.core.opensearch.client.asCurrentUser) });
        } catch (error) {
          return failure(logger, response, error);
        }
      }
    );

    router.get(
      { path: '/api/tlog_replay/install/defaults', validate: false },
      async (context, request, response) => {
        // Não há senha aqui, mas o nome interno do indexador não interessa a quem não usa o plugin.
        try {
          await assertCanRead(context.core.opensearch.client.asCurrentUser);
        } catch (error) {
          return failure(logger, response, error);
        }
        try {
          return response.ok({ body: await installDefaults(core.opensearch.legacy.config$) });
        } catch (error) {
          logger.error(`Falha ao ler a configuração do indexador: ${error.message}`);
          return response.ok({ body: { indexerName: '', caPem: '' } });
        }
      }
    );

    router.get(
      { path: '/api/tlog_replay/diagnostics', validate: false },
      async (context, request, response) => {
        try {
          return response.ok({ body: await buildDiagnostics(context.core.opensearch.client.asCurrentUser) });
        } catch (error) {
          return failure(logger, response, error);
        }
      }
    );

    router.get(
      {
        path: '/api/tlog_replay/assets/{name}',
        validate: { params: validated((params) => ({ name: parseAssetFile(params.name) })) },
      },
      async (context, request, response) => {
        const { name } = request.params;
        if (name === 'manifest') {
          // O manifesto é sempre revalidado: é ele que revela a versão atual.
          return response.ok({
            body: assets.manifest,
            headers: { 'cache-control': 'private, no-cache, no-store, must-revalidate' },
          });
        }
        const content = assets.files.get(name);
        if (!content) {
          return response.notFound({ body: { message: t('server.fileNotFound') } });
        }
        // O nome tem o hash do conteúdo, então a cópia guardada nunca fica desatualizada.
        return response.ok({
          body: content,
          headers: {
            'content-type': 'text/javascript; charset=utf-8',
            'cache-control': 'private, max-age=31536000, immutable',
            'x-content-type-options': 'nosniff',
          },
        });
      }
    );

    router.get(
      {
        path: '/api/tlog_replay/sessions',
        validate: { query: validated(parseListParams) },
      },
      async (context, request, response) => {
        // asCurrentUser: as permissões do índice são as do usuário logado no dashboard.
        const client = context.core.opensearch.client.asCurrentUser;
        const filters = { ...request.query };
        let agent;
        if (filters.agent) {
          try {
            const { body } = await client.search({
              index: INVENTORY_PATTERN,
              ignore_unavailable: true,
              allow_no_indices: true,
              body: buildAgentLookupBody(filters.agent),
            });
            agent = parseAgentLookup(body);
          } catch (error) {
            return failure(
              logger,
              response,
              error,
              t('server.agentDenied', { index: INVENTORY_PATTERN })
            );
          }
          // Sem hostname não há como separar as sessões do agente; nunca mostrar as de outros.
          if (!agent) {
            return response.ok({ body: { sessions: [], agent: { id: filters.agent, found: false } } });
          }
          filters.host = agent.hostname;
        }
        try {
          const { body } = await client.search({
            index: INDEX_PATTERN,
            ignore_unavailable: true,
            allow_no_indices: true,
            body: buildListBody(filters),
          });
          return response.ok({
            body: {
              sessions: parseListResponse(body),
              ...(agent ? { agent: { ...agent, found: true } } : {}),
            },
          });
        } catch (error) {
          return failure(logger, response, error);
        }
      }
    );

    router.get(
      {
        path: '/api/tlog_replay/sessions/{rec}/activity',
        validate: {
          params: validated((params) => ({ rec: parseRec(params.rec) })),
        },
      },
      async (context, request, response) => {
        const { rec } = request.params;
        try {
          const client = context.core.opensearch.client.asCurrentUser;
          const search = async (body) =>
            (
              await client.search({
                index: INDEX_PATTERN,
                ignore_unavailable: true,
                allow_no_indices: true,
                body,
              })
            ).body;

          return await limit(async () => {
            const { messages, truncated } = await fetchAllChunks(search, rec, MAX_MESSAGES, ACTIVITY_FIELDS);
            if (messages.length === 0) {
              return response.notFound({ body: { message: t('server.recordingNotFound') } });
            }
            const insights = await buildInsights({
              rec,
              messages,
              settings: await store.getValues(),
              searchLogs: search,
              searchAlerts: async (body) =>
                (
                  await client.search({
                    index: ALERT_PATTERN,
                    ignore_unavailable: true,
                    allow_no_indices: true,
                    body,
                  })
                ).body,
              onAlertError: (error) => {
                const statusCode = error.statusCode || error.meta?.statusCode;
                // Sem permissão nos alertas é uma configuração válida: a tela avisa o usuário.
                if (statusCode !== 401 && statusCode !== 403) {
                  logger.error(`Falha ao consultar alertas: ${error.message}`);
                }
              },
            });
            if (truncated) {
              insights.warnings.push(t('warning.truncatedAnalysis'));
            }
            return response.ok({ body: insights });
          });
        } catch (error) {
          return failure(logger, response, error);
        }
      }
    );

    router.get(
      {
        path: '/api/tlog_replay/sessions/{rec}',
        validate: {
          params: validated((params) => ({ rec: parseRec(params.rec) })),
        },
      },
      async (context, request, response) => {
        const { rec } = request.params;
        try {
          const client = context.core.opensearch.client.asCurrentUser;
          const search = async (body) =>
            (
              await client.search({
                index: INDEX_PATTERN,
                ignore_unavailable: true,
                allow_no_indices: true,
                body,
              })
            ).body;

          return await limit(async () => {
            const { messages, truncated } = await fetchAllChunks(search, rec);
            if (messages.length === 0) {
              return response.notFound({ body: { message: t('server.recordingNotFound') } });
            }

            const result = convert(messages);
            const warnings = [...result.warnings];
            if (truncated) {
              warnings.push(t('warning.truncatedReplay'));
            }
            // Gravações podem conter dados sensíveis: fica registrado quem assistiu a cada uma.
            const { user } = await currentAccount(client);
            logger.info(`Replay aberto: ${JSON.stringify({ user, rec, host: messages[0].host ?? null, recordedUser: messages[0].user ?? null })}`);
            return response.ok({
              body: {
                rec,
                cast: toCast(result),
                durationSeconds: result.durationSeconds,
                width: result.header.width,
                height: result.header.height,
                messageCount: result.messageCount,
                warnings,
              },
            });
          });
        } catch (error) {
          return failure(logger, response, error);
        }
      }
    );

    return {};
  }

  start(core) {
    this.repository = core.savedObjects.createInternalRepository([SETTINGS_TYPE]);
    return {};
  }

  stop() {}
}

exports.plugin = (initializerContext) => new TlogReplayServerPlugin(initializerContext);
exports.localized = localized;
