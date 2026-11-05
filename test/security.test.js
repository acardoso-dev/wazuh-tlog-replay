'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { buildActivity } = require('../src/lib/activity');
const { buildInsights } = require('../src/lib/insights');
const { LimiterBusyError, createLimiter } = require('../src/lib/limiter');
const { FLUENT_KEY_FINGERPRINT, buildInstallScript, validateInstallInput } = require('../src/lib/install_script');
const { fetchAllChunks, parseListResponse, PAGE_SIZE } = require('../src/lib/queries');
const { MAX_COLS, MAX_ROWS, MAX_WARNINGS, convert, parseTiming } = require('../src/lib/tlog2asciicast');
const { MAX_EVENTS, classifyCommand, correlate, detectCommands, terminalLines } = require('../src/lib/session_events');

const collector = (name) => fs.readFileSync(path.join(__dirname, '..', 'collector', name), 'utf8');
const output = (text) => [[1, 'o', text]];
const prompt = 'teste@web01:~$ ';
const elapsed = (work) => {
  const start = Date.now();
  work();
  return Date.now() - start;
};

test('um documento com hora absurda não derruba a lista de sessões', () => {
  const [session] = parseListResponse({
    aggregations: {
      sessions: {
        buckets: [{ key: 'x', doc_count: 1, first_time: { value: 1e20 }, first_seen: { value_as_string: '2026-01-01T00:00:00.000Z' }, details: { hits: { hits: [{ _source: {} }] } } }],
      },
    },
  });
  assert.equal(session.startedAt, '2026-01-01T00:00:00.000Z');
});

test('a análise ignora hora e posição absurdas', () => {
  assert.equal(buildActivity([{ id: 1, time: 1e20, pos: 0, timing: '>1' }]).startedAt, null);
  const { startedAt, durationMs } = buildActivity([{ id: 1, time: 1000, pos: 1e300, timing: '>1' }]);
  assert.equal(startedAt, new Date(1000000).toISOString());
  assert.equal(durationMs, 0);
  assert.equal(convert([{ id: 1, time: 1e20, timing: '>1', out_txt: 'a' }]).header.timestamp, undefined);
});

test('números gigantes no timing invalidam a mensagem, sem chegar ao player', () => {
  assert.throws(() => parseTiming(`+${'9'.repeat(400)}`), /fora do limite/);
  const result = convert([{ id: 1, pos: 0, timing: `+${'9'.repeat(400)}>1`, out_txt: 'a' }]);
  assert.deepEqual(result.events, []);
  assert.ok(result.warnings.some((warning) => warning.includes('timing inválido')));
});

test('o tamanho da janela tem teto, e 0x0 é ignorado', () => {
  const result = convert([
    { id: 1, pos: 0, timing: '=0x0=65535x65535>1', out_txt: 'a' },
    { id: 2, pos: 1, timing: '=70000x70000>1', out_txt: 'b' },
  ]);
  assert.deepEqual([result.header.width, result.header.height], [MAX_COLS, MAX_ROWS]);
  assert.deepEqual(result.events.find(([, code]) => code === 'r')[2], `${MAX_COLS}x${MAX_ROWS}`);
  assert.ok(result.warnings.some((warning) => warning.includes('reduzido')));
});

test('campos com tipo errado não derrubam a conversão', () => {
  assert.doesNotThrow(() => convert([{ id: 1, pos: '1', timing: ']1/1', out_txt: 5, out_bin: '12' }]));
});

test('os avisos têm limite, mesmo com muitas mensagens inválidas', () => {
  const messages = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, timing: '?' }));
  assert.equal(convert(messages).warnings.length, MAX_WARNINGS + 1);
  assert.equal(buildActivity(messages).warnings.length, MAX_WARNINGS + 1);
});

test('sequências de inserir no terminal não fazem a linha crescer', () => {
  const text = `abc\r${'\u001b[2000@'.repeat(50000)}\n`;
  let lines;
  assert.ok(elapsed(() => { lines = terminalLines(output(text)); }) < 3000);
  assert.ok(lines[0].text.length <= 2000);
});

test('editar a linha sem parar para no teto, e a análise avisa', () => {
  const text = `${'a'.repeat(1999)}\r${'\u001b[1@\u001b[1P'.repeat(200000)}\n`;
  let result;
  assert.ok(elapsed(() => { result = detectCommands(output(text)); }) < 5000);
  assert.equal(result.limited, true);
});

