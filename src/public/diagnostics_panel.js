import { formatTime, h } from './dom';

const API = '/api/tlog_replay/diagnostics';
const STATUS = { ok: 'OK', attention: 'Atenção', unknown: 'Não verificado' };
const DAY_MS = 86400000;

function timeAgo(ms) {
  if (ms === null) return '-';
  const minutes = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (minutes < 1) return 'agora';
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `há ${hours} h`;
  return `há ${Math.round(hours / 24)} dias`;
}

/** Aba Diagnóstico: só leitura, com as permissões do usuário logado. */
export function createDiagnosticsPanel({ http, version }) {
  let request = 0;
  let loaded = false;
  const checkedAt = h('span', {}, 'Verificando...');
  const recheck = h('button', { type: 'button', onClick: () => load() }, 'Verificar novamente');
  const error = h('p', { className: 'tlog-status tlog-error', hidden: 'hidden' });
  const cards = h('div', { className: 'tlog-diagnostics-cards' });
  const hostsBody = h('tbody');
  const hostsSection = h(
    'section',
    { hidden: 'hidden' },
    h('h2', {}, 'Última gravação por máquina'),
    h('p', { className: 'tlog-quiet' }, 'Sem gravação recente não significa falha: pode ser que ninguém tenha entrado na máquina.'),
    h(
      'div',
      { className: 'tlog-table-wrap' },
      h(
        'table',
        { className: 'tlog-simple-table' },
        h('thead', {}, h('tr', {}, ...['Máquina', 'Última gravação', 'Sessões recentes', 'Situação'].map((title) => h('th', { scope: 'col' }, title)))),
        hostsBody
      )
    )
  );
  const element = h(
    'div',
    { className: 'tlog-diagnostics' },
    h('div', { className: 'tlog-settings-toolbar' }, checkedAt, h('span', { className: 'tlog-spacer' }), recheck),
    error,
    cards,
    hostsSection
  );

  const card = ({ title, status, detail }) =>
    h(
      'div',
      { className: 'tlog-diagnostics-card' },
      h('div', { className: 'tlog-diagnostics-name' }, h('i', { className: `tlog-dot tlog-dot-${status}` }), title, h('span', { className: 'tlog-quiet' }, STATUS[status])),
      h('p', { className: 'tlog-quiet' }, detail)
    );

  async function load() {
    const current = ++request;
    loaded = true;
    recheck.disabled = true;
    checkedAt.textContent = 'Verificando...';
    error.setAttribute('hidden', 'hidden');
    try {
      const data = await http.get(API);
      if (current !== request) return;
      checkedAt.textContent = `Somente leitura. Verificado às ${formatTime(data.checkedAt)}.`;
      cards.replaceChildren(card({ title: 'Plugin', status: 'ok', detail: `Versão ${version}.` }), ...data.checks.map(card));
      hostsSection.toggleAttribute('hidden', data.hosts.length === 0);
      hostsBody.replaceChildren(
        ...data.hosts.map(({ host, lastMs, recentSessions }) => {
          const stale = lastMs === null || Date.now() - lastMs > data.recentDays * DAY_MS;
          return h(
            'tr',
            {},
            h('td', {}, host),
            h('td', {}, timeAgo(lastMs)),
            h('td', {}, `${recentSessions} em ${data.recentDays} dias`),
            h('td', {}, stale ? `Sem gravação há mais de ${data.recentDays} dias: confira a coleta se houve acesso à máquina` : 'Recebendo')
          );
        })
      );
    } catch (failure) {
      if (current !== request) return;
      checkedAt.textContent = '';
      error.textContent = failure?.body?.message || failure?.message || 'Não foi possível fazer o diagnóstico.';
      error.removeAttribute('hidden');
    } finally {
      if (current === request) recheck.disabled = false;
    }
  }

  return { element, load, loadOnce: () => (loaded ? undefined : load()), cancel: () => { request += 1; } };
}
