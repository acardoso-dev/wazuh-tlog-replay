'use strict';

const { t } = require('./i18n');
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
    return { id, title, status: 'ok', detail: t('check.canRead', { index }) };
  } catch (error) {
    if (denied(error)) return { id, title, status: 'attention', detail: t('check.cannotRead', { index, needed }) };
    return { id, title, status: 'unknown', detail: t('check.failed', { index }) };
  }
}

async function retentionCheck(client) {
  const title = t('check.retention.title');
  const unknown = (detail) => ({ id: 'retention', title, status: 'unknown', detail });
  let explain;
  try {
    explain = (await client.transport.request({ method: 'GET', path: `/_plugins/_ism/explain/${INDEX_PATTERN}` })).body;
  } catch (error) {
    return unknown(denied(error) ? t('check.retention.denied') : t('check.retention.failed'));
  }
  const indices = Object.entries(explain ?? {}).filter(([name]) => name !== 'total_managed_indices');
  if (indices.length === 0) return unknown(t('check.retention.noIndices'));
  const policyOf = ([, info]) => info?.['index.plugins.index_state_management.policy_id'] ?? info?.policy_id ?? null;
  const unmanaged = indices.filter((entry) => !policyOf(entry));
  if (unmanaged.length > 0) {
    return {
      id: 'retention',
      title,
      status: 'attention',
      detail: t('check.retention.unmanaged', { count: unmanaged.length, total: indices.length }),
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
    detail: age ? t('check.retention.activeAge', { policy: ids.join(', '), age: age.replace(/^(\d+)d$/, (match, days) => t('check.retention.days', { days })) }) : t('check.retention.active', { policy: ids.join(', ') }),
  };
}

/** Tudo com as permissões do usuário logado: cada item falha sozinho e diz o que não pôde ver. */
async function buildDiagnostics(client, nowMs = Date.now()) {
  const checks = [];
  let hosts = [];
  const title = t('check.logs.title');
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
        ? { id: 'logs', title, status: 'ok', detail: t('check.logs.ok', { total, hosts: hosts.length, index: INDEX_PATTERN }) }
        : { id: 'logs', title, status: 'attention', detail: t('check.logs.empty', { index: INDEX_PATTERN }) }
    );
  } catch (error) {
    checks.push(
      denied(error)
        ? { id: 'logs', title, status: 'attention', detail: t('check.logs.denied', { index: INDEX_PATTERN }) }
        : { id: 'logs', title, status: 'unknown', detail: t('check.logs.failed', { index: INDEX_PATTERN }) }
    );
  }
  checks.push(
    await permissionCheck(client, 'alerts', t('check.alerts.title'), ALERT_PATTERN, t('check.alerts.needed')),
    await permissionCheck(client, 'inventory', t('check.inventory.title'), INVENTORY_PATTERN, t('check.inventory.needed')),
    await retentionCheck(client),
    {
      id: 'endpoints',
      title: t('check.endpoints.title'),
      status: 'unknown',
      detail: t('check.endpoints.detail'),
    }
  );
  return { checks, hosts, recentDays: RECENT_DAYS, checkedAt: new Date(nowMs).toISOString() };
}

module.exports = { RECENT_DAYS, buildDiagnostics, parseHosts, retentionAge };
