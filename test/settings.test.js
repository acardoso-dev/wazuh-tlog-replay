'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildInsights } = require('../src/lib/insights');
const { buildDiagnostics, retentionAge } = require('../src/lib/diagnostics');
const { classifyCommand, commandFromLine, compileDetection, detectCommands } = require('../src/lib/session_events');
const { DEFAULT_SETTINGS, displayValue, mergeStored, parseSettingsBody, validateSettings } = require('../src/lib/settings');
const { SettingsConflictError, createSettingsStore, currentAccount } = require('../src/lib/settings_store');

const values = (changes = {}) => ({ ...DEFAULT_SETTINGS, ...changes });
const logger = { info() {}, error() {} };

function fakeRepository() {
  let object = null;
  let version = 0;
  return {
    get: async () => {
      if (!object) throw Object.assign(new Error('não encontrado'), { output: { statusCode: 404 } });
      return object;
    },
    create: async (type, attributes, options) => {
      if (object && (!options.overwrite || options.version !== object.version)) {
        throw Object.assign(new Error('conflito'), { output: { statusCode: 409 } });
      }
      version += 1;
      object = { attributes, version: String(version) };
      return object;
    },
  };
}

test('o padrão é válido e mantém o comportamento anterior', () => {
  assert.deepEqual(validateSettings(DEFAULT_SETTINGS), {});
  const defaults = compileDetection(DEFAULT_SETTINGS);
  assert.equal(commandFromLine('ana@web:~$ sudo id', defaults), 'sudo id');
  assert.equal(commandFromLine('[ana@web tmp]# ls', defaults), 'ls');
  assert.equal(commandFromLine('ana@web ~ % ls', defaults), null);
});

test('rejeita valores fora dos limites, sem depender da tela', () => {
  for (const [field, value] of [
    ['idleSeconds', 4],
    ['idleSeconds', 3601],
    ['idleSeconds', 1.5],
    ['idleSeconds', '30'],
    ['pauseSeconds', 0],
    ['pauseSeconds', null],
    ['kinds', ['inventado']],
    ['prompts', []],
    ['prompts', ['inventado']],
    ['alertsEnabled', 'sim'],
    ['extra', 'rm'],
  ]) {
    assert.ok(validateSettings(values({ [field]: value }))[field], `${field}=${JSON.stringify(value)}`);
  }
});

test('comandos extras não aceitam expressão regular', () => {
  for (const bad of ['(.*)+$', 'a|b', 'rm *', 'a;b', '$(id)', `x${'y'.repeat(80)}`]) {
    assert.ok(validateSettings(values({ extra: [bad] })).extra, bad);
  }
  assert.ok(validateSettings(values({ extra: Array.from({ length: 51 }, (_, index) => `c${index}`) })).extra);
  assert.equal(validateSettings(values({ extra: ['kubectl delete', '/usr/bin/foo', 'a.b-c_d:e+f'] })).extra, undefined);
});

test('o corpo do PUT recusa campo desconhecido e remove repetições', () => {
  assert.throws(() => parseSettingsBody({ values: { ...DEFAULT_SETTINGS, foo: 1 } }), /desconhecida/);
  assert.throws(() => parseSettingsBody({ values: null }), /inválidas/);
  assert.throws(() => parseSettingsBody({ values: DEFAULT_SETTINGS, version: 1 }), /Versão/);
  const { values: clean } = parseSettingsBody({ values: values({ extra: ['a', 'a'] }) });
  assert.deepEqual(clean.extra, ['a']);
});

test('um valor gravado inválido volta ao padrão, sem perder os outros', () => {
  const merged = mergeStored({ idleSeconds: 1, pauseSeconds: 5, antigo: true });
  assert.equal(merged.idleSeconds, DEFAULT_SETTINGS.idleSeconds);
  assert.equal(merged.pauseSeconds, 5);
  assert.equal(merged.antigo, undefined);
  assert.deepEqual(mergeStored(), { ...DEFAULT_SETTINGS });
});

