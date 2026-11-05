'use strict';

const { ALERT_PATTERN, INDEX_PATTERN, INVENTORY_PATTERN } = require('./queries');

const RECENT_DAYS = 7;
const MAX_HOSTS = 200;
const DAY_MS = 86400000;

const statusOf = (error) => error?.output?.statusCode ?? error?.statusCode ?? error?.meta?.statusCode;
const denied = (error) => [401, 403].includes(statusOf(error));

const LOGS_BODY = (nowMs) => ({
  size: 0,
  track_total_hits: true,
  aggs: {
    hosts: {
      terms: { field: 'host', size: MAX_HOSTS, order: { last: 'desc' } },
      aggs: {
        last: { max: { field: 'time' } },
        recent: {
          filter: { range: { time: { gte: (nowMs - RECENT_DAYS * DAY_MS) / 1000 } } },
          aggs: { sessions: { cardinality: { field: 'rec' } } },
        },
      },
    },
  },
});

function parseHosts(body) {
  return (body?.aggregations?.hosts?.buckets ?? []).map((bucket) => ({
    host: bucket.key,
    lastMs: Number.isFinite(bucket.last?.value) ? bucket.last.value * 1000 : null,
    recentSessions: bucket.recent?.sessions?.value ?? 0,
  }));
}

/** Idade a partir da qual a política apaga o índice. `null` se ela não apaga por idade. */
function retentionAge(policy) {
  const states = policy?.policy?.states ?? policy?.states ?? [];
  const deleting = new Set(states.filter((state) => state.actions?.some((action) => action.delete)).map((state) => state.name));
  for (const state of states) {
    for (const transition of state.transitions ?? []) {
      if (deleting.has(transition.state_name) && transition.conditions?.min_index_age) {
        return transition.conditions.min_index_age;
      }
    }
  }
  return null;
}

async function permissionCheck(client, id, title, index, needed) {
  try {
    await client.search({ index, ignore_unavailable: true, allow_no_indices: true, body: { size: 0, query: { match_none: {} } } });
    return { id, title, status: 'ok', detail: `Seu usuário lê ${index}.` };
  } catch (error) {
    if (denied(error)) return { id, title, status: 'attention', detail: `Seu usuário não lê ${index}. ${needed}` };
    return { id, title, status: 'unknown', detail: `Não foi possível verificar ${index}.` };
  }
}

async function retentionCheck(client) {
  const title = 'Retenção';
  const unknown = (detail) => ({ id: 'retention', title, status: 'unknown', detail });
  let explain;
  try {
    explain = (await client.transport.request({ method: 'GET', path: `/_plugins/_ism/explain/${INDEX_PATTERN}` })).body;
  } catch (error) {
    return unknown(denied(error) ? 'Seu usuário não pode ver as políticas de retenção.' : 'Não foi possível consultar as políticas de retenção.');
  }
  const indices = Object.entries(explain ?? {}).filter(([name]) => name !== 'total_managed_indices');
  if (indices.length === 0) return unknown('Ainda não há índices de gravação para verificar.');
  const policyOf = ([, info]) => info?.['index.plugins.index_state_management.policy_id'] ?? info?.policy_id ?? null;
  const unmanaged = indices.filter((entry) => !policyOf(entry));
  if (unmanaged.length > 0) {
    return {
      id: 'retention',
      title,
      status: 'attention',
      detail: `${unmanaged.length} de ${indices.length} índice(s) sem política: essas gravações não são apagadas automaticamente.`,
    };
  }
  const ids = [...new Set(indices.map(policyOf))];
  let age = null;
  if (ids.length === 1) {
    try {
      const { body } = await client.transport.request({ method: 'GET', path: `/_plugins/_ism/policies/${encodeURIComponent(ids[0])}` });
      age = retentionAge(body);
    } catch {
      age = null;
    }
  }
  return {
    id: 'retention',
    title,
    status: 'ok',
    detail: `Política ${ids.join(', ')} ativa${age ? `: apaga índices com mais de ${age.replace(/^(\d+)d$/, '$1 dias')}` : ''}.`,
  };
}

/** Tudo com as permissões do usuário logado: cada item falha sozinho e diz o que não pôde ver. */
async function buildDiagnostics(client, nowMs = Date.now()) {
  const checks = [];
  let hosts = [];
  const title = 'Gravações';
  try {
    const { body } = await client.search({
      index: INDEX_PATTERN,
      ignore_unavailable: true,
      allow_no_indices: true,
      body: LOGS_BODY(nowMs),
    });
    hosts = parseHosts(body);
    const total = body?.hits?.total?.value ?? 0;
    checks.push(
      total > 0
        ? { id: 'logs', title, status: 'ok', detail: `${total} pedaço(s) de ${hosts.length} máquina(s) em ${INDEX_PATTERN}.` }
        : { id: 'logs', title, status: 'attention', detail: `Nenhuma gravação em ${INDEX_PATTERN}. Confira a coleta nas máquinas.` }
    );
  } catch (error) {
    checks.push(
      denied(error)
        ? { id: 'logs', title, status: 'attention', detail: `Seu usuário não lê ${INDEX_PATTERN}, então não vê as sessões.` }
        : { id: 'logs', title, status: 'unknown', detail: `Não foi possível consultar ${INDEX_PATTERN}.` }
    );
  }
  checks.push(
    await permissionCheck(client, 'alerts', 'Permissão nos alertas', ALERT_PATTERN, 'As sessões mostram só o que está na captura.'),
    await permissionCheck(client, 'inventory', 'Permissão no inventário', INVENTORY_PATTERN, 'O filtro por agente não funciona.'),
    await retentionCheck(client),
    {
      id: 'endpoints',
      title: 'Limites de disco nas máquinas',
      status: 'unknown',
      detail: 'O dashboard não enxerga estes limites. Confira em cada máquina, como descrito na documentação do projeto.',
    }
  );
  return { checks, hosts, recentDays: RECENT_DAYS, checkedAt: new Date(nowMs).toISOString() };
}

module.exports = { RECENT_DAYS, buildDiagnostics, parseHosts, retentionAge };
