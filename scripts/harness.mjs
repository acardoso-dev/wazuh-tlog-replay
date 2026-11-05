// Ambiente local de teste: simula o OpenSearch Dashboards ao redor do plugin compilado.
// Carrega dist/stage como o dashboard faria, com router, cliente e CSP falsos.
// NÃO substitui o teste em um Wazuh real.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = join(root, 'dist/stage/opensearch-dashboards/tlogReplay');
const require = createRequire(import.meta.url);
const PORT = Number(process.env.PORT || 5687);

// Mesma política padrão de src/core/server/csp/config.ts do OpenSearch Dashboards 2.19.
const CSP = "script-src 'unsafe-eval' 'self'; worker-src blob: 'self'; style-src 'unsafe-inline' 'self'";

/* ---------- índice falso em memória ---------- */
// HARNESS_DEMO tira os dados de ataque, usados para testar a tela, das imagens da documentação.
const DEMO = Boolean(process.env.HARNESS_DEMO);
const real = readFileSync(join(root, 'samples/real-session.log'), 'utf8').trim().split('\n').map(JSON.parse);
const base = Date.parse('2026-11-04T12:00:00Z');
const copy = (rec, host, user, offsetMinutes, keep = () => true) =>
  real.filter(keep).map((message) => ({
    ...message,
    rec,
    host,
    user,
    '@timestamp': new Date(base + offsetMinutes * 60000 + message.pos).toISOString(),
  }));
// Sessão com pausas longas, para exercitar a timeline.
const idleStart = Date.parse('2026-11-04T12:45:00Z');
const idleSession = [
  [1, 0, '=120x30>1+900>1+1200>1+2000>1'],
  [2, 90000, '=120x30>1+5000>1+6000>1+4000>1'],
  [3, 240000, '=120x30>1'],
  [4, 245000, '=120x30>1+9000>1+8000>1'],
  [5, 372000, '=120x30>1+3000>1'],
].map(([id, pos, timing]) => ({
  id,
  pos,
  timing,
  time: (idleStart + pos) / 1000,
  out_txt: 'x'.repeat(4),
  rec: 'sessao-ociosa-4',
  host: 'web01',
  user: 'bia',
  '@timestamp': new Date(idleStart + pos).toISOString(),
}));
// Pausas longas entre os comandos: o player as comprime, e o salto precisa cair no ponto certo.
const pausedStart = Date.parse('2026-11-04T13:00:00Z');
const pausedSession = [
  [1, 0, 'caio@web:~$ '],
  [2, 100000, 'sudo id\r\nANTES-DA-PAUSA\r\ncaio@web:~$ '],
  [3, 300000, 'rm -rf /tmp/x\r\nDEPOIS-DA-PAUSA\r\ncaio@web:~$ '],
  [4, 500000, 'FIM-DA-SESSAO\r\n'],
].map(([id, pos, out_txt]) => ({
  id,
  pos,
  timing: `=80x24>${Array.from(out_txt).length}`,
  time: (pausedStart + pos) / 1000,
  out_txt,
  rec: 'sessao-pausas-5',
  host: 'web01',
  user: 'caio',
  '@timestamp': new Date(pausedStart + pos).toISOString(),
}));
// Sessões e alertas reais do ambiente de teste, com sudo, salto SSH e comandos destrutivos.
const critical = readFileSync(join(root, 'samples/critical-session.log'), 'utf8').trim().split('\n').map(JSON.parse).map((message) => ({ ...message, '@timestamp': new Date(message.time * 1000).toISOString() }));
const alertDocs = JSON.parse(readFileSync(join(root, 'samples/critical-alerts.json'), 'utf8'));
const documents = [
  ...critical,
  ...pausedSession,
  ...idleSession,
  ...copy('real-session-1', 'web01', 'ana', 30),
  // Sem os pedaços 2 e 3, para exercitar o aviso de gravação incompleta.
  ...copy('sessao-incompleta-2', 'db01', 'root', 10, (message) => message.id !== 2 && message.id !== 3),
  // Nomes hostis: precisam aparecer como texto, nunca como HTML.
  ...(DEMO ? [] : copy('sessao-hostil-3', '<img src=x onerror=window.__xss=1>', '<b>mallory</b>', 0)),
];

