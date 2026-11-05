'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { convert } = require('../src/lib/tlog2asciicast');
const { buildActivity } = require('../src/lib/activity');
const { buildInsights } = require('../src/lib/insights');
const { buildChunkBody, ACTIVITY_FIELDS } = require('../src/lib/queries');
const {
  classifyCommand,
  correlate,
  detectCommands,
  findLogin,
  processId,
  terminalLines,
} = require('../src/lib/session_events');

const sample = (name) => join(__dirname, '../samples', name);
const messages = readFileSync(sample('critical-session.log'), 'utf8').trim().split('\n').map(JSON.parse);
const alerts = JSON.parse(readFileSync(sample('critical-alerts.json'), 'utf8'));
const parent = messages.filter((message) => message.session === 14);
const child = messages.filter((message) => message.session === 15);
const prompt = 'teste@web:~$ ';
const output = (...chunks) => chunks.map((chunk, index) => [index, 'o', chunk]);

test('aplica backspace, setas e limpeza de linha como o terminal', () => {
  assert.equal(terminalLines(output('sudp\b\u001b[Ko id\r\n'))[0].text, 'sudo id');
  assert.equal(terminalLines(output('rm arq\u001b[D\u001b[D\u001b[D\u001b[1P-rf x\r\n'))[0].text.startsWith('rm'), true);
  // O Bash volta o cursor para inserir no meio, sem apagar o que está depois.
  assert.equal(terminalLines(output('abcd\b\bX\r\n'))[0].text, 'abXd');
});

test('reconhece sequências de escape cortadas entre pedaços', () => {
  assert.equal(terminalLines(output('sudo\u001b[', '0m id\r\n'))[0].text, 'sudo id');
  assert.equal(terminalLines(output('\u001b]0;titulo\u0007sudo id\r\n'))[0].text, 'sudo id');
});

test('a tela alternativa não esconde comandos, mas fica marcada', () => {
  const lines = terminalLines(output('\u001b[?1049h', `${prompt}rm -rf /\r\n`, '\u001b[?1049l', `${prompt}ls\r\n`));
  assert.deepEqual(lines.map(({ alternate }) => alternate), [true, false]);
  const { commands } = detectCommands(output('\u001b[?1049h', `${prompt}rm -rf /\r\n`));
  assert.equal(commands[0].alternate, true);
});

test('a tela alternativa só limpa a linha em andamento', () => {
  const lines = terminalLines(output('\u001b[?1049h', `${prompt}ls\r\n`, '\u001b[?1049l', `${prompt}ls\r\n`)).filter(({ alternate }) => !alternate);
  assert.deepEqual(lines.map((line) => line.text), [`${prompt}ls`]);
});

test('classifica os comandos críticos', () => {
  const kinds = {
    'sudo id': 'sudo',
    'su -': 'su',
    'su': 'su',
    'ssh root@10.0.0.1': 'ssh',
    'scp a b:': 'ssh',
    'rm -rf /tmp/a': 'destructive',
    'sudo rm -fr /': 'destructive',
    'rm -r -f x': 'destructive',
    'dd if=/dev/zero of=/dev/sda': 'destructive',
    'mkfs.ext4 /dev/sda1': 'destructive',
    'chmod -R 777 /': 'destructive',
    'shutdown -h now': 'destructive',
    'curl x | sh': 'pipe',
    'cd /tmp; rm -rf a': 'destructive',
  };
  for (const [command, kind] of Object.entries(kinds)) assert.equal(classifyCommand(command)?.kind, kind, command);
});

test('não confunde comandos comuns com críticos', () => {
  for (const command of ['ls', 'rm arquivo', 'echo sudo', 'grep ssh arquivo', 'cat rm', 'sudoku', 'summary', 'man ssh', 'sshd -t']) {
    assert.equal(classifyCommand(command), null, command);
  }
});

test('texto perigoso na saída de um comando não vira evento', () => {
  const { commands, promptsSeen } = detectCommands(
    output(`${prompt}cat doc.txt\r\n`, 'use rm -rf / com cuidado\r\n', 'root@web:~# ls\r\n')
  );
  assert.deepEqual(commands, []);
  assert.equal(promptsSeen, 2);
});

