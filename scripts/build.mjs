// Gera o .zip instalável sem precisar do código-fonte do OpenSearch Dashboards.
// Uso: npm run build -- --osd-version=2.19.x
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ID = 'tlogReplay';

const argument = process.argv.find((value) => value.startsWith('--osd-version='));
const osdVersion = argument?.split('=')[1];
if (!osdVersion) {
  console.error('Informe a versão do OpenSearch Dashboards: npm run build -- --osd-version=<versão>');
  process.exit(1);
}

// As licenças Apache-2.0 e MIT exigem que o texto acompanhe o código redistribuído no pacote.
function thirdPartyNotices(builds) {
  const inputs = builds.flatMap(({ metafile }) => Object.keys(metafile.inputs));
  const names = inputs.map((input) => /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input)?.[1]).filter(Boolean);
  // O asciinema-player já vem com as dependências embutidas: elas não aparecem no metafile.
  const found = new Set();
  const visit = (name) => {
    if (found.has(name)) return;
    found.add(name);
    const { dependencies = {} } = JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8'));
    Object.keys(dependencies).filter((item) => existsSync(join(root, 'node_modules', item))).forEach(visit);
  };
  names.forEach(visit);
  return [...found].sort().map((name) => {
    const directory = join(root, 'node_modules', name);
    const { version, license } = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    const file = ['LICENSE', 'LICENSE.md', 'LICENSE.txt'].map((item) => join(directory, item)).find(existsSync);
    if (!file) throw new Error(`Licença não encontrada para ${name}: não é possível redistribuí-lo.`);
    return `${'='.repeat(72)}\n${name} ${version} (${license})\n${'='.repeat(72)}\n\n${readFileSync(file, 'utf8').trim()}\n`;
  }).join('\n');
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_VERSION = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const dist = join(root, 'dist');
const stage = join(dist, 'stage');
const pluginDir = join(stage, 'opensearch-dashboards', PLUGIN_ID);

rmSync(dist, { recursive: true, force: true });
mkdirSync(pluginDir, { recursive: true });

writeFileSync(
  join(pluginDir, 'opensearch_dashboards.json'),
  `${JSON.stringify(
    {
      id: PLUGIN_ID,
      version: PLUGIN_VERSION,
      opensearchDashboardsVersion: osdVersion,
      server: true,
      ui: true,
      requiredPlugins: [],
      optionalPlugins: [],
    },
    null,
    2
  )}\n`
);
writeFileSync(
  join(pluginDir, 'package.json'),
  `${JSON.stringify({ name: PLUGIN_ID, version: PLUGIN_VERSION, license: 'Apache-2.0' }, null, 2)}\n`
);

await build({
  entryPoints: [join(root, 'src/server/index.js')],
  outfile: join(pluginDir, 'server/index.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node16',
  logLevel: 'warning',
});

const browser = {
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
  minify: true,
  metafile: true,
  loader: { '.svg': 'dataurl', '.css': 'text', '.conf': 'text', '.path': 'text', '.service': 'text', '.sh': 'text', '.timer': 'text', '.xml': 'text' },
  logLevel: 'warning',
};

// Carregador fixo: é o único arquivo que o navegador guarda em um endereço sem versão.
await build({
  ...browser,
  entryPoints: [join(root, 'src/public/index.js')],
  outfile: join(pluginDir, `target/public/${PLUGIN_ID}.plugin.js`),
});

// Código real, servido pela rota de assets com o hash do conteúdo no nome.
const appBuild = await build({
  ...browser,
  entryPoints: [join(root, 'src/public/app.js')],
  outfile: join(pluginDir, 'assets/app.js'),
  globalName: '__tlogReplayApp',
  define: { __TLOG_VERSION__: JSON.stringify(PLUGIN_VERSION) },
});
const menuBuild = await build({
  ...browser,
  entryPoints: [join(root, 'src/public/agent_menu.js')],
  outfile: join(pluginDir, 'assets/menu.js'),
  globalName: '__tlogReplayMenu',
});

cpSync(join(root, 'LICENSE'), join(pluginDir, 'LICENSE'));
cpSync(join(root, 'NOTICE'), join(pluginDir, 'NOTICE'));
writeFileSync(join(pluginDir, 'THIRD-PARTY-NOTICES.txt'), thirdPartyNotices([appBuild, menuBuild]));

const zipName = `${PLUGIN_ID}-${PLUGIN_VERSION}_osd-${osdVersion}.zip`;
execFileSync('zip', ['-qr', join(dist, zipName), 'opensearch-dashboards'], { cwd: stage });
console.log(`dist/${zipName}`);