const inventory = [{ agent: { id: '003', name: DEMO ? 'web01' : 'nome-do-agente' }, host: { hostname: 'web01' } }];
const machineInventory = [
  { agent: { id: '001', name: 'estacao-mac' }, host: { hostname: 'estacao-mac', architecture: 'arm64', os: { name: 'macOS', version: '27.2', platform: 'darwin' } } },
  { agent: { id: '003', name: DEMO ? 'web01' : 'nome-do-agente' }, host: { hostname: 'web01', architecture: 'aarch64', os: { name: 'Ubuntu', version: '24.04', platform: 'ubuntu' } } },
  { agent: { id: '004', name: 'kali-arm64' }, host: { hostname: 'kali', architecture: 'aarch64', os: { name: 'Kali GNU/Linux', version: '2026.3', platform: 'kali' } } },
  { agent: { id: '005', name: DEMO ? 'app01' : '<b>hostil</b>' }, host: { hostname: 'parcial', architecture: 'x86_64', os: { name: 'Debian', version: '12', platform: 'debian' } } },
  { agent: { id: '006', name: 'centos' }, host: { hostname: 'centos', architecture: 'x86_64', os: { name: 'CentOS', version: '9', platform: 'centos' } } },
];

const getPath = (document, path) => path.split('.').reduce((value, key) => value?.[key], document);
function matchesClause(document, clause) {
  if (clause.term) return [getPath(document, Object.keys(clause.term)[0])].flat().includes(Object.values(clause.term)[0]);
  if (clause.terms) return [getPath(document, Object.keys(clause.terms)[0])].flat().some((value) => Object.values(clause.terms)[0].includes(value));
  if (clause.range) {
    const [[field, { gte, lte }]] = Object.entries(clause.range);
    const raw = getPath(document, field);
    if (raw === undefined) return false;
    const value = typeof gte === 'number' ? raw : Date.parse(raw);
    const bound = (limit) => (typeof limit === 'number' ? limit : Date.parse(limit));
    return (gte === undefined || value >= bound(gte)) && (lte === undefined || value <= bound(lte));
  }
  if (clause.match_phrase) return String(getPath(document, Object.keys(clause.match_phrase)[0]) ?? '').includes(Object.values(clause.match_phrase)[0]);
  if (clause.bool) return (clause.bool.should ?? []).some((item) => matchesClause(document, item));
  return true;
}

// Sem esta variável, a tela de configurações permite salvar, como para um administrador.
const HARNESS_ROLES = process.env.HARNESS_READONLY ? ['tlog_reader'] : ['all_access'];
function transportRequest({ path }) {
  if (path.includes('/_security/api/account')) return { body: { user_name: 'admin-harness', roles: HARNESS_ROLES } };
  if (path.includes('/_ism/explain/')) {
    return { body: { 'tlog-2026.11': { 'index.plugins.index_state_management.policy_id': 'tlog-retention' }, total_managed_indices: 1 } };
  }
  if (path.includes('/_ism/policies/')) {
    return { body: { policy: { states: [
      { name: 'retido', actions: [], transitions: [{ state_name: 'apagar', conditions: { min_index_age: '90d' } }] },
      { name: 'apagar', actions: [{ delete: {} }], transitions: [] },
    ] } } };
  }
  throw Object.assign(new Error('caminho não simulado'), { statusCode: 404 });
}