test('comandos extras entram como Destrutivo, também com sudo, e são literais', () => {
  const detection = compileDetection(values({ extra: ['kubectl delete', 'a.b'] }));
  assert.equal(classifyCommand('kubectl delete ns prod', detection).kind, 'destructive');
  assert.equal(classifyCommand('sudo  kubectl   delete ns', detection).kind, 'destructive');
  assert.equal(classifyCommand('ls; kubectl delete x', detection).kind, 'destructive');
  assert.equal(classifyCommand('kubectl get pods', detection), null);
  assert.equal(classifyCommand('kubectl deleted', detection), null);
  assert.equal(classifyCommand('axb', detection), null, 'o ponto não é curinga');
  assert.equal(classifyCommand('rm -rf /x', detection).kind, 'destructive');
});

test('tipo desligado não é reconhecido, e o comando extra segue o tipo Destrutivo', () => {
  const noSudo = compileDetection(values({ kinds: ['destructive', 'pipe', 'su', 'ssh'] }));
  assert.equal(classifyCommand('sudo id', noSudo), null);
  assert.equal(classifyCommand('sudo rm -rf /x', noSudo).kind, 'destructive');
  const noDestructive = compileDetection(values({ kinds: ['sudo'], extra: ['kubectl delete'] }));
  assert.equal(classifyCommand('kubectl delete x', noDestructive), null);
  assert.equal(classifyCommand('rm -rf /x', noDestructive), null);
  assert.equal(compileDetection(values({ kinds: [] })).patterns.length, 0);
});

test('formatos de prompt extras só valem quando ligados', () => {
  const on = compileDetection(values({ prompts: ['zsh', 'macos'] }));
  assert.equal(commandFromLine('ana@mac ~ % sudo id', on), 'sudo id');
  assert.equal(commandFromLine('mac:~ ana$ sudo id', on), 'sudo id');
  assert.equal(commandFromLine('ana@web:~$ sudo id', on), null);
  const output = [[1, 'o', 'ana@mac ~ % rm -rf /x\r\n']];
  assert.equal(detectCommands(output).commands.length, 0);
  assert.equal(detectCommands(output, on).commands.length, 1);
});

test('regras combinadas não demoram em texto hostil', () => {
  const detection = compileDetection(values({ extra: ['a b', 'c'], prompts: ['debian', 'rhel', 'zsh', 'macos'] }));
  const started = Date.now();
  for (const line of [`a@b:${'x '.repeat(1000)}`, `${'a@'.repeat(1000)} %`, `${'a:'.repeat(1000)} b`, `[a@b ${'c'.repeat(1990)}`]) {
    commandFromLine(line, detection);
  }
  classifyCommand(`${'a '.repeat(1000)}`, detection);
  assert.ok(Date.now() - started < 500);
});

test('displayValue escreve valores para pessoas', () => {
  assert.equal(displayValue('alertsEnabled', false), 'Desligado');
  assert.equal(displayValue('idleSeconds', 60), '60 s');
  assert.equal(displayValue('extra', []), 'nenhum');
  assert.equal(displayValue('kinds', ['sudo', 'ssh']), 'sudo, SSH');
});

test('sem nada gravado, a leitura devolve o padrão, sem versão', async () => {
  const store = createSettingsStore({ getRepository: fakeRepository, logger });
  const { values: read, version, history } = await store.read();
  assert.deepEqual(read, { ...DEFAULT_SETTINGS });
  assert.equal(version, undefined);
  assert.deepEqual(history, []);
});

