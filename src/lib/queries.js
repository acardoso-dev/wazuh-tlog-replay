'use strict';

const { isoFromSeconds } = require('./safe_time');

const INDEX_PATTERN = 'tlog-*';
const INVENTORY_PATTERN = 'wazuh-states-inventory-system-*';
const PAGE_SIZE = 500;
const MAX_MESSAGES = 20000;
// Quantidade de pedaços não limita memória: um documento forjado pode ter qualquer tamanho.
const MAX_OUTPUT_CHARS = 64 * 1024 * 1024;
const MAX_SESSIONS = 500;
const DEFAULT_SESSIONS = 100;

const REC_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

// Só a saída é lida. A entrada pode conter senhas e nunca sai do índice por esta API.
const CHUNK_FIELDS = ['id', 'pos', 'time', 'timing', 'out_txt', 'out_bin', 'host', 'user', 'term', 'rec'];
// A timeline usa os tempos, e a busca de comandos críticos precisa da saída. A entrada nunca é lida.
const ACTIVITY_FIELDS = ['id', 'pos', 'time', 'timing', 'out_txt', 'out_bin', 'host', 'user', 'session'];
const ALERT_PATTERN = 'wazuh-alerts-*';
const ALERT_FIELDS = [
  'timestamp',
  'rule.id',
  'rule.level',
  'rule.description',
  'rule.groups',
  'rule.mitre.id',
  'data.srcuser',
  'data.dstuser',
  'data.srcip',
  'full_log',
];
const MAX_ALERTS = 500;
const DAY_MS = 86400000;

function optionalString(value, name, maxLength) {
  if (value === undefined || value === '') {
    return undefined;
  }
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new Error(`parâmetro "${name}" inválido`);
  }
  return value;
}

function optionalDate(value, name) {
  const text = optionalString(value, name, 64);
  if (text === undefined) {
    return undefined;
  }
  if (Number.isNaN(Date.parse(text))) {
    throw new Error(`parâmetro "${name}" não é uma data válida`);
  }
  return new Date(text).toISOString();
}

function parseListParams(query = {}) {
  let size = DEFAULT_SESSIONS;
  if (query.size !== undefined && query.size !== '') {
    size = Number(query.size);
    if (!Number.isInteger(size) || size < 1 || size > MAX_SESSIONS) {
      throw new Error(`"size" deve estar entre 1 e ${MAX_SESSIONS}`);
    }
  }
  const agent = optionalString(query.agent, 'agent', 10);
  if (agent !== undefined && !/^\d+$/.test(agent)) {
    throw new Error('parâmetro "agent" inválido');
  }
  return {
    agent,
    host: optionalString(query.host, 'host', 256),
    user: optionalString(query.user, 'user', 256),
    q: optionalString(query.q, 'q', 512),
    from: optionalDate(query.from, 'from'),
    to: optionalDate(query.to, 'to'),
    size,
  };
}

function parseRec(rec) {
  if (typeof rec !== 'string' || !REC_PATTERN.test(rec)) {
    throw new Error('identificador de gravação inválido');
  }
  return rec;
}