test('milhões de quebras de linha não viram milhões de objetos', () => {
  const before = process.memoryUsage().heapUsed;
  const { promptsSeen } = detectCommands(output('\n'.repeat(4 * 1024 * 1024)));
  assert.equal(promptsSeen, 0);
  assert.ok(process.memoryUsage().heapUsed - before < 100 * 1024 * 1024);
});

test('linhas preparadas não travam as expressões regulares', () => {
  const lines = [`rm -${'r'.repeat(1990)}!`, `rm ${'-rr '.repeat(490)}!`, `|${' '.repeat(1990)}x`, '; '.repeat(990), `find ${'a '.repeat(990)}`, `A=${'b'.repeat(1990)}!`, `${'/a'.repeat(990)}!`, `bash -${'c'.repeat(1990)}!`, `${'/sh'.repeat(660)} -c x`];
  for (const line of lines) {
    const text = `${prompt}${line}\n`.repeat(1000);
    assert.ok(elapsed(() => detectCommands(output(text))) < 2000, line.slice(0, 12));
  }
});

test('reconhece formas comuns de disfarçar um comando', () => {
  const kinds = {
    '/bin/rm -rf /tmp/x': 'destructive',
    '\\rm -rf /tmp/x': 'destructive',
    'rm --recursive --force /tmp/x': 'destructive',
    'command rm -rf /x': 'destructive',
    'env rm -rf /x': 'destructive',
    'FOO=1 rm -rf /x': 'destructive',
    'find / -delete': 'destructive',
    'bash -c "rm -rf /x"': 'destructive',
    "/bin/sh -c 'rm -rf /x'": 'destructive',
    'eval "rm -rf /x"': 'destructive',
    'bash -lc "sudo id"': 'sudo',
    'curl x | /bin/sh': 'pipe',
    'curl x | sudo bash': 'pipe',
    '/usr/bin/sudo id': 'sudo',
    '/bin/su -': 'su',
    '/usr/bin/ssh host': 'ssh',
  };
  for (const [command, kind] of Object.entries(kinds)) assert.equal(classifyCommand(command)?.kind, kind, command);
  for (const command of ['rm arquivo', 'rm -v arquivo', 'rm -rf', 'echo rm -rf /x', 'ls /usr/bin/rm', 'bash -c "ls"', 'echo "rm -rf /x"']) assert.equal(classifyCommand(command), null, command);
});

test('a lista de comandos críticos tem limite e avisa o que ficou de fora', async () => {
  const text = `${prompt}sudo id\n`.repeat(MAX_EVENTS + 50);
  const { commands, omitted } = detectCommands(output(text));
  assert.equal(commands.length, MAX_EVENTS);
  assert.equal(omitted, 50);

  const insights = await buildInsights({
    rec: 'r',
    messages: [{ id: 1, pos: 0, time: 1000, timing: `>${text.length}`, out_txt: text }],
    settings: { kinds: ['sudo'], extra: [], prompts: ['debian'], alertsEnabled: false, idleSeconds: 30 },
  });
  assert.ok(insights.warnings.some((warning) => warning.includes('ficaram de fora')));
  assert.equal(insights.events.length, MAX_EVENTS);
});

test('um alerta anterior ao primeiro dado gravado fica no início da timeline', () => {
  const alert = { timestamp: new Date(1000).toISOString(), rule: { id: '5402', level: 3, description: 'd', groups: ['sudo'] }, data: { srcuser: 'u' }, full_log: 'sudo: COMMAND=/bin/id' };
  const [event] = correlate({ user: 'u', startMs: 2000, commands: [], alerts: [alert], hasOverlap: false });
  assert.equal(event.t, 0);
});

test('a leitura de uma gravação para no limite de tamanho', async () => {
  let pages = 0;
  const search = async () => {
    pages += 1;
    return { hits: { hits: Array.from({ length: PAGE_SIZE }, (_, index) => ({ _source: { id: index, out_txt: 'x'.repeat(100) }, sort: [index] })) } };
  };
  const { truncated } = await fetchAllChunks(search, 'r', 1e6, ['id'], PAGE_SIZE * 100 * 2);
  assert.equal(truncated, true);
  assert.equal(pages, 3);
});