test('salvar registra quem e o quê; salvar uma tela antiga dá conflito', async () => {
  const repository = fakeRepository();
  const store = createSettingsStore({ getRepository: () => repository, logger });
  const first = await store.save({ values: values({ idleSeconds: 60 }), version: undefined, user: 'ana' });
  assert.equal(first.history[0].user, 'ana');
  assert.deepEqual(first.history[0].changes, [{ id: 'idleSeconds', from: 30, to: 60 }]);
  const second = await store.save({ values: values({ idleSeconds: 90 }), version: first.version, user: 'bia' });
  assert.equal(second.history.length, 2);
  await assert.rejects(store.save({ values: values({ idleSeconds: 10 }), version: first.version, user: 'ana' }), SettingsConflictError);
  await assert.rejects(store.save({ values: values({ idleSeconds: 10 }), version: undefined, user: 'ana' }), SettingsConflictError);
  assert.equal((await store.read()).values.idleSeconds, 90);
});

test('salvar sem mudança não gera histórico, e o histórico tem limite', async () => {
  const repository = fakeRepository();
  const store = createSettingsStore({ getRepository: () => repository, logger });
  const none = await store.save({ values: values(), version: undefined, user: 'ana' });
  assert.deepEqual(none.history, []);
  let version;
  for (let index = 0; index < 25; index += 1) {
    ({ version } = await store.save({ values: values({ idleSeconds: 100 + index }), version, user: 'ana' }));
  }
  assert.equal((await store.read()).history.length, 20);
});

test('a análise usa o valor salvo logo depois de salvar e cai no padrão se a leitura falhar', async () => {
  const repository = fakeRepository();
  const errors = [];
  let time = 0;
  const store = createSettingsStore({ getRepository: () => repository, logger: { ...logger, error: (text) => errors.push(text) }, now: () => time });
  assert.equal((await store.getValues()).idleSeconds, 30);
  await store.save({ values: values({ idleSeconds: 60 }), version: undefined, user: 'ana' });
  assert.equal((await store.getValues()).idleSeconds, 60);
  repository.get = async () => {
    throw new Error('indexador fora');
  };
  time = 60000;
  assert.equal((await store.getValues()).idleSeconds, 30);
  assert.equal(errors.length, 1);
});

test('só all_access e tlog_replay_admin alteram; erro nega', async () => {
  const account = (roles) => ({ transport: { request: async () => ({ body: { user_name: 'x', roles } }) } });
  assert.equal((await currentAccount(account(['all_access']))).canEdit, true);
  assert.equal((await currentAccount(account(['tlog_replay_admin']))).canEdit, true);
  assert.equal((await currentAccount(account(['tlog_reader', 'admin']))).canEdit, false);
  assert.equal((await currentAccount(account(undefined))).canEdit, false);
  const failing = { transport: { request: async () => { throw new Error('404'); } } };
  assert.equal((await currentAccount(failing)).canEdit, false);
});

const prompted = (id, pos, text) => ({ id, pos, time: 1000 + pos / 1000, timing: `>${Array.from(text).length}`, out_txt: text, host: 'web', user: 'ana', rec: 'r' });

test('a análise aplica o tempo ocioso e os tipos configurados', async () => {
  const messages = [prompted(1, 0, 'ana@web:~$ sudo id\r\n'), prompted(2, 40000, 'ana@web:~$ rm -rf /x\r\n')];
  const noAlerts = async () => ({ hits: { hits: [] } });
  const common = { rec: 'r', messages, searchLogs: noAlerts, searchAlerts: noAlerts };
  const standard = await buildInsights(common);
  assert.equal(standard.segments.length, 2);
  assert.deepEqual(standard.events.map((event) => event.kind), ['sudo', 'destructive']);
  assert.equal(standard.partialDetection, false);
  const custom = await buildInsights({ ...common, settings: values({ idleSeconds: 60, kinds: ['destructive'] }) });
  assert.equal(custom.segments.length, 1);
  assert.deepEqual(custom.events.map((event) => event.kind), ['destructive']);
  assert.equal(custom.partialDetection, true);
});