test('reconhece o prompt de Fedora e o de root', () => {
  assert.equal(detectCommands(output('[ana@web tmp]$ sudo id\r\n')).commands[0]?.kind, 'sudo');
  assert.equal(detectCommands(output('root@web:/var# rm -rf x\r\n')).commands[0]?.kind, 'destructive');
  assert.equal(detectCommands(output('(venv) ana@web:~$ ssh b\r\n')).commands[0]?.kind, 'ssh');
});

test('a hora do comando é a do Enter e o texto tem limite', () => {
  const { commands } = detectCommands([[1, 'o', prompt], [5, 'o', `sudo ${'x'.repeat(500)}\r\n`]]);
  assert.equal(commands[0].t, 5000);
  assert.ok(commands[0].command.length <= 200);
});

test('linhas enormes não travam a análise', () => {
  const started = Date.now();
  detectCommands(output(`${prompt}rm ${'-rf'.repeat(100000)}\r\n`, `${prompt}${'a@b:'.repeat(100000)}\r\n`));
  assert.ok(Date.now() - started < 2000);
});

test('lê o processo do log', () => {
  assert.equal(processId('Nov 05 00:06:18 h sshd[5993]: Accepted'), '5993');
  assert.equal(processId('sem processo'), null);
});

test('dois logins quase juntos deixam a origem incerta', () => {
  const login = (ms) => ({ timestamp: new Date(ms).toISOString(), data: { srcip: '1.1.1.1' }, full_log: 'sshd[1]: ok' });
  assert.equal(findLogin([login(1000), login(1500)], 1000).ambiguous, true);
  assert.equal(findLogin([login(1000), login(9000)], 1000).ambiguous, false);
  assert.equal(findLogin([], 1000), null);
});

const sudoAlert = (ms, command, srcuser = 'ana') => ({
  timestamp: new Date(ms).toISOString(),
  rule: { id: '5402', level: 3, description: 'Sudo', groups: ['syslog', 'sudo'], mitre: { id: ['T1548.003'] } },
  data: { srcuser },
  full_log: `sudo[9]: ${srcuser} : TTY=pts/1 ; USER=root ; COMMAND=${command}`,
});

test('liga o sudo digitado ao alerta que cita o mesmo comando', () => {
  const [event] = correlate({
    user: 'ana',
    startMs: 0,
    commands: [{ t: 1000, kind: 'sudo', label: 'sudo', command: 'sudo id' }],
    alerts: [sudoAlert(5000, '/usr/bin/id')],
    hasOverlap: false,
  });
  assert.equal(event.evidence, 'both');
  assert.equal(event.rule.id, '5402');
});

test('não atribui alerta de outro usuário, de outro comando ou de sessão simultânea', () => {
  const base = { startMs: 0, user: 'ana', commands: [] };
  assert.deepEqual(correlate({ ...base, alerts: [sudoAlert(5000, '/usr/bin/id', 'bia')], hasOverlap: false }), []);
  assert.deepEqual(correlate({ ...base, alerts: [sudoAlert(5000, '/usr/bin/id')], hasOverlap: true }), []);
  const [event] = correlate({ ...base, alerts: [sudoAlert(5000, '/usr/bin/id --x')], hasOverlap: false });
  assert.equal(event.evidence, 'wazuh');
  const typed = [{ t: 1000, kind: 'sudo', label: 'sudo', command: 'sudo ls' }];
  const events = correlate({ ...base, commands: typed, alerts: [sudoAlert(5000, '/usr/bin/id')], hasOverlap: true });
  assert.equal(events.length, 1);
  assert.equal(events[0].evidence, 'capture');
});

test('um alerta bem depois do comando não é ligado a ele', () => {
  const events = correlate({
    user: 'ana',
    startMs: 0,
    commands: [{ t: 1000, kind: 'sudo', label: 'sudo', command: 'sudo id' }],
    alerts: [sudoAlert(500000, '/usr/bin/id')],
    hasOverlap: true,
  });
  assert.equal(events[0].evidence, 'capture');
});

test('marca o sudo negado', () => {
  const denied = {
    timestamp: new Date(3000).toISOString(),
    rule: { id: '5503', level: 5, description: 'PAM', groups: ['pam'] },
    data: { srcuser: 'ana' },
    full_log: 'Nov 05 00:00:00 web sudo[9]: pam_unix(sudo:auth): authentication failure',
  };
  const [event] = correlate({
    user: 'ana',
    startMs: 0,
    commands: [{ t: 1000, kind: 'sudo', label: 'sudo', command: 'sudo id' }],
    alerts: [denied],
    hasOverlap: false,
  });
  assert.equal(event.failed, true);
});

