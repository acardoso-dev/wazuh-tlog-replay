import fluentConf from '../../collector/fluent-bit.conf';
import logrotateConf from '../../collector/tlog-logrotate.conf';
import logrotateService from '../../collector/tlog-logrotate.service';
import logrotateTimer from '../../collector/tlog-logrotate.timer';
import recordAllPath from '../../collector/tlog-record-all.path';
import recordAllScript from '../../collector/tlog-record-all.sh';
import recordAllService from '../../collector/tlog-record-all.service';
import tlogConf from '../../collector/tlog-rec-session.conf';
import { buildInstallScript, validLogin, validShell, validateInstallInput } from '../lib/install_script';
import { h } from './dom';

const FILES = { fluentConf, logrotateConf, logrotateService, logrotateTimer, recordAllPath, recordAllScript, recordAllService, tlogConf };
const STORAGE_KEY = 'tlogReplay.install';
const SCRIPT_NAME = 'tlog-install.sh';
const STATUS = {
  recording: ['Gravando', 'Já há sessões desta máquina no índice.', 'ok'],
  installed: ['Instalado, sem sessões', 'Os pacotes existem, mas ainda não chegou nenhuma sessão: ative a gravação de um usuário.', 'attention'],
  partial: ['Instalação incompleta', 'Só um dos pacotes foi encontrado.', 'attention'],
  missing: ['Falta instalar', 'O inventário não encontrou o tlog nem o Fluent Bit.', 'attention'],
  unknown: ['Não verificado', 'Seu usuário não lê o inventário de pacotes.', 'unknown'],
  unsupported: ['Sem suporte', 'O tlog só funciona em Linux.', 'unknown'],
  manual: ['Instalação manual', 'O script não atende esta distribuição. Siga a instalação manual na documentação do projeto.', 'unknown'],
};

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