function search({ index, body }) {
  if (index.includes('packages')) {
    if (process.env.HARNESS_NO_PACKAGES) throw Object.assign(new Error('negado'), { statusCode: 403 });
    return { body: { hits: { hits: [{ _source: { agent: { id: '005' }, package: { name: 'tlog' } } }] } } };
  }
  if (body.aggs?.hosts?.terms && body.size === 0 && !body.aggs.hosts.aggs) {
    return { body: { aggregations: { hosts: { buckets: [...new Set(documents.map((document) => document.host))].map((key) => ({ key })) } } } };
  }
  if (index.includes('inventory') && !body.query) {
    return { body: { hits: { hits: machineInventory.map((_source) => ({ _source })) } } };
  }
  if (body.query?.match_none) {
    if (index.includes('alerts') && process.env.HARNESS_NO_ALERTS) throw Object.assign(new Error('negado'), { statusCode: 403 });
    return { body: { hits: { hits: [] } } };
  }
  if (body.aggs?.hosts) {
    const hosts = new Map();
    for (const document of documents) {
      const entry = hosts.get(document.host) ?? { last: 0, recs: new Set() };
      entry.last = Math.max(entry.last, document.time ?? 0);
      entry.recs.add(document.rec);
      hosts.set(document.host, entry);
    }
    const buckets = [...hosts].map(([key, { last, recs }]) => ({ key, last: { value: last }, recent: { sessions: { value: recs.size } } })).sort((a, b) => b.last.value - a.last.value);
    return { body: { hits: { total: { value: documents.length } }, aggregations: { hosts: { buckets } } } };
  }
  // Sem esta variável, os alertas respondem como para um usuário sem permissão.
  if (index.includes('alerts')) {
    if (process.env.HARNESS_NO_ALERTS) throw Object.assign(new Error('negado'), { statusCode: 403 });
    const { filter = [], must = [] } = body.query.bool;
    const hits = alertDocs.filter((alert) => [...filter, ...must].every((clause) => matchesClause(alert, clause)));
    return { body: { hits: { hits: hits.map((_source) => ({ _source })) } } };
  }
  if (index.includes('inventory')) {
    const id = body.query.bool.filter[0].term['agent.id'];
    const hits = inventory.filter((item) => item.agent.id === id).map((_source) => ({ _source }));
    return { body: { hits: { hits } } };
  }
  const { filter = [], must = [], must_not: mustNot = [] } = body.query?.bool ?? {};
  const matches = documents.filter((document) => {
    if (mustNot.some((clause) => matchesClause(document, clause))) return false;
    for (const clause of filter) {
      if ((clause.range || clause.terms) && !matchesClause(document, clause)) return false;
      if (clause.term) {
        const [[field, value]] = Object.entries(clause.term);
        if (document[field] !== value) return false;
      }
      if (clause.bool) {
        const { gte, lte } = clause.bool.should[1].bool.filter[0].range['@timestamp'];
        const time = document['@timestamp'];
        if ((gte && time < gte) || (lte && time > lte)) return false;
      }
    }
    return must.every((clause) => (document.out_txt ?? '').includes(clause.match_phrase.out_txt));
  });

  if (body.aggs) {
    const groups = new Map();
    for (const document of matches) {
      if (!groups.has(document.rec)) groups.set(document.rec, []);
      groups.get(document.rec).push(document);
    }
    const buckets = [...groups].map(([key, group]) => {
      const times = group.map((document) => document['@timestamp']).sort();
      const firstMessage = [...group].sort((x, y) => x.id - y.id)[0];
      return {
        key,
        doc_count: group.length,
        first_seen: { value_as_string: times[0] },
        last_seen: { value_as_string: times[times.length - 1] },
        first_time: { value: Date.parse(times[0]) / 1000 },
        max_pos: { value: Math.max(...group.map((document) => document.pos)) },
        max_id: { value: Math.max(...group.map((document) => document.id)) },
        details: { hits: { hits: [{ _source: firstMessage }] } },
      };
    });
    buckets.sort((x, y) => y.last_seen.value_as_string.localeCompare(x.last_seen.value_as_string));
    return { body: { aggregations: { sessions: { buckets } } } };
  }

  const after = body.search_after?.[0] ?? 0;
  const hits = matches
    .filter((document) => document.id > after)
    .sort((x, y) => x.id - y.id)
    .slice(0, body.size)
    .map((document) => ({
      _source: Object.fromEntries(body._source.map((field) => [field, document[field]])),
      sort: [document.id],
    }));
  return { body: { hits: { hits } } };
}

/* ---------- plugin de servidor, como o dashboard o carrega ---------- */
const routes = [];
const logger = { error: (message) => console.error(message), info: (message) => console.log(message), get: () => logger };
const { plugin } = require(join(pluginDir, 'server/index.js'));
const instance = plugin({ logger });
const harnessCa = readFileSync(join(root, 'test/fixtures-ca.pem'), 'utf8');
instance.setup({
  opensearch: { legacy: { config$: { subscribe: ({ next }) => { next({ hosts: ['https://wazuh.indexer:9200'], ssl: { certificateAuthorities: [harnessCa] } }); return { unsubscribe() {} }; } } } },
  http: {
    createRouter: () => ({
      get: (config, handler) => routes.push({ ...config, method: 'GET', handler }),
      put: (config, handler) => routes.push({ ...config, method: 'PUT', handler }),
    }),
  },
  savedObjects: { registerType: () => {} },
});
// Guarda em memória, com o controle de versão do saved object real.
let storedObject = null;
let storedVersion = 0;
instance.start({
  savedObjects: {
    createInternalRepository: () => ({
      get: async () => {
        if (!storedObject) throw Object.assign(new Error('não encontrado'), { output: { statusCode: 404 } });
        return storedObject;
      },
      create: async (type, attributes, { overwrite, version }) => {
        if (storedObject && (!overwrite || version !== storedObject.version)) {
          throw Object.assign(new Error('conflito'), { output: { statusCode: 409 } });
        }
        storedVersion += 1;
        storedObject = { attributes, version: String(storedVersion) };
        return storedObject;
      },
    }),
  },
});

