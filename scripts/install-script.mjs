// Gera pela linha de comando o mesmo script da aba Instalar, sem precisar abrir o dashboard.
// Uso: npm run --silent install-script -- --indexer-name=NOME --writer-user=USUARIO --ca=CA.pem [--indexer-ip=IP] [--locale=en] [--out=ARQUIVO]
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { setLocale } = require('../src/lib/i18n');
const { buildInstallScript } = require('../src/lib/install_script');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const collector = (name) => readFileSync(join(root, 'collector', name), 'utf8');

const options = Object.fromEntries(
  process.argv.slice(2).map((argument) => {
    const match = /^--([a-z-]+)=(.*)$/s.exec(argument);
    if (!match) throw new Error(`Invalid argument: ${argument}`);
    return [match[1], match[2]];
  })
);
for (const name of ['indexer-name', 'writer-user', 'ca']) {
  if (!options[name]) throw new Error(`Missing --${name}=...`);
}

setLocale(options.locale ?? 'en');
const script = buildInstallScript({
  indexerName: options['indexer-name'],
  indexerIp: options['indexer-ip'] ?? '',
  writerUser: options['writer-user'],
  caPem: readFileSync(options.ca, 'utf8'),
  version: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version,
  files: {
    fluentConf: collector('fluent-bit.conf'),
    logrotateConf: collector('tlog-logrotate.conf'),
    logrotateService: collector('tlog-logrotate.service'),
    logrotateTimer: collector('tlog-logrotate.timer'),
    recordAllPath: collector('tlog-record-all.path'),
    recordAllScript: collector('tlog-record-all.sh'),
    recordAllService: collector('tlog-record-all.service'),
    tlogConf: collector('tlog-rec-session.conf'),
  },
});

if (options.out) writeFileSync(options.out, script, { mode: 0o644 });
else process.stdout.write(script);