function copyButton(getText, label = 'Copiar') {
  const button = h(
    'button',
    {
      type: 'button',
      onClick: async () => {
        const done = await copyText(getText());
        button.textContent = done ? 'Copiado' : 'Não foi possível copiar';
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

  const machineStatus = h('p', { className: 'tlog-status', role: 'status' }, 'Carregando...');
  const machineBody = h('tbody');
  const machineTable = h(
    'div',
    { className: 'tlog-table-wrap', hidden: 'hidden' },
    h(
      'table',
      { className: 'tlog-simple-table' },
      h('thead', {}, h('tr', {}, ...['Agente', 'Máquina', 'Sistema', 'Situação', ''].map((title) => h('th', { scope: 'col' }, title)))),
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
    field('indexerName', 'Nome do indexador', 'O nome que consta no certificado do indexador.', { placeholder: 'wazuh.indexer' }),
    field('indexerIp', 'IP do indexador (opcional)', 'Só se a máquina não resolver esse nome: o script o adiciona ao /etc/hosts, e o TLS continua validado.', { placeholder: '192.168.64.1' }),
    field('writerUser', 'Usuário de escrita', 'O usuário do Fluent Bit. A senha é pedida ao rodar o script, e nunca passa pelo painel.'),
    field('caPem', 'CA do indexador', 'Certificado público, em formato PEM. Fica em /etc/fluent-bit/root-ca.pem.', { area: true }),
  ];

  const invalid = h('p', { className: 'tlog-error', hidden: 'hidden' }, 'Corrija os campos acima para gerar o script.');
  const scriptBlocked = h('p', { className: 'tlog-quiet', hidden: 'hidden' }, 'Este script não atende a máquina escolhida.');
  const scriptText = () => {
    if (Object.keys(validateInstallInput(values)).length > 0) return '';
    return buildInstallScript({ ...values, files: FILES, version: __TLOG_VERSION__ });
  };
  const pasteCommand = () => `cat > ${SCRIPT_NAME} <<'TLOG_REPLAY_INSTALADOR'\n${scriptText()}TLOG_REPLAY_INSTALADOR`;
  const copyScript = copyButton(pasteCommand, 'Copiar comando que cria o script');
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
    'Baixar script'
  );
  const scriptPreview = h('code');
  const runBlock = codeBlock(() => `sudo bash ${SCRIPT_NAME}`);
  const scriptArea = h(
    'div',
    {},
    h('p', {}, 'Leve o script até a máquina: baixe e copie, ou cole no terminal dela o comando que o cria. Depois, rode:'),
    h('div', { className: 'tlog-install-actions' }, copyScript, download),
    runBlock.element,
    h(
      'ul',
      { className: 'tlog-install-list' },
      h('li', {}, 'Confere a conexão e a senha antes de instalar os pacotes.'),
      h('li', {}, 'Instala tlog, Fluent Bit e logrotate, com os limites de disco descritos na documentação do projeto.'),
      h('li', {}, 'Envia as sessões só pelo Fluent Bit, e avisa se o agente do Wazuh também estiver lendo o log do tlog.'),
      h('li', {}, 'Pode rodar de novo com segurança. Não ativa a gravação de nenhum usuário.')
    ),
    h('details', { className: 'tlog-install-details' }, h('summary', {}, 'Ver o script completo'), h('pre', {}, scriptPreview))
  );

  const loginInput = h('input', { type: 'text', 'aria-label': 'Usuário a gravar', spellcheck: 'false', placeholder: 'kali', onInput: (event) => { login = event.target.value.trim(); refresh(); } });
  const shellInput = h('input', { type: 'text', 'aria-label': 'Shell atual do usuário', spellcheck: 'false', value: previousShell, onInput: (event) => { previousShell = event.target.value.trim(); shellEdited = true; refresh(); } });
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
  const emergencyInput = h('input', { type: 'text', 'aria-label': 'Usuários de emergência', spellcheck: 'false', placeholder: 'suporte', onInput: (event) => { emergency = event.target.value.trim(); refresh(); } });
  const emergencyError = h('div', { className: 'tlog-error tlog-setting-error', hidden: 'hidden' }, 'Use nomes de usuário Linux, separados por espaço.');
  const modeInput = (value, label) => {
    const input = h('input', { type: 'radio', name: 'tlog-record-mode', value, onChange: () => { recordMode = value; refresh(); } });
    input.checked = value === recordMode;
    return h('label', { className: 'tlog-install-mode' }, input, label);
  };
  const allArea = h(
    'div',
    {},
    h('p', {}, 'Todo usuário local passa a ser gravado, e os criados depois também, assim que aparecem no /etc/passwd. Quem trocar o próprio shell volta a ser gravado.'),
    h('p', { className: 'tlog-setting-warning' }, 'Se o tlog falhar, nenhum usuário gravado consegue entrar. Por isso, um usuário de emergência com senha e sudo fica fora da gravação, e o comando se recusa a rodar sem ele. As sessões desse usuário não aparecem aqui: use-o só para manutenção.'),
    h('label', { className: 'tlog-install-field' }, h('span', { className: 'tlog-setting-title' }, 'Usuários de emergência'), h('span', { className: 'tlog-setting-help' }, 'Separados por espaço. Eles precisam existir na máquina.'), emergencyInput, emergencyError),
    h('p', {}, 'Se ainda não existir, crie o usuário de emergência:'),
    createEmergency.element,
    h('p', {}, 'Ative a gravação de todos:'),
    enableAll.element,
    h('p', {}, 'Para ver quem está sendo gravado, a qualquer momento:'),
    statusAll.element,
    h(
      'ul',
      { className: 'tlog-install-list' },
      h('li', {}, 'Vale só para usuários locais. Usuários de LDAP ou AD não estão no /etc/passwd e precisam do SSSD, como no guia de instalação do projeto.'),
      h('li', {}, 'Comandos sem terminal, como ssh host comando, também são gravados. Contas de serviço com shell real entram: confira a lista antes e inclua as de automação entre as exceções.'),
      h('li', {}, 'Baixar arquivos de um usuário gravado por rsync ou scp -O fica limitado a cerca de 17 KB/s, e o conteúdo vai para o log. Para sftp e scp comum, use Subsystem sftp internal-sftp no sshd, sabendo que essas transferências deixam de ser gravadas. Enviar arquivos para a máquina não é afetado.'),
      h('li', {}, 'Para mudar as exceções depois, rode disable e enable de novo com a lista nova.'),
      h('li', {}, 'O root não muda, mas o que ele faz após um sudo ou su em uma sessão gravada aparece na gravação.')
    )
  );
  const oneArea = h('div', {});
  const verify = codeBlock(() => 'systemctl is-active fluent-bit wazuh-agent');
  const logs = codeBlock(() => 'sudo journalctl -u fluent-bit -n 30 --no-pager');
  const uninstall = codeBlock(() => 'sudo systemctl disable --now fluent-bit tlog-logrotate.timer\nsudo rm -f /etc/fluent-bit/tlog.env');
  const kaliNote = h(
    'p',
    { className: 'tlog-settings-notice', hidden: 'hidden' },
    'O prompt do Kali (└─$) está desligado. As sessões são gravadas, mas os comandos críticos só aparecem com esse formato ligado. ',
    h('button', { type: 'button', className: 'tlog-link', onClick: () => onOpenSettings() }, 'Abrir Configurações')
  );

  const element = h(
    'div',
    { className: 'tlog-install' },
    h(
      'p',
      { className: 'tlog-settings-notice' },
      'A instalação é feita em cada máquina. O agente do Wazuh não executa comandos remotos por padrão, e liberar isso permitiria rodar comandos como root em todas elas a partir do painel.'
    ),
    step(
      1,
      'Escolha a máquina',
      h('p', { className: 'tlog-quiet' }, 'A situação vem do inventário do Wazuh, que pode levar alguns minutos para mostrar uma instalação recente.'),
      machineStatus,
      machineTable,
      machineNote
    ),
    step(
      2,
      'Informe o indexador',
      h('p', { className: 'tlog-quiet' }, 'Antes da primeira máquina, crie o usuário de escrita e aplique o modelo do índice e as regras do manager, como no guia de instalação do projeto.'),
      h('div', { className: 'tlog-install-fields' }, ...fields.map(({ element: item }) => item))
    ),
    step(3, 'Rode o script na máquina', invalid, scriptBlocked, scriptArea),
    step(
      4,
      'Ative a gravação',
      h(
        'p',
        { className: 'tlog-setting-warning' },
        'Um erro no shell pode impedir o login. Mantenha outra sessão aberta, com um usuário administrativo sem gravação, até confirmar que o login funciona.'
      ),
      h('div', { className: 'tlog-install-modes', role: 'group', 'aria-label': 'Quem gravar' }, modeInput('all', 'Todos os usuários'), modeInput('one', 'Só um usuário')),
      allArea,
      oneArea
    ),
    step(
      5,
      'Confirme',
      h('p', {}, 'Abra uma sessão nova com um usuário gravado, rode alguns comandos e veja se ela aparece na aba Sessões em alguns segundos. Se não aparecer, confira os serviços e o log na máquina:'),
      verify.element,
      logs.element,
      kaliNote,
      h(
        'details',
        { className: 'tlog-install-details' },
        h('summary', {}, 'Desfazer'),
        h('p', {}, 'Se ativou para todos, isto restaura o shell de cada usuário:'),
        disableAll.element,
        h('p', {}, 'Se ativou para um usuário, volte o shell dele:'),
        rollback.element,
        h('p', {}, 'Pare a coleta e apague a senha do usuário de escrita guardada na máquina. Os pacotes e o log gravado continuam nela:'),
        uninstall.element
      )
    )
  );

  oneArea.append(
      h(
        'div',
        { className: 'tlog-install-fields' },
        h('label', { className: 'tlog-install-field' }, h('span', { className: 'tlog-setting-title' }, 'Usuário a gravar'), loginInput),
        h('label', { className: 'tlog-install-field' }, h('span', { className: 'tlog-setting-title' }, 'Shell atual do usuário'), h('span', { className: 'tlog-setting-help' }, 'Usado só no comando de desfazer. O primeiro comando abaixo mostra qual é.'), shellInput)
      ),
      h('p', {}, 'Veja o shell atual:'),
      checkShell.element,
      h('p', {}, 'Ative a gravação:'),
      activate.element,
      h('p', { className: 'tlog-quiet' }, 'O usuário gravado passa a usar o bash, mesmo que usasse outro shell. Scripts de início de sessão de outros shells deixam de rodar.')
  );

  function select(machine) {
    selected = machine;
    for (const row of machineBody.children) row.classList.toggle('tlog-selected', row.dataset.id === machine?.id);
    machineNote.textContent = machine ? `${machine.name ?? machine.id}: ${STATUS[machine.status][1]}` : '';
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
    machineStatus.textContent = 'Carregando...';
    try {
      const [list, defaults] = await Promise.all([http.get('/api/tlog_replay/machines'), http.get('/api/tlog_replay/install/defaults').catch(() => ({}))]);
      if (current !== request) return;
      if (!values.indexerName && defaults.indexerName) values.indexerName = defaults.indexerName;
      if (!values.caPem && defaults.caPem) values.caPem = defaults.caPem.trim();
      for (const { id, input } of fields) input.value = values[id];
      ({ machines } = list);
      if (!list.inventoryVisible) {
        machineStatus.textContent = 'Seu usuário não lê o inventário do Wazuh. O script abaixo funciona mesmo assim.';
      } else if (machines.length === 0) {
        machineStatus.textContent = 'Nenhum agente no inventário. O script abaixo funciona mesmo assim.';
      } else {
        const pending = machines.filter(({ status }) => ['missing', 'partial', 'installed'].includes(status)).length;
        machineStatus.textContent = `${machines.length} agente(s), ${pending} com instalação ou gravação pendente.${list.truncated ? ` Há mais agentes no inventário: só os primeiros ${machines.length} são mostrados.` : ''}`;
      }
      machineTable.toggleAttribute('hidden', machines.length === 0);
      machineBody.replaceChildren(
        ...machines.map((machine) => {
          const [text, help, level] = STATUS[machine.status];
          const row = h(
            'tr',
            {},
            h('td', {}, `${machine.id ?? '-'} · ${machine.name ?? '-'}`),
            h('td', {}, machine.hostname ?? '-'),
            h('td', {}, [machine.os, machine.architecture].filter(Boolean).join(' · ') || '-'),
            h('td', { title: help }, h('span', { className: 'tlog-diagnostics-name' }, h('i', { className: `tlog-dot tlog-dot-${level}` }), text)),
            h('td', {}, h('button', { type: 'button', 'aria-label': `Selecionar ${machine.name ?? machine.id}`, onClick: () => select(machine) }, 'Selecionar'))
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
      machineStatus.textContent = error?.body?.message || error?.message || 'Não foi possível carregar as máquinas.';
      refresh();
    }
  }

  refresh();
  return { element, load, loadOnce: () => (loaded ? undefined : load()), refresh, cancel: () => { request += 1; } };
}
