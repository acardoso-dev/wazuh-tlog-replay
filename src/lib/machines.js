'use strict';

const { INDEX_PATTERN, INVENTORY_PATTERN } = require('./queries');

const PACKAGES_PATTERN = 'wazuh-states-inventory-packages-*';
const REQUIRED_PACKAGES = ['tlog', 'fluent-bit'];
const MAX_MACHINES = 500;
// As mesmas distribuições que o script de instalação aceita.
const SCRIPT_PLATFORMS = ['ubuntu', 'debian', 'kali'];

const denied = (error) => [401, 403].includes(error?.statusCode ?? error?.meta?.statusCode);

function machineStatus({ platform, packages, recording, packagesVisible }) {
  if (recording) return 'recording';
  if (platform && !SCRIPT_PLATFORMS.includes(platform)) return platform === 'darwin' || platform === 'windows' ? 'unsupported' : 'manual';
  if (!packagesVisible) return 'unknown';
  const missing = REQUIRED_PACKAGES.filter((name) => !packages.includes(name));
  if (missing.length === 0) return 'installed';
  return missing.length === REQUIRED_PACKAGES.length ? 'missing' : 'partial';
}

/**
 * Situação de cada agente, com as permissões do usuário logado. O inventário de pacotes é
 * atualizado de tempos em tempos, então uma instalação recente pode levar alguns minutos para aparecer.
 */
async function buildMachines(client) {
  const search = (index, body) => client.search({ index, ignore_unavailable: true, allow_no_indices: true, body });
  let inventory;
  try {
    inventory = (
      await search(INVENTORY_PATTERN, {
        size: MAX_MACHINES,
        track_total_hits: true,
        _source: ['agent.id', 'agent.name', 'host.hostname', 'host.os.name', 'host.os.platform', 'host.os.version', 'host.architecture'],
      })
    ).body;
  } catch (error) {
    if (denied(error)) return { machines: [], inventoryVisible: false, packagesVisible: false };
    throw error;
  }

  const packagesByAgent = new Map();
  let packagesVisible = true;
  try {
    const { body } = await search(PACKAGES_PATTERN, {
      size: MAX_MACHINES * REQUIRED_PACKAGES.length,
      _source: ['agent.id', 'package.name'],
      query: { terms: { 'package.name': REQUIRED_PACKAGES } },
    });
    for (const { _source: source } of body.hits?.hits ?? []) {
      const id = source.agent?.id;
      if (!packagesByAgent.has(id)) packagesByAgent.set(id, []);
      packagesByAgent.get(id).push(source.package?.name);
    }
  } catch (error) {
    if (!denied(error)) throw error;
    packagesVisible = false;
  }

  const recordedHosts = new Set();
  try {
    const { body } = await search(INDEX_PATTERN, { size: 0, aggs: { hosts: { terms: { field: 'host', size: MAX_MACHINES } } } });
    for (const bucket of body.aggregations?.hosts?.buckets ?? []) recordedHosts.add(bucket.key);
  } catch (error) {
    if (!denied(error)) throw error;
  }

  const machines = (inventory.hits?.hits ?? [])
    .map(({ _source: source }) => {
      const id = source.agent?.id ?? null;
      const hostname = source.host?.hostname ?? null;
      const platform = source.host?.os?.platform ?? null;
      return {
        id,
        name: source.agent?.name ?? null,
        hostname,
        os: [source.host?.os?.name, source.host?.os?.version].filter(Boolean).join(' '),
        platform,
        architecture: source.host?.architecture ?? null,
        status: machineStatus({
          platform,
          packages: packagesByAgent.get(id) ?? [],
          recording: recordedHosts.has(hostname),
          packagesVisible,
        }),
      };
    })
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return { machines, inventoryVisible: true, packagesVisible, truncated: (inventory.hits?.total?.value ?? 0) > MAX_MACHINES };
}

/** Nome do indexador e CA que o próprio dashboard usa, para adiantar o formulário. */
async function installDefaults(opensearchConfig$) {
  const config = await new Promise((resolve, reject) => {
    const subscription = opensearchConfig$.subscribe({
      next: (value) => {
        resolve(value);
        setTimeout(() => subscription?.unsubscribe(), 0);
      },
      error: reject,
    });
  });
  let indexerName = '';
  try {
    indexerName = new URL([config.hosts].flat()[0]).hostname;
  } catch {
    indexerName = '';
  }
  const authorities = config.ssl?.certificateAuthorities;
  const caPem = [authorities].flat().find((item) => typeof item === 'string' && item.includes('BEGIN CERTIFICATE')) ?? '';
  return { indexerName, caPem };
}

module.exports = { buildMachines, installDefaults, machineStatus };
