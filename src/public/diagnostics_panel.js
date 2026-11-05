import { t } from '../lib/i18n';
import { formatTime, h } from './dom';

const API = '/api/tlog_replay/diagnostics';
const DAY_MS = 86400000;

function timeAgo(ms) {
  if (ms === null) return '-';
  const minutes = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (minutes < 1) return t('time.now');
  if (minutes < 60) return t('time.minutes', { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 48) return t('time.hours', { count: hours });
  return t('time.days', { count: Math.round(hours / 24) });
}

/** Aba Diagnóstico: só leitura, com as permissões do usuário logado. */
export function createDiagnosticsPanel({ http, version }) {
  let request = 0;
  let loaded = false;
  const checkedAt = h('span', {}, t('diagnostics.checking'));
  const recheck = h('button', { type: 'button', onClick: () => load() }, t('diagnostics.recheck'));
  const error = h('p', { className: 'tlog-status tlog-error', hidden: 'hidden' });
  const cards = h('div', { className: 'tlog-diagnostics-cards' });
  const hostsBody = h('tbody');
  const hostsSection = h(
    'section',
    { hidden: 'hidden' },
    h('h2', {}, t('diagnostics.hosts.title')),
    h('p', { className: 'tlog-quiet' }, t('diagnostics.hosts.help')),
    h(
      'div',
      { className: 'tlog-table-wrap' },
      h(
        'table',
        { className: 'tlog-simple-table' },
        h('thead', {}, h('tr', {}, ...[t('diagnostics.hosts.machine'), t('diagnostics.hosts.last'), t('diagnostics.hosts.recent'), t('diagnostics.hosts.status')].map((title) => h('th', { scope: 'col' }, title)))),
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
      h('div', { className: 'tlog-diagnostics-name' }, h('i', { className: `tlog-dot tlog-dot-${status}` }), title, h('span', { className: 'tlog-quiet' }, t(`status.${status}`))),
      h('p', { className: 'tlog-quiet' }, detail)
    );

  async function load() {
    const current = ++request;
    loaded = true;
    recheck.disabled = true;
    checkedAt.textContent = t('diagnostics.checking');
    error.setAttribute('hidden', 'hidden');
    try {
      const data = await http.get(API);
      if (current !== request) return;
      checkedAt.textContent = t('diagnostics.checkedAt', { time: formatTime(data.checkedAt) });
      cards.replaceChildren(card({ title: t('diagnostics.plugin'), status: 'ok', detail: t('diagnostics.version', { version }) }), ...data.checks.map(card));
      hostsSection.toggleAttribute('hidden', data.hosts.length === 0);
      hostsBody.replaceChildren(
        ...data.hosts.map(({ host, lastMs, recentSessions }) => {
          const stale = lastMs === null || Date.now() - lastMs > data.recentDays * DAY_MS;
          return h(
            'tr',
            {},
            h('td', {}, host),
            h('td', {}, timeAgo(lastMs)),
            h('td', {}, t('diagnostics.hosts.recentCount', { count: recentSessions, days: data.recentDays })),
            h('td', {}, stale ? t('diagnostics.hosts.stale', { days: data.recentDays }) : t('diagnostics.hosts.receiving'))
          );
        })
      );
    } catch (failure) {
      if (current !== request) return;
      checkedAt.textContent = '';
      error.textContent = failure?.body?.message || failure?.message || t('diagnostics.failed');
      error.removeAttribute('hidden');
    } finally {
      if (current === request) recheck.disabled = false;
    }
  }

  return { element, load, loadOnce: () => (loaded ? undefined : load()), cancel: () => { request += 1; } };
}
