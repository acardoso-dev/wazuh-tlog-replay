// Gera as imagens de docs/images a partir do ambiente simulado, com dados fictícios.
// Uso: npm run build -- --osd-version=2.19.6 && npm run screenshots
// Precisa do Chrome ou Edge. Para outro caminho, defina CHROME_PATH.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'docs/images');
const HARNESS_PORT = 5690;
const DEBUG_PORT = 9333;
const WIDTH = 1440;
const SCALE = 1.5;

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function retry(action, attempts = 50) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      if (attempt === attempts) throw error;
      await wait(200);
    }
  }
}

function connect(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let nextId = 0;
  socket.addEventListener('message', ({ data }) => {
    const { id, result, error } = JSON.parse(data);
    if (!pending.has(id)) return;
    const { resolve, reject } = pending.get(id);
    pending.delete(id);
    if (error) reject(new Error(error.message));
    else resolve(result);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      nextId += 1;
      pending.set(nextId, { resolve, reject });
      socket.send(JSON.stringify({ id: nextId, method, params }));
    });
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve({ send, close: () => socket.close() }));
    socket.addEventListener('error', () => reject(new Error('Sem conexão com o navegador.')));
  });
}

const chromePath = CHROME_CANDIDATES.find((candidate) => candidate && existsSync(candidate));
if (!chromePath) throw new Error('Navegador não encontrado. Defina CHROME_PATH.');

const profile = mkdtempSync(join(tmpdir(), 'session-replay-shots-'));
const harness = spawn(process.execPath, [join(root, 'scripts/harness.mjs')], {
  env: { ...process.env, PORT: String(HARNESS_PORT), HARNESS_DEMO: '1' },
  stdio: 'ignore',
});
const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { stdio: 'ignore' }
);

async function capture() {
  const targets = await retry(async () => (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json());
  const page = await connect(targets.find(({ type }) => type === 'page').webSocketDebuggerUrl);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Emulation.setTimezoneOverride', { timezoneId: 'America/Sao_Paulo' });

  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await page.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? expression);
    return result.value;
  };
  const until = (expression) =>
    retry(async () => {
      if (!(await evaluate(expression))) throw new Error(`Não apareceu: ${expression}`);
    });
  const clickText = (selector, text) =>
    evaluate(`(() => {
      const item = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .find((element) => element.textContent.trim().startsWith(${JSON.stringify(text)}));
      if (!item) throw new Error('Não encontrado: ' + ${JSON.stringify(text)});
      item.click();
    })()`);
  const save = async (name, height = 900) => {
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: WIDTH,
      height,
      deviceScaleFactor: SCALE,
      mobile: false,
    });
    await wait(400);
    const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(output, `${name}.png`), Buffer.from(data, 'base64'));
    console.log(`docs/images/${name}.png`);
  };
  const open = async () => {
    await page.send('Page.navigate', { url: `http://127.0.0.1:${HARNESS_PORT}/` });
    await until(`document.querySelector('.tlog-app table tbody tr') !== null`);
    await wait(500);
  };

  await page.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH,
    height: 900,
    deviceScaleFactor: SCALE,
    mobile: false,
  });

  await open();
  await save('sessoes');

  await clickText('.tlog-app button', 'Ver detalhes');
  await wait(400);
  await save('detalhes', 1100);

  await open();
  await clickText('.tlog-app button', 'Ver detalhes');
  await wait(300);
  await evaluate(`(() => {
    const row = [...document.querySelectorAll('.tlog-app tr')]
      .findLast((item) => item.textContent.includes('rm -rf /tmp/demo/a') && item.querySelector('a, button'));
    row.querySelector('a, button').click();
  })()`);
  await until(`document.querySelector('.tlog-stage')?.querySelector('[class*="ap-"]') != null`);
  await wait(2000);
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH,
    height: 900,
    deviceScaleFactor: SCALE,
    mobile: false,
  });
  await evaluate(`document.querySelector('.tlog-replay').scrollIntoView({ block: 'start', behavior: 'instant' })`);
  await save('replay');

  for (const [tab, name] of [['Configurações', 'configuracoes'], ['Diagnóstico', 'diagnostico'], ['Instalar', 'instalar']]) {
    await open();
    await clickText('.tlog-tabs button, .tlog-tabs [role="tab"]', tab);
    await wait(900);
    await save(name, 1100);
  }
  page.close();
}

mkdirSync(output, { recursive: true });
try {
  await capture();
} finally {
  chrome.kill();
  harness.kill();
  await wait(300);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
}
