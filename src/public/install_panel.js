import fluentConf from '../../collector/fluent-bit.conf';
import logrotateConf from '../../collector/tlog-logrotate.conf';
import logrotateService from '../../collector/tlog-logrotate.service';
import logrotateTimer from '../../collector/tlog-logrotate.timer';
import recordAllPath from '../../collector/tlog-record-all.path';
import recordAllScript from '../../collector/tlog-record-all.sh';
import recordAllService from '../../collector/tlog-record-all.service';
import tlogConf from '../../collector/tlog-rec-session.conf';
import { buildInstallScript, validLogin, validShell, validateInstallInput } from '../lib/install_script';
import { t, tn } from '../lib/i18n';
import { h } from './dom';

const FILES = { fluentConf, logrotateConf, logrotateService, logrotateTimer, recordAllPath, recordAllScript, recordAllService, tlogConf };
const STORAGE_KEY = 'tlogReplay.install';
const SCRIPT_NAME = 'tlog-install.sh';
const STATUS_LEVEL = { recording: 'ok', installed: 'attention', partial: 'attention', missing: 'attention', unknown: 'unknown', unsupported: 'unknown', manual: 'unknown' };
const machineState = (status) => [t(`machine.${status}.label`), t(`machine.${status}.help`), STATUS_LEVEL[status]];

const readStored = () => {
  try {
    return JSON.parse(window.localStorage.getItem(STORAGE_KEY)) ?? {};
  } catch {
    return {};
  }
};

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = h('textarea', { value: text, 'aria-hidden': 'true' });
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const done = document.execCommand('copy');
    area.remove();
    return done;
  }
}

function copyButton(getText, label = t('install.copy')) {
  const button = h(
    'button',
    {
      type: 'button',
      onClick: async () => {
        const done = await copyText(getText());
        button.textContent = done ? t('install.copied') : t('install.copyFailed');
        setTimeout(() => {
          button.textContent = label;
        }, 2000);
      },
    },
    label
  );
  return button;
}

function codeBlock(getText) {
  const code = h('code');
  const update = () => {
    code.textContent = getText();
  };
  update();
  return { element: h('div', { className: 'tlog-code' }, h('pre', {}, code), copyButton(getText)), update };
}

const step = (number, title, ...children) =>
  h(
    'section',
    { className: 'tlog-install-step' },
    h('h2', {}, h('span', { className: 'tlog-install-number' }, String(number)), title),
    ...children
  );