test('alerta sem eco de um tipo desligado também some', async () => {
  const messages = [prompted(1, 0, 'ana@web:~$ ls\r\n'), prompted(2, 5000, 'ok\r\n')];
  const alert = {
    timestamp: new Date(1000000 + 2000).toISOString(),
    rule: { id: '5402', level: 3, description: 'sudo', groups: ['sudo'] },
    data: { srcuser: 'ana' },
    full_log: 'sudo: ana : COMMAND=/usr/bin/id',
  };
  const empty = async () => ({ hits: { hits: [] } });
  const common = { rec: 'r', messages, searchLogs: empty, searchAlerts: async () => ({ hits: { hits: [{ _source: alert }] } }) };
  assert.ok((await buildInsights(common)).events.some((event) => event.evidence === 'wazuh'));
  assert.equal((await buildInsights({ ...common, settings: values({ kinds: ['ssh'] }) })).events.length, 0);
});

test('com os alertas desligados, o plugin não os consulta', async () => {
  let asked = 0;
  const count = async () => {
    asked += 1;
    return { hits: { hits: [] } };
  };
  const result = await buildInsights({
    rec: 'r',
    messages: [prompted(1, 0, 'ana@web:~$ sudo id\r\n')],
    searchLogs: count,
    searchAlerts: count,
    settings: values({ alertsEnabled: false }),
  });
  assert.equal(asked, 0);
  assert.equal(result.alertsDisabled, true);
  assert.deepEqual(result.events.map((event) => event.evidence), ['capture']);
});

test('a retenção lê a idade da transição para o estado que apaga', () => {
  const policy = {
    policy: {
      states: [
        { name: 'quente', actions: [], transitions: [{ state_name: 'frio', conditions: { min_index_age: '7d' } }] },
        { name: 'frio', actions: [{ read_only: {} }], transitions: [{ state_name: 'fim', conditions: { min_index_age: '90d' } }] },
        { name: 'fim', actions: [{ delete: {} }], transitions: [] },
      ],
    },
  };
  assert.equal(retentionAge(policy), '90d');
  assert.equal(retentionAge({ policy: { states: [{ name: 'a', actions: [], transitions: [] }] } }), null);
  assert.equal(retentionAge({}), null);
});

function fakeClient({ search, request }) {
  return { search, transport: { request } };
}
const forbidden = () => Object.assign(new Error('negado'), { statusCode: 403 });

test('o diagnóstico mostra o que pôde ver e explica o resto', async () => {
  const client = fakeClient({
    search: async ({ index, body }) => {
      if (index.includes('alerts')) throw forbidden();
      if (body.aggs) {
        return {
          body: {
            hits: { total: { value: 5 } },
            aggregations: { hosts: { buckets: [{ key: 'web', last: { value: 1000 }, recent: { sessions: { value: 2 } } }] } },
          },
        };
      }
      return { body: {} };
    },
    request: async ({ path }) => {
      if (path.includes('explain')) return { body: { 'tlog-1': { 'index.plugins.index_state_management.policy_id': null }, 'tlog-2': { 'index.plugins.index_state_management.policy_id': 'p' }, total_managed_indices: 1 } };
      throw forbidden();
    },
  });
  const { checks, hosts } = await buildDiagnostics(client);
  const byId = Object.fromEntries(checks.map((check) => [check.id, check]));
  assert.equal(byId.logs.status, 'ok');
  assert.equal(byId.alerts.status, 'attention');
  assert.equal(byId.inventory.status, 'ok');
  assert.equal(byId.retention.status, 'attention');
  assert.match(byId.retention.detail, /1 de 2/);
  assert.equal(byId.endpoints.status, 'unknown');
  assert.deepEqual(hosts, [{ host: 'web', lastMs: 1000000, recentSessions: 2 }]);
});

test('sem nenhuma permissão, o diagnóstico responde sem lançar erro', async () => {
  const client = fakeClient({
    search: async () => {
      throw forbidden();
    },
    request: async () => {
      throw forbidden();
    },
  });
  const { checks, hosts } = await buildDiagnostics(client);
  assert.deepEqual(hosts, []);
  assert.deepEqual(checks.map((check) => check.status), ['attention', 'attention', 'attention', 'unknown', 'unknown']);
});