test('o limitador respeita a concorrência e recusa o excesso', async () => {
  const run = createLimiter({ concurrency: 2, queue: 1 });
  let active = 0;
  let peak = 0;
  const release = [];
  const task = () =>
    run(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => release.push(resolve));
      active -= 1;
    });
  const running = [task(), task(), task()];
  await assert.rejects(task(), LimiterBusyError);
  await new Promise(setImmediate);
  release.splice(0).forEach((resolve) => resolve());
  await new Promise(setImmediate);
  release.splice(0).forEach((resolve) => resolve());
  await Promise.all(running);
  assert.equal(peak, 2);
});

const FILES = {
  agentLocalfile: collector('ossec-agent-localfile.xml'),
  fluentConf: collector('fluent-bit.conf'),
  logrotateConf: collector('tlog-logrotate.conf'),
  logrotateService: collector('tlog-logrotate.service'),
  logrotateTimer: collector('tlog-logrotate.timer'),
  recordAllPath: collector('tlog-record-all.path'),
  recordAllScript: collector('tlog-record-all.sh'),
  recordAllService: collector('tlog-record-all.service'),
  tlogConf: collector('tlog-rec-session.conf'),
};
const script = () =>
  buildInstallScript({
    indexerName: 'wazuh.indexer',
    writerUser: 'tlog_writer',
    caPem: fs.readFileSync(path.join(__dirname, 'fixtures-ca.pem'), 'utf8'),
    files: FILES,
    version: 'teste',
  });

test('o script preserva o setuid do tlog em atualizações do pacote', () => {
  const text = script();
  assert.match(text, /dpkg-statoverride --add "\$TLOG_USER" "\$TLOG_USER" 6755 \/usr\/bin\/tlog-rec-session/);
});

test('o script confere a chave do repositório antes de aceitá-la', () => {
  const text = script();
  const check = text.indexOf(`= '${FLUENT_KEY_FINGERPRINT}'`);
  assert.ok(check > 0);
  assert.ok(check < text.indexOf('--dearmor -o /usr/share/keyrings/fluentbit.gpg'));
  assert.ok(!text.includes('fluentbit.key | gpg'));
});

test('o script restringe o arquivo da senha antes de escrever nele', () => {
  const text = script();
  const restrict = text.indexOf('install -o root -g root -m 600 /dev/null /etc/fluent-bit/tlog.env');
  assert.ok(restrict > 0);
  assert.ok(restrict < text.indexOf('> /etc/fluent-bit/tlog.env'));
});

test('o script gerado é bash válido', () => {
  execFileSync('bash', ['-n'], { input: script() });
  execFileSync('bash', ['-n'], { input: FILES.recordAllScript });
});

test('só aceita endereços IP de verdade', () => {
  const ipError = (indexerIp) => validateInstallInput({ indexerName: 'a', indexerIp, writerUser: 'u', caPem: '' }).indexerIp;
  for (const value of ['192.168.64.1', '255.255.255.255', '::1', 'fd00::1']) assert.equal(ipError(value), undefined, value);
  for (const value of ['999.1.1.1', 'abcd', '1.2.3', '1.2.3.4;id', "1.2.3.4' #"]) assert.ok(ipError(value), value);
});

test('o conteúdo das sessões não vai para os alertas', () => {
  const text = script();
  assert.ok(!text.includes('<localfile>\n'));
  assert.ok(!text.includes('>> /var/ossec/etc/ossec.conf'));
  assert.match(text, /ATENÇÃO: o agente lê o log do tlog/);
  const rules = collector('wazuh-local_rules.xml');
  assert.match(rules, /<rule id="100501" level="0">/);
  assert.ok(!/<rule id="10050\d" level="[1-9]/.test(rules));
});

test('o Fluent Bit não para de ler o log por causa de uma linha longa', () => {
  assert.match(FILES.fluentConf, /Skip_Long_Lines\s+On/);
});

test('gravar todos não confunde nomes nem grupos parecidos', () => {
  const { recordAllScript } = FILES;
  assert.ok(!recordAllScript.includes('grep -q "^$user:"'));
  assert.ok(!recordAllScript.includes('grep -qwE'));
  assert.match(recordAllScript, /chmod 600 "\$EXCLUDED_FILE"/);
  assert.match(FILES.recordAllService, /StartLimitIntervalSec=0/);
});