/** Aba Instalar: mostra quais máquinas faltam e gera o script para rodar em cada uma. */
export function createInstallPanel({ http, getAgentId, getSettings, onOpenSettings }) {
  let selected = null;
  let machines = [];
  let loaded = false;
  let request = 0;
  const stored = readStored();
  const values = {
    indexerName: stored.indexerName ?? '',
    indexerIp: stored.indexerIp ?? '',
    writerUser: stored.writerUser ?? 'tlog_writer',
    caPem: '',
  };
  let login = '';
  let previousShell = '/bin/bash';
  let shellEdited = false;
  let recordMode = 'all';
  let emergency = '';

  const machineStatus = h('p', { className: 'tlog-status', role: 'status' }, t('common.loading'));
  const machineBody = h('tbody');
  const machineTable = h(
    'div',
    { className: 'tlog-table-wrap', hidden: 'hidden' },
    h(
      'table',
      { className: 'tlog-simple-table' },
      h('thead', {}, h('tr', {}, ...[t('install.column.agent'), t('install.column.machine'), t('install.column.system'), t('install.column.status'), ''].map((title) => h('th', { scope: 'col' }, title)))),
      machineBody
    )
  );
  const machineNote = h('p', { className: 'tlog-settings-notice', hidden: 'hidden' });

  const field = (id, label, help, options = {}) => {
    const error = h('div', { className: 'tlog-error tlog-setting-error', hidden: 'hidden' });
    const onInput = (event) => {
      values[id] = event.target.value.trim();
      refresh();
    };
    const input = options.area
      ? h('textarea', { 'aria-label': label, spellcheck: 'false', placeholder: '-----BEGIN CERTIFICATE-----', onInput })
      : h('input', { type: 'text', 'aria-label': label, spellcheck: 'false', placeholder: options.placeholder ?? '', onInput });
    input.value = values[id];
    return { id, input, error, element: h('label', { className: 'tlog-install-field' }, h('span', { className: 'tlog-setting-title' }, label), h('span', { className: 'tlog-setting-help' }, help), input, error) };
  };
  const fields = [
    field('indexerName', t('install.indexerName'), t('install.indexerNameHelp'), { placeholder: 'wazuh.indexer' }),
    field('indexerIp', t('install.indexerIp'), t('install.indexerIpHelp'), { placeholder: '192.168.64.1' }),
    field('writerUser', t('install.writerUser'), t('install.writerUserHelp')),
    field('caPem', t('install.ca'), t('install.caHelp'), { area: true }),
  ];

  const invalid = h('p', { className: 'tlog-error', hidden: 'hidden' }, t('install.fixFields'));
  const scriptBlocked = h('p', { className: 'tlog-quiet', hidden: 'hidden' }, t('install.scriptBlocked'));
  const scriptText = () => {
    if (Object.keys(validateInstallInput(values)).length > 0) return '';
    return buildInstallScript({ ...values, files: FILES, version: __TLOG_VERSION__ });
  };
  const pasteCommand = () => `cat > ${SCRIPT_NAME} <<'TLOG_REPLAY_INSTALADOR'\n${scriptText()}TLOG_REPLAY_INSTALADOR`;
  const copyScript = copyButton(pasteCommand, t('install.copyCommand'));
  const download = h(
    'button',
    {
      type: 'button',
      onClick: () => {
        const link = h('a', { href: URL.createObjectURL(new Blob([scriptText()], { type: 'text/x-shellscript' })), download: SCRIPT_NAME });
        link.click();
        // Alguns navegadores só começam o download depois deste clique terminar.
        setTimeout(() => URL.revokeObjectURL(link.href), 60000);
      },
    },
    t('install.download')
  );
  const scriptPreview = h('code');
  const runBlock = codeBlock(() => `sudo bash ${SCRIPT_NAME}`);
  const scriptArea = h(
    'div',
    {},
    h('p', {}, t('install.carryScript')),
    h('div', { className: 'tlog-install-actions' }, copyScript, download),
    runBlock.element,
    h(
      'ul',
      { className: 'tlog-install-list' },
      h('li', {}, t('install.list.checks')),
      h('li', {}, t('install.list.installs')),
      h('li', {}, t('install.list.sends')),
      h('li', {}, t('install.list.safe'))
    ),
    h('details', { className: 'tlog-install-details' }, h('summary', {}, t('install.viewScript')), h('pre', {}, scriptPreview))
  );

  const loginInput = h('input', { type: 'text', 'aria-label': t('install.loginToRecord'), spellcheck: 'false', placeholder: 'kali', onInput: (event) => { login = event.target.value.trim(); refresh(); } });
  const shellInput = h('input', { type: 'text', 'aria-label': t('install.currentShell'), spellcheck: 'false', value: previousShell, onInput: (event) => { previousShell = event.target.value.trim(); shellEdited = true; refresh(); } });
  const loginName = () => (validLogin(login) ? login : 'USUARIO');
  const shellName = () => (validShell(previousShell) ? previousShell : '/bin/bash');
  const checkShell = codeBlock(() => `getent passwd ${loginName()} | cut -d: -f7`);
  const activate = codeBlock(() => `sudo usermod -s /usr/bin/tlog-rec-session ${loginName()}`);
  const rollback = codeBlock(() => `sudo usermod -s ${shellName()} ${loginName()}`);
  const emergencyNames = () => emergency.split(/\s+/).filter(Boolean);
  const emergencyValid = () => emergencyNames().length > 0 && emergencyNames().every(validLogin);
  const emergencyText = () => (emergencyValid() ? emergencyNames().join(' ') : 'USUARIO_DE_EMERGENCIA');
  const createEmergency = codeBlock(() => `sudo adduser ${emergencyValid() ? emergencyNames()[0] : 'USUARIO_DE_EMERGENCIA'}\nsudo usermod -aG sudo ${emergencyValid() ? emergencyNames()[0] : 'USUARIO_DE_EMERGENCIA'}`);
  const enableAll = codeBlock(() => `sudo tlog-record-all enable ${emergencyText()}`);
  const statusAll = codeBlock(() => 'sudo tlog-record-all status');
  const disableAll = codeBlock(() => 'sudo tlog-record-all disable');
  const emergencyInput = h('input', { type: 'text', 'aria-label': t('install.emergency'), spellcheck: 'false', placeholder: 'suporte', onInput: (event) => { emergency = event.target.value.trim(); refresh(); } });
  const emergencyError = h('div', { className: 'tlog-error tlog-setting-error', hidden: 'hidden' }, t('install.emergencyInvalid'));
  const modeInput = (value, label) => {
    const input = h('input', { type: 'radio', name: 'tlog-record-mode', value, onChange: () => { recordMode = value; refresh(); } });
    input.checked = value === recordMode;
    return h('label', { className: 'tlog-install-mode' }, input, label);
  };
  const allArea = h(
    'div',
    {},
    h('p', {}, t('install.all.intro')),
    h('p', { className: 'tlog-setting-warning' }, t('install.all.warning')),
    h('label', { className: 'tlog-install-field' }, h('span', { className: 'tlog-setting-title' }, t('install.emergency')), h('span', { className: 'tlog-setting-help' }, t('install.all.emergencyHelp')), emergencyInput, emergencyError),
    h('p', {}, t('install.all.create')),
    createEmergency.element,
    h('p', {}, t('install.all.enable')),
    enableAll.element,
    h('p', {}, t('install.all.status')),
    statusAll.element,
    h(
      'ul',
      { className: 'tlog-install-list' },
      h('li', {}, t('install.all.localOnly')),
      h('li', {}, t('install.all.noTerminal')),
      h('li', {}, t('install.all.downloads')),
      h('li', {}, t('install.all.change')),
      h('li', {}, t('install.all.root'))
    )
  );
  const oneArea = h('div', {});
  const verify = codeBlock(() => 'systemctl is-active fluent-bit wazuh-agent');
  const logs = codeBlock(() => 'sudo journalctl -u fluent-bit -n 30 --no-pager');
  const uninstall = codeBlock(() => 'sudo systemctl disable --now fluent-bit tlog-logrotate.timer\nsudo rm -f /etc/fluent-bit/tlog.env');
  const kaliNote = h(
    'p',
    { className: 'tlog-settings-notice', hidden: 'hidden' },
    t('install.kaliNote'),
    h('button', { type: 'button', className: 'tlog-link', onClick: () => onOpenSettings() }, t('install.openSettings'))
  );

  const element = h(
    'div',
    { className: 'tlog-install' },
    h(
      'p',
      { className: 'tlog-settings-notice' },
      t('install.notice')
    ),
    step(
      1,
      t('install.step1'),
      h('p', { className: 'tlog-quiet' }, t('install.step1Help')),
      machineStatus,
      machineTable,
      machineNote
    ),
    step(
      2,
      t('install.step2'),
      h('p', { className: 'tlog-quiet' }, t('install.step2Help')),
      h('div', { className: 'tlog-install-fields' }, ...fields.map(({ element: item }) => item))
    ),
    step(3, t('install.step3'), invalid, scriptBlocked, scriptArea),
    step(
      4,
      t('install.step4'),
      h(
        'p',
        { className: 'tlog-setting-warning' },
        t('install.step4Warning')
      ),
      h('div', { className: 'tlog-install-modes', role: 'group', 'aria-label': t('install.whoToRecord') }, modeInput('all', t('install.mode.all')), modeInput('one', t('install.mode.one'))),
      allArea,
      oneArea
    ),
    step(
      5,
      t('install.step5'),
      h('p', {}, t('install.step5Help')),
      verify.element,
      logs.element,
      kaliNote,
      h(
        'details',
        { className: 'tlog-install-details' },
        h('summary', {}, t('install.undo')),
        h('p', {}, t('install.undoAll')),
        disableAll.element,
        h('p', {}, t('install.undoOne')),
        rollback.element,
        h('p', {}, t('install.undoCollector')),
        uninstall.element
      )
    )
  );

  oneArea.append(
      h(
        'div',
        { className: 'tlog-install-fields' },
        h('label', { className: 'tlog-install-field' }, h('span', { className: 'tlog-setting-title' }, t('install.loginToRecord')), loginInput),
        h('label', { className: 'tlog-install-field' }, h('span', { className: 'tlog-setting-title' }, t('install.currentShell')), h('span', { className: 'tlog-setting-help' }, t('install.shellHelp')), shellInput)
      ),
      h('p', {}, t('install.viewShell')),
      checkShell.element,
      h('p', {}, t('install.activateOne')),
      activate.element,
      h('p', { className: 'tlog-quiet' }, t('install.bashNote'))
  );

  function select(machine) {
    selected = machine;
    for (const row of machineBody.children) row.classList.toggle('tlog-selected', row.dataset.id === machine?.id);
    machineNote.textContent = machine ? `${machine.name ?? machine.id}: ${machineState(machine.status)[1]}` : '';
    machineNote.toggleAttribute('hidden', !machine);
    // O Kali usa zsh por padrão. Se o usuário já mudou o campo, o valor dele fica.
    if (!shellEdited) {
      previousShell = machine?.platform === 'kali' ? '/usr/bin/zsh' : '/bin/bash';
      shellInput.value = previousShell;
    }
    refresh();
  }

  function refresh() {
    const errors = validateInstallInput(values);
    for (const { id, input, error } of fields) {
      const show = Boolean(errors[id]) && Boolean(values[id]);
      error.textContent = show ? errors[id] : '';
      error.toggleAttribute('hidden', !show);
      input.setAttribute('aria-invalid', String(show));
    }
    const ready = Object.keys(errors).length === 0;
    const blocked = selected?.status === 'unsupported' || selected?.status === 'manual';
    invalid.toggleAttribute('hidden', ready || blocked);
    scriptBlocked.toggleAttribute('hidden', !blocked);
    scriptArea.toggleAttribute('hidden', !ready || blocked);
    if (ready) {
      scriptPreview.textContent = scriptText();
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ indexerName: values.indexerName, indexerIp: values.indexerIp, writerUser: values.writerUser }));
      } catch {
        // Sem acesso ao armazenamento do navegador, o formulário só deixa de lembrar os valores.
      }
    }
    for (const block of [checkShell, activate, rollback, createEmergency, enableAll]) block.update();
    allArea.toggleAttribute('hidden', recordMode !== 'all');
    oneArea.toggleAttribute('hidden', recordMode !== 'one');
    emergencyError.toggleAttribute('hidden', !emergency || emergencyValid());
    const kali = selected?.platform === 'kali' && !getSettings().prompts.includes('kali');
    kaliNote.toggleAttribute('hidden', !kali);
  }

  async function load() {
    const current = ++request;
    loaded = true;
    machineStatus.className = 'tlog-status';
    machineStatus.textContent = t('common.loading');
    try {
      const [list, defaults] = await Promise.all([http.get('/api/tlog_replay/machines'), http.get('/api/tlog_replay/install/defaults').catch(() => ({}))]);
      if (current !== request) return;
      if (!values.indexerName && defaults.indexerName) values.indexerName = defaults.indexerName;
      if (!values.caPem && defaults.caPem) values.caPem = defaults.caPem.trim();
      for (const { id, input } of fields) input.value = values[id];
      ({ machines } = list);
      if (!list.inventoryVisible) {
        machineStatus.textContent = t('install.noInventory');
      } else if (machines.length === 0) {
        machineStatus.textContent = t('install.noAgents');
      } else {
        const pending = machines.filter(({ status }) => ['missing', 'partial', 'installed'].includes(status)).length;
        machineStatus.textContent = `${tn('install.agents', machines.length, { pending })}${list.truncated ? t('install.agentsTruncated', { count: machines.length }) : ''}`;
      }
      machineTable.toggleAttribute('hidden', machines.length === 0);
      machineBody.replaceChildren(
        ...machines.map((machine) => {
          const [text, help, level] = machineState(machine.status);
          const row = h(
            'tr',
            {},
            h('td', {}, `${machine.id ?? '-'} · ${machine.name ?? '-'}`),
            h('td', {}, machine.hostname ?? '-'),
            h('td', {}, [machine.os, machine.architecture].filter(Boolean).join(' · ') || '-'),
            h('td', { title: help }, h('span', { className: 'tlog-diagnostics-name' }, h('i', { className: `tlog-dot tlog-dot-${level}` }), text)),
            h('td', {}, h('button', { type: 'button', 'aria-label': t('install.selectMachine', { name: machine.name ?? machine.id }), onClick: () => select(machine) }, t('install.select')))
          );
          row.dataset.id = machine.id ?? '';
          return row;
        })
      );
      const agentId = getAgentId();
      select(machines.find((machine) => machine.id === agentId) ?? selected);
    } catch (error) {
      if (current !== request) return;
      machineStatus.className = 'tlog-status tlog-error';
      machineStatus.textContent = error?.body?.message || error?.message || t('install.loadFailed');
      refresh();
    }
  }

  refresh();
  return { element, load, loadOnce: () => (loaded ? undefined : load()), refresh, cancel: () => { request += 1; } };
}
