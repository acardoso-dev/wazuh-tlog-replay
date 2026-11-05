import * as AsciinemaPlayer from 'asciinema-player';
import playerCss from 'asciinema-player/dist/bundle/asciinema-player.css';
import appCss from './app.css';
import logoUrl from '../../assets/brand/logo.svg';
import { agentIdFromUrl } from '../lib/agent_url';
import { LOCALES, LOCALE_HEADER, getLocale, preferredLocale, setLocale, t, tn } from '../lib/i18n';
import { withMarkers } from '../lib/replay_markers';
import { h, formatDate, formatDuration } from './dom';
import { sessionFilters, createBalloon, filterAvailable, matchesFilter, renderInsights, sessionEnd } from './insights';
import { createSettingsPanel } from './settings_panel';
import { createDiagnosticsPanel } from './diagnostics_panel';
import { createInstallPanel } from './install_panel';
import { DEFAULT_SETTINGS } from '../lib/settings';

const API = '/api/tlog_replay/sessions';
const LOCALE_STORAGE_KEY = 'tlogReplay.locale';

function readStoredLocale() {
  try {
    return window.localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeLocale(locale) {
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Sem acesso ao armazenamento do navegador, a escolha vale até fechar o app.
  }
}

/** Toda chamada à API leva o idioma, para o servidor responder avisos e erros nele. */
const localizedHttp = (http) => {
  const withLocale = (options = {}) => ({ ...options, headers: { ...options.headers, [LOCALE_HEADER]: getLocale() } });
  return {
    get: (path, options) => http.get(path, withLocale(options)),
    put: (path, options) => http.put(path, withLocale(options)),
  };
};

const errorMessage = (error) =>
  error?.body?.message || error?.message || t('common.unexpectedError');

function mountApp({ http, application, chrome }, { element, history }, onLocaleChange) {
  let agentId = agentIdFromUrl(window.location.search);
  let player = null;
  let playerRec = null;
  let playerHasMarkers = false;
  let selectedRow = null;
  let listRequest = 0;
  let replayRequest = 0;
  let activityObserver = null;
  let sessionFilter = 'all';
  let sessionRows = [];
  let enqueueAll = () => {};
  let settings = DEFAULT_SETTINGS;
  const balloon = createBalloon();

  const style = h('style');
  style.textContent = `${playerCss}\n${appCss}`;

  const inputs = {
    host: h('input', { type: 'text', 'aria-label': t('sessions.machine'), placeholder: 'web01' }),
    user: h('input', { type: 'text', 'aria-label': t('sessions.user'), placeholder: 'root' }),
    q: h('input', { type: 'text', 'aria-label': t('sessions.outputText'), placeholder: 'rm -rf' }),
    from: h('input', { type: 'datetime-local', 'aria-label': t('sessions.from') }),
    to: h('input', { type: 'datetime-local', 'aria-label': t('sessions.to') }),
  };
  const label = (text, input) => h('label', {}, h('span', {}, text), input);
  const hostFilter = label(t('sessions.machine'), inputs.host);
  const heading = h('h1', {}, t('sessions.title'));
  const agentBar = h('div', { className: 'tlog-agent', hidden: 'hidden' });

  function renderAgentBar(agent) {
    chrome?.setBreadcrumbs?.([
      { text: 'Session Replay' },
      ...(agentId ? [{ text: agent?.name ?? t('sessions.agent', { id: agentId }) }] : []),
    ]);
    hostFilter.toggleAttribute('hidden', Boolean(agentId));
    if (!agentId) {
      heading.textContent = t('sessions.title');
      agentBar.setAttribute('hidden', 'hidden');
      agentBar.replaceChildren();
      return;
    }
    heading.textContent = t('sessions.titleForAgent', { name: agent?.name ?? t('sessions.agentLower', { id: agentId }) });
    agentBar.removeAttribute('hidden');
    const details = agent?.found
      ? t('sessions.agentDetails', { id: agent.id, host: agent.hostname })
      : t('sessions.agent', { id: agentId });
    const back = h('a', {}, t('sessions.backToAgent'));
    back.href = application.getUrlForApp('endpoints-summary', {
      path: `#/agents?tab=welcome&agent=${encodeURIComponent(agentId)}`,
    });
    agentBar.replaceChildren(
      h('span', {}, details),
      back,
      h(
        'button',
        {
          type: 'button',
          onClick: () => {
            agentId = null;
            history?.replace({ search: '' });
            renderAgentBar();
            loadSessions();
          },
        },
        t('sessions.viewAll')
      )
    );
  }
  renderAgentBar();

  const status = h('p', { className: 'tlog-status', role: 'status' });
  const legendItem = (className, text, kinds) => {
    const item = h('span', {}, h('i', { className }), text);
    if (kinds) item.dataset.kinds = kinds;
    return item;
  };
  const idleLegend = h('span');
  const legend = h(
    'p',
    { className: 'tlog-legend', hidden: 'hidden' },
    legendItem('tlog-legend-active', t('sessions.legend.active')),
    h('span', {}, h('i', { className: 'tlog-legend-idle' }), idleLegend),
    legendItem('tlog-pin-sample tlog-kind-destructive', t('kind.destructive'), 'destructive'),
    legendItem('tlog-pin-sample tlog-kind-pipe', t('kind.pipe'), 'pipe'),
    legendItem('tlog-pin-sample tlog-kind-sudo', t('sessions.legend.sudoSu'), 'sudo su'),
    legendItem('tlog-pin-sample tlog-kind-ssh', 'SSH', 'ssh'),
    h('span', {}, t('sessions.legend.end'))
  );
  const filterBar = h('div', { className: 'tlog-session-filters', role: 'group', 'aria-label': t('sessions.filter.label'), hidden: 'hidden' });
  const filterStatus = h('span', { className: 'tlog-quiet', role: 'status' });
  const filterButtons = sessionFilters().map(([id, text]) => {
    const button = h('button', { type: 'button', onClick: () => applyFilter(id) }, text);
    button.dataset.id = id;
    button.dataset.text = text;
    return button;
  });
  filterBar.append(...filterButtons, filterStatus);

  /** Mostra só o que as configurações deixam ligado. */
  function applySettings(values) {
    settings = values;
    idleLegend.textContent = t('sessions.legend.idle', { duration: formatDuration(values.idleSeconds) });
    legend.querySelectorAll('[data-kinds]').forEach((item) => {
      item.toggleAttribute('hidden', !item.dataset.kinds.split(' ').some((kind) => values.kinds.includes(kind)));
    });
    for (const button of filterButtons) button.toggleAttribute('hidden', !filterAvailable(button.dataset.id, values));
    if (!filterAvailable(sessionFilter, values)) sessionFilter = 'all';
  }

  function updateFilterState() {
    const done = sessionRows.filter((state) => state.done).length;
    const failed = sessionRows.filter((state) => state.failed).length;
    const complete = done === sessionRows.length;
    for (const button of filterButtons) {
      const { id, text } = button.dataset;
      button.setAttribute('aria-pressed', String(id === sessionFilter));
      // A contagem só é exata depois de analisar todas as sessões.
      const count = id === 'all' ? sessionRows.length : sessionRows.filter((state) => matchesFilter(state.insights, id)).length;
      button.textContent = complete || id === 'all' ? `${text} (${count})` : text;
    }
    let message = '';
    if (sessionFilter !== 'all') {
      if (!complete) message = t('sessions.filter.analyzing', { done, total: sessionRows.length });
      else if (failed > 0) message = tn('sessions.filter.failed', failed);
      else if (!sessionRows.some((state) => matchesFilter(state.insights, sessionFilter))) message = t('sessions.filter.noMatch');
    }
    filterStatus.textContent = message;
  }

  function applyFilter(id) {
    sessionFilter = id;
    balloon.hide();
    for (const state of sessionRows) {
      const visible = matchesFilter(state.insights, id);
      state.row.toggleAttribute('hidden', !visible);
      state.extra.toggleAttribute('hidden', !visible);
    }
    if (id !== 'all') enqueueAll();
    updateFilterState();
  }
  const tableBody = h('tbody');
  const table = h(
    'table',
    { className: 'tlog-table' },
    h(
      'thead',
      {},
      h(
        'tr',
        {},
        ...[t('sessions.column.start'), t('sessions.machine'), t('sessions.user'), t('sessions.column.duration'), t('sessions.column.timeline'), t('sessions.column.chunks'), ''].map((title) =>
          h('th', { scope: 'col' }, title)
        )
      )
    ),
    tableBody
  );

  const replayTitle = h('h2');
  const replayWarnings = h('ul', { className: 'tlog-warnings' });
  const replayStage = h('div', { className: 'tlog-stage' });
  const replaySection = h('section', { className: 'tlog-replay', hidden: 'hidden', tabindex: '-1' }, replayTitle, replayWarnings, replayStage);

  const disposePlayer = () => {
    if (player) {
      player.dispose();
      player = null;
    }
    playerRec = null;
    playerHasMarkers = false;
    replayStage.replaceChildren();
  };

  /** `moment`: o ponto da sessão a mostrar. Sem ele, o player abre do início, sem tocar. */
  const seekTo = (moment) => {
    if (moment.kind === 'event') return player.seek({ marker: moment.index });
    return player.seek(moment.kind === 'end' ? '100%' : 0);
  };

  async function openSession(session, row, insights, moment) {
    const request = ++replayRequest;
    if (selectedRow) selectedRow.classList.remove('tlog-selected');
    selectedRow = row;
    row.classList.add('tlog-selected');

    const title = `${session.user ?? '?'}@${session.host ?? '?'} · ${formatDate(insights?.startedAt ?? session.startedAt)}`;
    const showTitle = () => {
      replayTitle.textContent = moment ? t('sessions.replayAtMoment', { title, moment: moment.label }) : title;
    };
    const reveal = () => {
      replaySection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      replaySection.focus({ preventScroll: true });
    };

    // A mesma sessão já aberta só muda de ponto: não precisa baixar a gravação de novo. Aberta
    // antes de a análise terminar, ela não tem marcadores, e o salto para um evento falharia.
    if (moment && player && playerRec === session.rec && (moment.kind !== 'event' || playerHasMarkers)) {
      showTitle();
      await seekTo(moment);
      reveal();
      return;
    }

    disposePlayer();
    replaySection.removeAttribute('hidden');
    showTitle();
    replayWarnings.replaceChildren();
    replayStage.append(h('p', {}, t('sessions.loadingRecording')));

    try {
      const data = await http.get(`${API}/${encodeURIComponent(session.rec)}`);
      if (request !== replayRequest) return;
      replayStage.replaceChildren();
      replayWarnings.replaceChildren(...data.warnings.map((warning) => h('li', {}, warning)));
      player = AsciinemaPlayer.create({ data: withMarkers(data.cast, insights?.events), parser: 'asciicast' }, replayStage, {
        cols: data.width,
        rows: data.height,
        idleTimeLimit: settings.pauseSeconds,
        fit: 'width',
        preload: true,
        controls: true,
      });
      playerRec = session.rec;
      playerHasMarkers = Boolean(insights?.events?.length);
      if (moment) await seekTo(moment);
      if (request !== replayRequest) return;
      reveal();
    } catch (error) {
      if (request !== replayRequest) return;
      replayStage.replaceChildren(h('p', { className: 'tlog-error' }, errorMessage(error)));
    }
  }

  /** Analisa só as linhas visíveis, poucas por vez: a lista pode ter 500 sessões. Um filtro pede todas. */
  function watchActivity(loaders) {
    activityObserver?.disconnect();
    const pending = [];
    const queued = new Set();
    let running = 0;
    const enqueue = (row) => {
      if (!queued.has(row)) {
        queued.add(row);
        pending.push(loaders.get(row));
      }
    };
    const pump = () => {
      while (running < 4 && pending.length > 0) {
        running += 1;
        pending.shift()().finally(() => {
          running -= 1;
          pump();
        });
      }
    };
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            observer.unobserve(entry.target);
            enqueue(entry.target);
          }
        }
        pump();
      },
      { rootMargin: '200px' }
    );
    activityObserver = observer;
    for (const row of loaders.keys()) observer.observe(row);
    enqueueAll = () => {
      for (const row of loaders.keys()) enqueue(row);
      pump();
    };
  }

  async function loadSessions() {
    const request = ++listRequest;
    const query = agentId ? { agent: agentId } : {};
    for (const key of agentId ? ['user', 'q'] : ['host', 'user', 'q']) {
      const value = inputs[key].value.trim();
      if (value) query[key] = value;
    }
    for (const key of ['from', 'to']) {
      if (inputs[key].value) query[key] = new Date(inputs[key].value).toISOString();
    }

    status.className = 'tlog-status';
    status.textContent = t('common.loading');
    try {
      const { sessions, agent } = await http.get(API, { query });
      if (request !== listRequest) return;
      if (agentId) renderAgentBar(agent);
      if (agent && !agent.found) {
        status.textContent = t('sessions.agentNotFound', { id: agentId });
      } else {
        status.textContent =
          sessions.length === 0
            ? t('sessions.empty')
            : tn('sessions.count', sessions.length);
        if (sessions.length === 0 && agentId) {
          status.append(' ', h('button', { type: 'button', className: 'tlog-link', onClick: () => openInstall() }, t('sessions.howToInstall')));
        }
      }
      selectedRow = null;
      legend.toggleAttribute('hidden', sessions.length === 0);
      filterBar.toggleAttribute('hidden', sessions.length === 0);
      const loaders = new Map();
      sessionRows = [];
      tableBody.replaceChildren(
        ...sessions.flatMap((session) => {
          const incomplete = session.maxId !== null && session.maxId !== session.messages;
          const startCell = h('td', { 'data-label': t('sessions.column.start') }, formatDate(session.startedAt));
          const durationCell = h('td', { 'data-label': t('sessions.column.duration') }, formatDuration(session.durationSeconds));
          const timelineCell = h('td', { className: 'tlog-timeline' }, h('div', { className: 'tlog-timeline-bar tlog-timeline-bar--pins' }));
          const summaryCell = h('td', { colSpan: '7' }, h('span', { className: 'tlog-quiet' }, t('sessions.analyzing')));
          const row = h(
            'tr',
            { className: 'tlog-session' },
            startCell,
            h('td', { 'data-label': t('sessions.machine') }, session.host ?? '-'),
            h('td', { 'data-label': t('sessions.user') }, session.user ?? '-'),
            durationCell,
            timelineCell,
            h(
              'td',
              { 'data-label': t('sessions.column.chunks') },
              String(session.messages),
              incomplete && !query.q ? h('span', { className: 'tlog-badge' }, t('sessions.incomplete')) : null
            )
          );
          row.append(
            h('td', {}, h('button', { type: 'button', onClick: () => openSession(session, row, state.insights) }, t('sessions.play')))
          );
          const extra = h('tr', { className: 'tlog-session-extra' }, summaryCell);
          const state = { row, extra, insights: null, done: false, failed: false };
          sessionRows.push(state);
          loaders.set(row, async () => {
            if (request !== listRequest) return;
            try {
              const insights = await http.get(`${API}/${encodeURIComponent(session.rec)}/activity`);
              if (request !== listRequest) return;
              const { timeline, summary } = renderInsights(insights, session.startedAt, balloon, (moment) =>
                openSession(session, row, insights, moment)
              );
              timelineCell.replaceChildren(...timeline);
              summaryCell.replaceChildren(...summary);
              // A lista é aproximada e, em uma busca, só vê os pedaços que têm o texto buscado.
              durationCell.textContent = formatDuration(sessionEnd(insights) / 1000);
              if (insights.startedAt) startCell.textContent = formatDate(insights.startedAt);
              state.insights = insights;
            } catch (error) {
              if (request !== listRequest) return;
              state.failed = true;
              timelineCell.replaceChildren(
                h('span', { className: 'tlog-error', title: errorMessage(error) }, t('sessions.timelineUnavailable'))
              );
              summaryCell.replaceChildren();
            }
            state.done = true;
            const visible = matchesFilter(state.insights, sessionFilter);
            row.toggleAttribute('hidden', !visible);
            extra.toggleAttribute('hidden', !visible);
            updateFilterState();
          });
          return [row, extra];
        })
      );
      watchActivity(loaders);
      applyFilter(sessionFilter);
    } catch (error) {
      if (request !== listRequest) return;
      status.className = 'tlog-status tlog-error';
      status.textContent = errorMessage(error);
      legend.setAttribute('hidden', 'hidden');
      filterBar.setAttribute('hidden', 'hidden');
      sessionRows = [];
      tableBody.replaceChildren();
    }
  }

  const settingsPanel = createSettingsPanel({
    http,
    onSaved: (values) => {
      applySettings(values);
      // O player aberto e as linhas foram montados com os valores antigos.
      disposePlayer();
      replaySection.setAttribute('hidden', 'hidden');
      loadSessions();
    },
  });
  const diagnosticsPanel = createDiagnosticsPanel({ http, version: __TLOG_VERSION__ });
  const installPanel = createInstallPanel({
    http,
    getAgentId: () => agentId,
    getSettings: () => settings,
    onOpenSettings: () => selectTab(TABS.find((tab) => tab.id === 'settings')),
  });

  const form = h(
    'form',
    {
      className: 'tlog-filters',
      onSubmit: (event) => {
        event.preventDefault();
        loadSessions();
      },
    },
    hostFilter,
    label(t('sessions.user'), inputs.user),
    label(t('sessions.outputText'), inputs.q),
    label(t('sessions.from'), inputs.from),
    label(t('sessions.to'), inputs.to),
    h('button', { type: 'submit' }, t('sessions.search'))
  );

  const sessionsPanel = h(
    'div',
    {},
    form,
    filterBar,
    status,
    legend,
    h('div', { className: 'tlog-table-wrap' }, table),
    replaySection
  );
  const TABS = [
    { id: 'sessions', title: t('tabs.sessions'), panel: sessionsPanel },
    { id: 'settings', title: t('tabs.settings'), panel: settingsPanel.element },
    { id: 'diagnostics', title: t('tabs.diagnostics'), panel: diagnosticsPanel.element, onOpen: () => diagnosticsPanel.loadOnce() },
    { id: 'install', title: t('tabs.install'), panel: installPanel.element, onOpen: () => { installPanel.loadOnce(); installPanel.refresh(); } },
  ];
  const openInstall = () => selectTab(TABS.find((tab) => tab.id === 'install'));
  const selectTab = (tab, { focus = false, remember = true } = {}) => {
    for (const other of TABS) {
      const selected = other === tab;
      other.button.setAttribute('aria-selected', String(selected));
      other.button.tabIndex = selected ? 0 : -1;
      other.panel.toggleAttribute('hidden', !selected);
    }
    balloon.hide();
    tab.onOpen?.();
    if (focus) tab.button.focus();
    if (remember) {
      // Fica no endereço para o F5 voltar à mesma aba, sem perder o agente selecionado.
      const search = new URLSearchParams(window.location.search);
      if (tab.id === 'sessions') search.delete('tab');
      else search.set('tab', tab.id);
      const text = search.toString();
      history?.replace({ search: text ? `?${text}` : '' });
    }
  };
  const tabList = h('div', { className: 'tlog-tabs', role: 'tablist', 'aria-label': t('tabs.label') });
  TABS.forEach((tab, index) => {
    tab.panel.setAttribute('role', 'tabpanel');
    tab.panel.setAttribute('aria-label', tab.title);
    tab.button = h(
      'button',
      {
        type: 'button',
        role: 'tab',
        onClick: () => selectTab(tab),
        onKeydown: (event) => {
          const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
          if (step) selectTab(TABS[(index + step + TABS.length) % TABS.length], { focus: true });
        },
      },
      tab.title
    );
    tabList.append(tab.button);
  });

  const languageSelect = h(
    'label',
    { className: 'tlog-language' },
    h('span', {}, t('language.label')),
    h(
      'select',
      { onChange: (event) => onLocaleChange(event.target.value) },
      ...LOCALES.map(({ id, name }) => {
        const option = h('option', { value: id }, name);
        option.selected = id === getLocale();
        return option;
      })
    )
  );

  // O contêiner mede a área do app, que muda com o menu lateral do dashboard. O balão fica fora
  // dele: contêineres mudam a referência de position: fixed.
  const root = h(
    'div',
    { className: 'tlog-app', lang: getLocale() },
    style,
    h(
      'div',
      { className: 'tlog-container' },
      h('div', { className: 'tlog-title' }, h('img', { src: logoUrl, alt: '', width: '32', height: '32' }), heading, languageSelect),
      agentBar,
      tabList,
      ...TABS.map((tab) => tab.panel),
      h('p', { className: 'tlog-version' }, `Session Replay ${__TLOG_VERSION__}`)
    ),
    balloon.element
  );
  element.append(root);
  // A barra de salvar precisa de fundo opaco, da mesma cor da página, inclusive no tema escuro.
  for (let node = element; node; node = node.parentElement) {
    const color = getComputedStyle(node).backgroundColor;
    if (color && color !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(color)) {
      root.style.setProperty('--tlog-surface', color);
      break;
    }
  }
  const initialTab = TABS.find((tab) => tab.id === new URLSearchParams(window.location.search).get('tab')) ?? TABS[0];
  selectTab(initialTab, { remember: false });
  applySettings(DEFAULT_SETTINGS);
  // A lista espera as configurações: os filtros e a pausa dependem delas.
  settingsPanel.load().then((values) => {
    if (!root.isConnected) return;
    applySettings(values);
    loadSessions();
  });

  return () => {
    listRequest += 1;
    replayRequest += 1;
    activityObserver?.disconnect();
    diagnosticsPanel.cancel();
    installPanel.cancel();
    disposePlayer();
    root.remove();
  };
}

// Chamado pelo carregador fixo (src/public/index.js). Mudar esta assinatura quebra navegadores
// que ainda têm o carregador em cache.
export function mount({ http, application, chrome }, params) {
  setLocale(preferredLocale(readStoredLocale(), window.navigator.languages ?? [window.navigator.language]));
  const core = { http: localizedHttp(http), application, chrome };
  let unmount = null;
  // A tela é montada de novo no idioma novo. A aba continua a mesma, porque fica no endereço.
  const changeLocale = (locale) => {
    unmount();
    setLocale(locale);
    storeLocale(getLocale());
    unmount = mountApp(core, params, changeLocale);
  };
  unmount = mountApp(core, params, changeLocale);
  return () => unmount();
}
