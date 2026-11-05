'use strict';

const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { CATALOGS, FALLBACK_LOCALE, normalizeLocale, preferredLocale, setLocale, setLocaleProvider, t, tn } = require('../src/lib/i18n');
const { buildInstallScript, localizedRecordAll } = require('../src/lib/install_script');
const recordAllEnglish = require('../src/lib/messages/record_all_en');

const ROOT = path.join(__dirname, '..');
const collector = (name) => fs.readFileSync(path.join(ROOT, 'collector', name), 'utf8');
const placeholders = (message) => [...message.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'messages' ? [] : sourceFiles(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

function withLocale(locale, run) {
  setLocale(locale);
  try {
    return run();
  } finally {
    setLocale('pt-BR');
  }
}

test('os catálogos têm as mesmas mensagens e os mesmos parâmetros', () => {
  const { en, 'pt-BR': pt } = CATALOGS;
  assert.deepStrictEqual(Object.keys(pt).sort(), Object.keys(en).sort());
  for (const id of Object.keys(en)) {
    // Parâmetros iguais, sem contar ${VAR} do shell, que também aparecem nas duas versões.
    assert.deepStrictEqual(placeholders(pt[id]), placeholders(en[id]), id);
  }
});

test('toda mensagem usada no código existe no catálogo', () => {
  const used = new Set();
  for (const file of sourceFiles(path.join(ROOT, 'src'))) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/\bt\('([\w.]+)'/g)) used.add(match[1]);
    for (const match of source.matchAll(/\btn\('([\w.]+)'/g)) {
      used.add(`${match[1]}.one`);
      used.add(`${match[1]}.other`);
    }
  }
  assert.ok(used.size > 200);
  assert.deepStrictEqual([...used].filter((id) => !(id in CATALOGS.en)), []);
});

test('mensagens do script não têm apóstrofo, porque ficam entre aspas simples no shell', () => {
  for (const catalog of Object.values(CATALOGS)) {
    for (const [id, message] of Object.entries(catalog)) {
      if (id.startsWith('script.')) assert.ok(!message.includes("'"), id);
    }
  }
  for (const [, english] of recordAllEnglish) assert.ok(!english.includes("'"), english);
});

test('t troca só os parâmetros informados e cai no inglês', () => {
  withLocale('en', () => {
    assert.strictEqual(t('sessions.agent', { id: '001' }), 'Agent 001');
    assert.ok(t('script.unsupported').includes('${ID}'));
    assert.strictEqual(t('sem.mensagem'), 'sem.mensagem');
    assert.strictEqual(tn('sessions.count', 1), '1 session.');
  });
  withLocale('pt-BR', () => assert.strictEqual(tn('settings.unsaved', 2), '2 alterações não salvas'));
  assert.strictEqual(FALLBACK_LOCALE, 'en');
});

test('a escolha salva vale mais que o navegador, e o inglês é o padrão', () => {
  assert.strictEqual(normalizeLocale('en-US'), 'en');
  assert.strictEqual(normalizeLocale('pt-PT'), 'pt-BR');
  assert.strictEqual(normalizeLocale('fr'), null);
  assert.strictEqual(normalizeLocale(undefined), null);
  assert.strictEqual(preferredLocale('en', ['pt-BR']), 'en');
  assert.strictEqual(preferredLocale(null, ['fr-FR', 'pt-BR']), 'pt-BR');
  assert.strictEqual(preferredLocale('invalido', ['fr-FR']), 'en');
});

test('o comando tlog-record-all traduz todas as mensagens previstas', () => {
  const script = collector('tlog-record-all.sh');
  for (const [source] of recordAllEnglish) assert.ok(script.includes(source), source);
  withLocale('en', () => {
    assert.ok(!/[À-ÿ]/.test(localizedRecordAll(script)));
  });
  withLocale('pt-BR', () => assert.strictEqual(localizedRecordAll(script), script));
});

test('o script gerado é válido nos dois idiomas, e o inglês não tem português', () => {
  const files = {};
  const source = fs.readFileSync(path.join(ROOT, 'src/public/install_panel.js'), 'utf8');
  for (const [, key, name] of source.matchAll(/import (\w+) from '\.\.\/\.\.\/collector\/([^']+)'/g)) files[key] = collector(name);
  assert.ok(Object.keys(files).length > 3);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlog-i18n-'));
  try {
    for (const locale of ['en', 'pt-BR']) {
      const script = withLocale(locale, () =>
        buildInstallScript({ indexerName: 'wazuh.indexer', indexerIp: '', writerUser: 'tlog_writer', caPem: '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----', files, version: '0.0.0' })
      );
      const file = path.join(dir, `${locale}.sh`);
      fs.writeFileSync(file, script);
      execFileSync('bash', ['-n', file]);
      if (locale === 'en') assert.deepStrictEqual(script.split('\n').filter((line) => /[À-ÿ]/.test(line)), []);
    }
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('o servidor responde no idioma do cabeçalho, e cada requisição tem o seu', async () => {
  const { localized } = require('../src/server/index');
  const routes = new Map();
  const router = localized({ get: (config, handler) => routes.set(config.path, handler) });
  router.get({ path: '/x' }, async () => {
    // A espera prova que o idioma sobrevive ao await, com outras requisições no meio.
    await new Promise((resolve) => setTimeout(resolve, 5));
    return t('server.fileNotFound');
  });
  const ask = (locale) => routes.get('/x')({}, { headers: { 'x-tlog-replay-locale': locale } }, {});
  const answers = await Promise.all([ask('en'), ask('pt-BR'), ask('fr'), ask(undefined)]);
  assert.deepStrictEqual(answers, ['File not found.', 'Arquivo não encontrado.', 'File not found.', 'File not found.']);
  // Os demais testes voltam ao idioma do módulo.
  setLocaleProvider(null);
});
