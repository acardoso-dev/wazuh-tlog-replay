'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { END_OF_FILE, buildInstallScript, validLogin, validShell, validateInstallInput } = require('../src/lib/install_script');
const { buildMachines, installDefaults, machineStatus } = require('../src/lib/machines');
const { classifyCommand, commandFromLine, compileDetection, detectCommands } = require('../src/lib/session_events');

const collector = (name) => readFileSync(join(__dirname, '..', 'collector', name), 'utf8');
const caPem = readFileSync(join(__dirname, 'fixtures-ca.pem'), 'utf8');
const files = {
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
const input = { indexerName: 'wazuh.indexer', indexerIp: '192.168.64.1', writerUser: 'tlog_writer', caPem };

test('o script gerado é bash válido e traz os arquivos do projeto', () => {
  const script = buildInstallScript({ ...input, files, version: '0' });
  const path = join(mkdtempSync(join(tmpdir(), 'tlog-')), 's.sh');
  writeFileSync(path, script);
  execFileSync('bash', ['-n', path]);
  assert.ok(script.includes('Logstash_Prefix    tlog'));
  assert.ok(script.includes('"rate": 16384'));
  assert.ok(script.includes('BEGIN CERTIFICATE'));
  assert.ok(script.includes("INDEXER_IP='192.168.64.1'"));
  assert.ok(script.includes("cat > '/usr/local/sbin/tlog-record-all'"));
  assert.ok(!/systemctl enable[^\n]*tlog-record-all/.test(script), 'não liga a gravação de todos');
  assert.ok(!/^usermod/m.test(script.replace(/<<'TLOG_REPLAY_FIM_DO_ARQUIVO'[\s\S]*?TLOG_REPLAY_FIM_DO_ARQUIVO/g, '')), 'não ativa a gravação de ninguém');
});

test('entradas hostis não chegam ao script, que roda como root', () => {
  const bad = [
    { indexerName: "x'; rm -rf /; '" },
    { indexerName: '$(id)' },
    { indexerName: 'a b' },
    { indexerIp: '1.2.3.4; id' },
    { indexerIp: 'nome' },
    { writerUser: "a'b" },
    { writerUser: 'a b' },
    { caPem: 'nada' },
    { caPem: `-----BEGIN CERTIFICATE-----\n$(id)\n-----END CERTIFICATE-----\n` },
    { caPem: `${caPem}\n${END_OF_FILE}\nrm -rf /\n` },
  ];
  for (const change of bad) {
    assert.ok(Object.keys(validateInstallInput({ ...input, ...change })).length > 0, JSON.stringify(change));
    assert.throws(() => buildInstallScript({ ...input, ...change, files, version: '0' }));
  }
  assert.deepEqual(validateInstallInput(input), {});
  assert.deepEqual(validateInstallInput({ ...input, indexerIp: '' }), {});
});

test('usuário e shell dos comandos também são validados', () => {
  assert.ok(validLogin('kali'));
  for (const bad of ['a b', 'a;id', '$(id)', '', 'Root']) assert.ok(!validLogin(bad), bad);
  assert.ok(validShell('/usr/bin/zsh'));
  for (const bad of ['zsh', '/bin/sh; id', '']) assert.ok(!validShell(bad), bad);
});

test('o prompt do Kali lê o comando da segunda linha, quando ligado', () => {
  const on = compileDetection({ prompts: ['kali'] });
  assert.equal(commandFromLine('└─$ sudo id', on), 'sudo id');
  assert.equal(commandFromLine('└─# rm -rf /x', on), 'rm -rf /x');
  assert.equal(commandFromLine('┌──(ana㉿kali)-[~]', on), null);
  assert.equal(commandFromLine('└─$ sudo id', compileDetection()), null);
  const output = [[1, 'o', '\u001b[;32m┌──(ana㉿kali)-[\u001b[0;1m~\u001b[;32m]\r\r\n\u001b[;32m└─\u001b[1;34m$\u001b[0m \r\u001b[;32m└─\u001b[1;34m$\u001b[0m rm -rf /x\r\n']];
  const { commands, promptsSeen } = detectCommands(output, on);
  assert.equal(promptsSeen, 1);
  assert.equal(classifyCommand(commands[0].command, on).kind, 'destructive');
});

test('situação da máquina', () => {
  const base = { platform: 'kali', packages: [], recording: false, packagesVisible: true };
  assert.equal(machineStatus(base), 'missing');
  assert.equal(machineStatus({ ...base, packages: ['tlog'] }), 'partial');
  assert.equal(machineStatus({ ...base, packages: ['tlog', 'fluent-bit'] }), 'installed');
  assert.equal(machineStatus({ ...base, recording: true }), 'recording');
  assert.equal(machineStatus({ ...base, packagesVisible: false }), 'unknown');
  assert.equal(machineStatus({ ...base, platform: 'darwin' }), 'unsupported');
  assert.equal(machineStatus({ ...base, platform: 'centos' }), 'manual');
});

const forbidden = () => Object.assign(new Error('negado'), { statusCode: 403 });
const system = (id, hostname, platform) => ({ _source: { agent: { id, name: id }, host: { hostname, os: { name: platform, platform } } } });

test('a lista junta inventário, pacotes e gravações', async () => {
  const client = {
    search: async ({ index }) => {
      if (index.includes('system')) return { body: { hits: { hits: [system('2', 'b', 'kali'), system('1', 'a', 'ubuntu')] } } };
      if (index.includes('packages')) return { body: { hits: { hits: [{ _source: { agent: { id: '2' }, package: { name: 'tlog' } } }] } } };
      return { body: { aggregations: { hosts: { buckets: [{ key: 'a' }] } } } };
    },
  };
  const { machines, packagesVisible } = await buildMachines(client);
  assert.ok(packagesVisible);
  assert.deepEqual(machines.map(({ id, status }) => [id, status]), [['1', 'recording'], ['2', 'partial']]);
});

test('sem permissão nos pacotes ou no inventário, a lista não quebra', async () => {
  const noPackages = {
    search: async ({ index }) => {
      if (index.includes('packages')) throw forbidden();
      if (index.includes('system')) return { body: { hits: { hits: [system('1', 'a', 'kali')] } } };
      return { body: {} };
    },
  };
  assert.equal((await buildMachines(noPackages)).machines[0].status, 'unknown');
  const nothing = { search: async () => { throw forbidden(); } };
  assert.deepEqual(await buildMachines(nothing), { machines: [], inventoryVisible: false, packagesVisible: false });
});

test('os padrões vêm da configuração do dashboard, sem expor o resto dela', async () => {
  const config$ = { subscribe: ({ next }) => { next({ hosts: ['https://wazuh.indexer:9200'], password: 'segredo', ssl: { certificateAuthorities: [caPem], key: 'chave' } }); return { unsubscribe() {} }; } };
  const defaults = await installDefaults(config$);
  assert.deepEqual(Object.keys(defaults).sort(), ['caPem', 'indexerName']);
  assert.equal(defaults.indexerName, 'wazuh.indexer');
  assert.equal(defaults.caPem, caPem);
});

test('o gerador de linha de comando produz um script válido', () => {
  const root = join(__dirname, '..');
  const script = execFileSync(process.execPath, [
    join(root, 'scripts/install-script.mjs'),
    '--indexer-name=wazuh.indexer',
    '--writer-user=tlog_writer',
    `--ca=${join(__dirname, 'fixtures-ca.pem')}`,
  ], { encoding: 'utf8' });
  assert.match(script, /installs tlog and Fluent Bit/);
  execFileSync('bash', ['-n'], { input: script });
  assert.throws(() => execFileSync(process.execPath, [join(root, 'scripts/install-script.mjs'), '--indexer-name=a;b', '--writer-user=x', `--ca=${join(__dirname, 'fixtures-ca.pem')}`], { stdio: 'pipe' }));
});

test('o papel de escrita não permite apagar, e o de leitura só lê', () => {
  const role = (name) => JSON.parse(readFileSync(join(__dirname, '..', 'collector', name), 'utf8'));
  const writer = role('role-tlog-writer.json');
  assert.deepEqual(writer.index_permissions[0].index_patterns, ['tlog-*']);
  for (const action of writer.index_permissions[0].allowed_actions) {
    assert.ok(!/delete|update|\/\*$/.test(action), action);
  }
  assert.deepEqual(role('role-tlog-reader.json').index_permissions[0].allowed_actions, ['read']);
});