function buildListBody({ host, user, q, from, to, size }) {
  const filter = [];
  if (host) filter.push({ term: { host } });
  if (user) filter.push({ term: { user } });
  if (from || to) {
    // Vale a hora gravada pelo tlog (`time`, em segundos), não a de chegada ao índice: uma
    // máquina que ficou offline envia tudo depois. Versões sem `time` usam @timestamp.
    const seconds = (value) => Date.parse(value) / 1000;
    filter.push({
      bool: {
        should: [
          { range: { time: { ...(from ? { gte: seconds(from) } : {}), ...(to ? { lte: seconds(to) } : {}) } } },
          {
            bool: {
              must_not: [{ exists: { field: 'time' } }],
              filter: [{ range: { '@timestamp': { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } }],
            },
          },
        ],
        minimum_should_match: 1,
      },
    });
  }
  const must = q ? [{ match_phrase: { out_txt: q } }] : [];

  return {
    size: 0,
    query: { bool: { filter, must } },
    aggs: {
      sessions: {
        terms: { field: 'rec', size, order: { last_seen: 'desc' } },
        aggs: {
          first_seen: { min: { field: '@timestamp' } },
          last_seen: { max: { field: '@timestamp' } },
          first_time: { min: { field: 'time' } },
          max_pos: { max: { field: 'pos' } },
          max_id: { max: { field: 'id' } },
          details: {
            top_hits: { size: 1, sort: [{ id: 'asc' }], _source: ['host', 'user', 'term'] },
          },
        },
      },
    },
  };
}

function parseListResponse(body) {
  const buckets = body?.aggregations?.sessions?.buckets ?? [];
  return buckets.map((bucket) => {
    const source = bucket.details?.hits?.hits?.[0]?._source ?? {};
    const firstTime = bucket.first_time?.value;
    const maxPos = bucket.max_pos?.value;
    return {
      rec: bucket.key,
      host: source.host ?? null,
      user: source.user ?? null,
      term: source.term ?? null,
      startedAt: isoFromSeconds(firstTime) ?? bucket.first_seen?.value_as_string ?? null,
      // Início do último pedaço: não conta o que acontece dentro dele, por isso é aproximada.
      durationSeconds: Number.isFinite(maxPos) ? maxPos / 1000 : null,
      messages: bucket.doc_count,
      maxId: bucket.max_id?.value ?? null,
    };
  });
}

/** O tlog grava o hostname da máquina, que pode ser diferente do nome do agente. */
function buildAgentLookupBody(id) {
  return {
    size: 1,
    _source: ['agent.id', 'agent.name', 'host.hostname'],
    query: { bool: { filter: [{ term: { 'agent.id': id } }] } },
  };
}

function parseAgentLookup(body) {
  const source = body?.hits?.hits?.[0]?._source;
  const hostname = source?.host?.hostname;
  if (!hostname) {
    return null;
  }
  return { id: source.agent?.id ?? null, name: source.agent?.name ?? null, hostname };
}

function buildChunkBody(rec, searchAfter, fields = CHUNK_FIELDS) {
  return {
    size: PAGE_SIZE,
    _source: fields,
    query: { bool: { filter: [{ term: { rec } }] } },
    sort: [{ id: 'asc' }],
    ...(searchAfter ? { search_after: searchAfter } : {}),
  };
}

const iso = (ms) => new Date(ms).toISOString();

// O tlog grava o hostname. Nos alertas, ele vem no log ou é o nome do agente.
const alertHostFilter = (host) => ({
  bool: {
    should: [{ term: { 'agent.name': host } }, { term: { 'predecoder.hostname': host } }],
    minimum_should_match: 1,
  },
});

const alertRange = (fromMs, toMs) => ({ range: { timestamp: { gte: iso(fromMs), lte: iso(toMs) } } });

/** Logins do usuário perto do início da sessão. */
function buildLoginAlertsBody({ host, user, startMs }) {
  return {
    size: 20,
    _source: ALERT_FIELDS,
    sort: [{ timestamp: 'asc' }],
    query: {
      bool: {
        filter: [
          alertHostFilter(host),
          { term: { 'rule.id': '5715' } },
          { term: { 'data.dstuser': user } },
          alertRange(startMs - 6000, startMs + 6000),
        ],
      },
    },
  };
}

/** Encerramento do mesmo processo do sshd. A sessão pode ter ficado aberta e ociosa por dias. */
function buildCloseAlertBody({ host, pid, fromMs }) {
  return {
    size: 1,
    _source: ['timestamp'],
    sort: [{ timestamp: 'asc' }],
    query: {
      bool: {
        filter: [alertHostFilter(host), { term: { 'rule.id': '5502' } }, alertRange(fromMs, fromMs + 7 * DAY_MS)],
        must: [{ match_phrase: { full_log: `sshd[${pid}]` } }],
      },
    },
  };
}

/** Alertas de sudo, login e senha errada no período da sessão. */
function buildSessionAlertsBody({ host, fromMs, toMs }) {
  return {
    size: MAX_ALERTS,
    _source: ALERT_FIELDS,
    sort: [{ timestamp: 'asc' }],
    query: {
      bool: {
        filter: [
          alertHostFilter(host),
          alertRange(fromMs, toMs),
          {
            bool: {
              should: [{ term: { 'rule.groups': 'sudo' } }, { terms: { 'rule.id': ['5715', '5503'] } }],
              minimum_should_match: 1,
            },
          },
        ],
      },
    },
  };
}

/** Início de cada gravação. Fica fora da consulta anterior, que só enxerga os pedaços do período. */
function buildSessionStartsBody(recs) {
  return {
    size: 0,
    query: { bool: { filter: [{ terms: { rec: recs } }] } },
    aggs: { sessions: { terms: { field: 'rec', size: recs.length }, aggs: { first_time: { min: { field: 'time' } } } } },
  };
}

/** Outras gravações da máquina no período. */
function buildOverlapBody({ host, rec, fromMs, toMs }) {
  return {
    size: 0,
    query: {
      bool: {
        filter: [{ term: { host } }, { range: { time: { gte: fromMs / 1000, lte: toMs / 1000 } } }],
        must_not: [{ term: { rec } }],
      },
    },
    aggs: {
      sessions: {
        terms: { field: 'rec', size: 20 },
        aggs: { details: { top_hits: { size: 1, sort: [{ id: 'asc' }], _source: ['user'] } } },
      },
    },
  };
}

function parseOverlaps(body) {
  return (body?.aggregations?.sessions?.buckets ?? []).map((bucket) => ({
    rec: bucket.key,
    user: bucket.details?.hits?.hits?.[0]?._source?.user ?? null,
  }));
}

function parseSessionStarts(body) {
  return (body?.aggregations?.sessions?.buckets ?? [])
    .filter((bucket) => Number.isFinite(bucket.first_time?.value))
    .map((bucket) => ({ rec: bucket.key, startMs: bucket.first_time.value * 1000 }));
}

/** Gravação que começou logo depois de um login. */
function buildSessionAtBody({ host, user, rec, atMs }) {
  return {
    size: 1,
    _source: ['rec', 'time', 'pos'],
    sort: [{ id: 'asc' }],
    query: {
      bool: {
        filter: [{ term: { host } }, { term: { user } }, { range: { time: { gte: (atMs - 6000) / 1000, lte: (atMs + 6000) / 1000 } } }],
        must_not: [{ term: { rec } }],
      },
    },
  };
}

/** Lê todos os pedaços de uma gravação. `search` recebe o corpo e devolve a resposta. */
async function fetchAllChunks(search, rec, maxMessages = MAX_MESSAGES, fields = CHUNK_FIELDS, maxChars = MAX_OUTPUT_CHARS) {
  const messages = [];
  let chars = 0;
  let searchAfter;
  for (;;) {
    const body = await search(buildChunkBody(rec, searchAfter, fields));
    const hits = body?.hits?.hits ?? [];
    for (const hit of hits) {
      messages.push(hit._source);
      chars += (hit._source?.out_txt?.length ?? 0) + (hit._source?.out_bin?.length ?? 0);
    }
    if (chars > maxChars) {
      return { messages, truncated: true };
    }
    if (messages.length >= maxMessages) {
      return { messages: messages.slice(0, maxMessages), truncated: true };
    }
    if (hits.length < PAGE_SIZE) {
      return { messages, truncated: false };
    }
    searchAfter = hits[hits.length - 1].sort;
  }
}

module.exports = {
  ACTIVITY_FIELDS,
  ALERT_PATTERN,
  buildCloseAlertBody,
  buildLoginAlertsBody,
  buildOverlapBody,
  buildSessionAlertsBody,
  buildSessionAtBody,
  buildSessionStartsBody,
  parseOverlaps,
  parseSessionStarts,
  INDEX_PATTERN,
  INVENTORY_PATTERN,
  buildAgentLookupBody,
  parseAgentLookup,
  MAX_MESSAGES,
  MAX_OUTPUT_CHARS,
  PAGE_SIZE,
  parseListParams,
  parseRec,
  buildListBody,
  parseListResponse,
  buildChunkBody,
  fetchAllChunks,
};