/** Índices falsos: devolvem os dados reais da amostra conforme o tipo de consulta. */
function fakeSearch() {
  const inRange = (body, value) => {
    const range = body.query.bool.filter.find((clause) => clause.range?.timestamp)?.range.timestamp;
    return value >= Date.parse(range.gte) && value <= Date.parse(range.lte);
  };
  const searchAlerts = async (body) => {
    const ids = JSON.stringify(body.query.bool.filter);
    const hits = alerts
      .filter((alert) => inRange(body, Date.parse(alert.timestamp)))
      .filter((alert) => {
        if (ids.includes('"rule.id":"5502"')) return alert.rule.id === '5502' && alert.full_log.includes(body.query.bool.must[0].match_phrase.full_log);
        if (ids.includes('"rule.id":"5715"')) return alert.rule.id === '5715' && alert.data?.dstuser === 'teste';
        return alert.rule.groups.includes('sudo') || alert.rule.id === '5715' || alert.rule.id === '5503';
      })
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return { hits: { hits: hits.map((_source) => ({ _source })) } };
  };
  const searchLogs = async (body) => {
    // Início real de cada gravação, independente do período.
    const starts = body.query.bool.filter.find((clause) => clause.terms?.rec);
    if (starts) {
      const buckets = starts.terms.rec.map((rec) => ({
        key: rec,
        first_time: { value: Math.min(...messages.filter((m) => m.rec === rec).map((m) => m.time)) },
      }));
      return { aggregations: { sessions: { buckets } } };
    }
    const rec = body.query.bool.must_not[0].term.rec;
    const others = messages.filter((message) => message.rec !== rec);
    if (body.aggs) {
      const first = others[0];
      const buckets = first ? [{ key: first.rec, details: { hits: { hits: [{ _source: { user: first.user } }] } } }] : [];
      return { aggregations: { sessions: { buckets } } };
    }
    return { hits: { hits: others.slice(0, 1).map((_source) => ({ _source })) } };
  };
  return { searchAlerts, searchLogs };
}

test('sessão crítica real: comandos e evidências', async () => {
  const result = await buildInsights({ rec: parent[0].rec, messages: parent, ...fakeSearch() });
  assert.equal(result.alertsAvailable, true);
  assert.deepEqual(
    result.events.map((event) => [event.kind, event.evidence]),
    [
      ['sudo', 'both'],
      ['sudo', 'both'],
      ['ssh', 'both'],
      ['destructive', 'capture'],
      ['destructive', 'capture'],
      ['pipe', 'capture'],
    ]
  );
  assert.equal(result.events[0].command, 'sudo id');
  assert.ok(result.events[2].childStartedAt);
  assert.equal(result.login.srcip, '172.19.0.1');
  assert.equal(result.login.local, false);
  assert.ok(result.closedAtMs >= result.durationMs);
});

test('sessão real aberta por salto: login local, sem herdar alertas da sessão pai', async () => {
  const result = await buildInsights({ rec: child[0].rec, messages: child, ...fakeSearch() });
  assert.deepEqual(result.events, []);
  assert.equal(result.login.local, true);
  // O início é o da sessão pai inteira, não o primeiro pedaço dela dentro da janela.
  assert.equal(Date.parse(result.login.parentStartedAt), Math.min(...parent.map((message) => message.time)) * 1000);
});

test('sem permissão nos alertas, mostra o que está na captura', async () => {
  const errors = [];
  const result = await buildInsights({
    rec: parent[0].rec,
    messages: parent,
    searchLogs: fakeSearch().searchLogs,
    searchAlerts: async () => {
      throw Object.assign(new Error('negado'), { statusCode: 403 });
    },
    onAlertError: (error) => errors.push(error.statusCode),
  });
  assert.equal(result.alertsAvailable, false);
  assert.deepEqual(errors, [403]);
  assert.equal(result.events.length, 6);
  assert.ok(result.events.every((event) => event.evidence === 'capture'));
  assert.equal(result.durationMs, buildActivity(parent).durationMs);
});

test('a amostra real não contém entrada e a consulta nunca pede a entrada', () => {
  const body = buildChunkBody('abc', undefined, ACTIVITY_FIELDS);
  assert.ok(!body._source.includes('in_txt'));
  assert.ok(!body._source.includes('in_bin'));
  assert.ok(convert(parent).events.length > 0);
});