const reply = (statusCode, body) => ({ statusCode, body });
const responseFactory = {
  ok: ({ body, headers }) => ({ ...reply(200, body), headers }),
  notFound: ({ body }) => reply(404, body),
  customError: ({ statusCode, body }) => reply(statusCode, body),
};
const validationResult = {
  ok: (value) => ({ value }),
  badRequest: (message) => ({ error: message }),
};

function matchRoute(pathname, method) {
  for (const route of routes.filter((candidate) => candidate.method === method)) {
    const pattern = new RegExp(`^${route.path.replace(/\{(\w+)\}/g, '(?<$1>[^/]+)')}$`);
    const match = pattern.exec(pathname);
    if (match) {
      const params = Object.fromEntries(
        Object.entries(match.groups ?? {}).map(([key, value]) => [key, decodeURIComponent(value)])
      );
      return { route, params };
    }
  }
  return null;
}

async function callApi(url, method, rawBody) {
  const found = matchRoute(url.pathname, method);
  if (!found) return reply(404, { message: 'rota não encontrada' });
  const { route, params } = found;
  const request = {};
  const inputs = { query: Object.fromEntries(url.searchParams), params, body: rawBody ? JSON.parse(rawBody) : undefined };
  for (const part of ['query', 'params', 'body']) {
    const validate = route.validate && route.validate[part];
    if (validate) {
      const outcome = validate(inputs[part], validationResult);
      if (outcome.error) return reply(400, { message: outcome.error });
      request[part] = outcome.value;
    }
  }
  const context = {
    core: {
      opensearch: {
        client: { asCurrentUser: { search: async (query) => search(query), transport: { request: async (options) => transportRequest(options) } } },
      },
    },
  };
  return route.handler(context, request, responseFactory);
}

/* ---------- página que imita o bootstrap do dashboard ---------- */
const bootstrap = `
var modules = {};
window.__osdBundles__ = {
  has: function (key) { return Object.prototype.hasOwnProperty.call(modules, key); },
  define: function (key, bundleRequire, moduleKey) { modules[key] = { bundleRequire: bundleRequire, moduleKey: moduleKey }; },
  get: function (key) { return modules[key].bundleRequire(modules[key].moduleKey); }
};`;
const start = `
var exported = window.__osdBundles__.get('plugin/tlogReplay/public');
var application;
var coreApplication = {
  getUrlForApp: function (id, options) {
    return id === 'tlogReplay' ? '/' + ((options && options.path) || '') : '/mock-agent' + ((options && options.path) || '');
  },
  navigateToApp: function (id, options) { window.location.href = '/' + ((options && options.path) || ''); }
};
function toJson(response) {
  return response.json().then(function (body) {
    if (!response.ok) { var error = new Error(body.message); error.body = body; error.response = response; throw error; }
    return body;
  });
}
var http = {
  get: function (path, options) {
    var query = new URLSearchParams((options && options.query) || {}).toString();
    return fetch(path + (query ? '?' + query : '')).then(toJson);
  },
  put: function (path, options) {
    return fetch(path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: options.body }).then(toJson);
  }
};
var instance = exported.plugin();
http.basePath = { prepend: function (path) { return path; } };
instance.setup({
  http: http,
  application: { register: function (app) { application = app; } },
  getStartServices: function () { return Promise.resolve([{ http: http, application: coreApplication }]); }
});
instance.start({ http: http, application: coreApplication });
if (document.getElementById('app')) {
  application.mount({ element: document.getElementById('app') }).then(function (unmount) { window.__unmount = unmount; });
}`;
// Reproduz a marcação do EuiCard (ouiCard__*) nos cards da home do Wazuh.
const homeCard = (name) => `<div class="euiFlexItem"><div class="h-100"><div class="ouiCard wz-module-card-title h-100" data-test-subj="overviewWelcome${name}">
<div class="ouiCard__top"><svg class="ouiIcon ouiIcon--xLarge ouiCard__icon" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7"/></svg></div>
<div class="ouiCard__content"><span class="ouiCard__title"><a class="ouiCard__titleAnchor" href="/app/${name}">${name}</a></span>
<div class="ouiCard__description"><p>Descrição de ${name}</p></div></div></div></div></div>`;
const mockHome = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Home (simulada)</title></head>
<body><div class="euiFlexGrid" id="grid">${homeCard('IT Hygiene')}${homeCard('PCI DSS')}</div>
<script src="/bootstrap.js"></script><script src="/plugin.js"></script><script src="/start.js"></script></body></html>`;

// Reproduz só a estrutura da tela do agente do Wazuh que o plugin usa para inserir os itens.
const sideNavGroup = (name, apps) => `<div class="euiFlexItem"><nav class="ouiSideNav" id="nav-${name}"><div class="ouiSideNav__content"><div class="ouiSideNavItem ouiSideNavItem--root ouiSideNavItem--rootIcon ouiSideNavItem--hasChildItems">
<div class="ouiSideNavItemButton"><span class="ouiSideNavItemButton__content"><svg class="ouiIcon ouiIcon--medium ouiSideNavItemButton__icon" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7"/></svg><span class="ouiSideNavItemButton__label" title="${name}">${name}</span></span></div>
<div class="ouiSideNavItem__items">${apps.map((app) => `<div class="ouiSideNavItem ouiSideNavItem--trunk"><div class="ouiSideNavItemButton"><span class="ouiSideNavItemButton__content"><span class="ouiSideNavItemButton__label"><div class="euiFlexGroup"><div class="euiFlexItem"><a class="euiLink euiLink--primary" href="/app/${app}">${app}</a></div></div></span></span></div></div>`).join('')}</div>
</div></div></nav></div>`;
const mockAgent = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Tela do agente (simulada)</title></head>
<body><div class="euiFlexGroup"><div class="euiFlexItem"><a href="#">Threat Hunting</a></div>
<div class="euiFlexItem" id="more-item"><button class="euiButtonEmpty" type="button">More...</button></div></div>
<div class="euiPanel"><div class="WzManagementSideMenu"><div><div class="euiFlexGrid">${sideNavGroup('Endpoint security', ['Configuration Assessment', 'Malware Detection'])}${sideNavGroup('Threat intelligence', ['Threat Hunting'])}</div></div></div></div>
<script src="/bootstrap.js"></script><script src="/plugin.js"></script><script src="/start.js"></script></body></html>`;
const page = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Harness do Session Replay</title>
<style>body{margin:0;font-family:Inter,system-ui,sans-serif;color:#343741}</style></head>
<body><div id="app"></div>
<script src="/bootstrap.js"></script><script src="/plugin.js"></script><script src="/start.js"></script></body></html>`;

createServer(async (request, response) => {
  const url = new URL(request.url, `http://localhost:${PORT}`);
  const send = (status, type, body, headers = {}) => {
    response.writeHead(status, { 'content-type': type, 'content-security-policy': CSP, ...headers });
    response.end(body);
  };
  try {
    if (url.pathname === '/') return send(200, 'text/html; charset=utf-8', page);
    if (url.pathname === '/mock-agent') return send(200, 'text/html; charset=utf-8', mockAgent);
    if (url.pathname === '/app/wz-home') return send(200, 'text/html; charset=utf-8', mockHome);
    if (url.pathname === '/bootstrap.js') return send(200, 'text/javascript', bootstrap);
    if (url.pathname === '/start.js') return send(200, 'text/javascript', start);
    if (url.pathname === '/plugin.js') {
      // Mesmo cache do dashboard real: um ano, em endereço fixo.
      return send(200, 'text/javascript', readFileSync(join(pluginDir, 'target/public/tlogReplay.plugin.js')), {
        'cache-control': 'max-age=31536000',
      });
    }
    if (url.pathname.startsWith('/api/')) {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const { statusCode, body, headers } = await callApi(url, request.method, Buffer.concat(chunks).toString());
      if (Buffer.isBuffer(body)) return send(statusCode, headers['content-type'], body, headers);
      return send(statusCode, 'application/json', JSON.stringify(body), headers);
    }
    return send(404, 'text/plain', 'não encontrado');
  } catch (error) {
    console.error(error);
    return send(500, 'text/plain', 'erro interno');
  }
}).listen(PORT, '127.0.0.1', () => console.log(`Harness em http://localhost:${PORT}`));
