import { t } from '../lib/i18n';
import { h, formatDuration, formatTime } from './dom';

const evidenceText = (id) => [t(`evidence.${id}.label`), t(`evidence.${id}.help`)];
const KINDS = ['destructive', 'pipe', 'sudo', 'su', 'ssh'];
const kindName = (kind) => t(`kind.${kind}`);

/** Ponto final real da sessão: o alerta de encerramento, quando existe, ou a última saída. */
export const sessionEnd = (insights) => Math.max(insights.closedAtMs ?? 0, insights.durationMs);

/** Um balão único para a página, usado pelos pontos da timeline e pelos chips. */
export function createBalloon() {
  const element = h('div', { className: 'tlog-balloon', role: 'tooltip', hidden: 'hidden' });
  const hide = () => element.setAttribute('hidden', 'hidden');
  const show = (target, build) => {
    element.replaceChildren(...build());
    element.removeAttribute('hidden');
    const box = target.getBoundingClientRect();
    const size = element.getBoundingClientRect();
    const left = Math.min(Math.max(8, box.left + box.width / 2 - size.width / 2), window.innerWidth - size.width - 8);
    const above = box.top - size.height - 8;
    element.style.left = `${left}px`;
    element.style.top = `${above > 8 ? above : box.bottom + 8}px`;
  };
  const attach = (target, build) => {
    target.addEventListener('mouseenter', () => show(target, build));
    target.addEventListener('mouseleave', hide);
    target.addEventListener('focus', () => show(target, build));
    target.addEventListener('blur', hide);
    return target;
  };
  return { element, attach, hide };
}

function timelineParts({ segments }, end) {
  const parts = [];
  let previousEnd = 0;
  for (const [start, stop] of segments) {
    if (start > previousEnd) parts.push({ kind: 'idle', start: previousEnd, end: start });
    parts.push({ kind: 'active', start, end: stop });
    previousEnd = stop;
  }
  if (end > previousEnd) parts.push({ kind: 'idle', start: previousEnd, end });
  return parts;
}

/** Barra, pontos, chips e detalhes de uma sessão. Devolve o conteúdo das duas áreas da linha. */
export function renderInsights(insights, fallbackStart, balloon, openAt) {
  const startMs = Date.parse(insights.startedAt ?? fallbackStart);
  const at = (offset) => formatTime(startMs + offset);
  const end = sessionEnd(insights);
  const percent = (value) => (end > 0 ? (Math.min(value, end) / end) * 100 : 0);
  const { warnings, events, login, idleGapMs } = insights;
  // Um intervalo curto até o encerramento é a demora do alerta, não uma pausa do usuário.
  const segments = insights.segments.map((segment) => [...segment]);
  const last = segments.at(-1);
  if (last && end > last[1] && end - last[1] < idleGapMs) last[1] = end;
  const activeMs = segments.reduce((total, [start, stop]) => total + stop - start, 0);
  const idleMs = end - activeMs;

  const bar = h('div', {
    className: 'tlog-timeline-bar tlog-timeline-bar--pins',
    role: 'img',
    'aria-label': t('timeline.aria', { start: at(0), end: at(end), active: formatDuration(activeMs / 1000), idle: formatDuration(idleMs / 1000), count: events.length }),
  });
  for (const part of timelineParts({ segments }, end)) {
    const name = part.kind === 'active' ? t('timeline.activity') : t('timeline.idle');
    const element = h('span', {
      className: `tlog-timeline-${part.kind}`,
      title: t('timeline.part', { name, start: at(part.start), end: at(part.end), duration: formatDuration((part.end - part.start) / 1000) }),
    });
    element.style.left = `${percent(part.start)}%`;
    element.style.width = end > 0 ? `${((part.end - part.start) / end) * 100}%` : '100%';
    bar.append(element);
  }
  const closedKnown = insights.closedAtMs !== null && insights.closedAtMs >= insights.durationMs;
  bar.append(
    h('span', { className: 'tlog-timeline-mark tlog-timeline-start', title: t('timeline.start', { time: at(0) }) }),
    h('span', {
      className: 'tlog-timeline-mark tlog-timeline-end',
      title: `${closedKnown ? t('timeline.closedByAlert') : t('timeline.lastOutput')}: ${at(end)}`,
    })
  );

  const timeLink = (label, moment) =>
    h(
      'button',
      {
        type: 'button',
        className: 'tlog-time-link',
        title: t('timeline.openHere'),
        'aria-label': t('timeline.openAt', { time: label }),
        onClick: () => openAt({ ...moment, label }),
      },
      label
    );

  const eventBalloon = (event) => [
    h('strong', {}, `${t('event.at', { kind: kindName(event.kind), time: at(event.t) })}${event.failed ? ` ${t('event.deniedSuffix')}` : ''}`),
    h('code', {}, event.command),
    h('div', {}, `${evidenceText(event.evidence)[0]}${event.rule ? ` · ${t('event.ruleLower', { id: event.rule.id })}` : ''}`),
  ];

  const pins = [];
  const detailRows = events.map((event, index) =>
    h(
      'tr',
      {},
      h('td', { 'data-label': t('details.time') }, timeLink(at(event.t), { kind: 'event', index })),
      h('td', { 'data-label': t('details.type') }, h('span', { className: `tlog-chip tlog-kind-${event.kind}` }, kindName(event.kind))),
      h(
        'td',
        { 'data-label': t('details.command') },
        h('code', {}, event.command),
        event.alternate ? h('div', { className: 'tlog-quiet' }, t('details.alternateScreen')) : null,
        event.childStartedAt ? h('div', { className: 'tlog-quiet' }, t('event.openedSession', { time: formatTime(event.childStartedAt) })) : null
      ),
      h(
        'td',
        { 'data-label': t('details.evidence') },
        h('span', { className: `tlog-evidence tlog-evidence-${event.evidence}`, title: evidenceText(event.evidence)[1] }, evidenceText(event.evidence)[0]),
        event.failed ? h('span', { className: 'tlog-evidence tlog-evidence-failed' }, t('details.denied')) : null
      ),
      h(
        'td',
        { 'data-label': t('details.alert') },
        event.rule
          ? h(
              'div',
              {},
              h('div', { className: 'tlog-nowrap' }, `${t('event.rule', { id: event.rule.id, level: event.rule.level })}${event.rule.mitre.length ? ` · ${event.rule.mitre.join(', ')}` : ''}`),
              h('div', { className: 'tlog-quiet' }, event.rule.description)
            )
          : h('span', { className: 'tlog-quiet' }, t('details.noAlert'))
      )
    )
  );
  const details = h(
    'div',
    { className: 'tlog-details-wrap', hidden: 'hidden' },
    h(
      'table',
      { className: 'tlog-details' },
      h('thead', {}, h('tr', {}, ...[t('details.time'), t('details.type'), t('details.command'), t('details.evidence'), t('details.alert')].map((title) => h('th', { scope: 'col' }, title)))),
      h('tbody', {}, ...detailRows)
    )
  );

  let toggleButton = null;
  const toggle = (force, focus) => {
    const open = force ?? details.hasAttribute('hidden');
    details.toggleAttribute('hidden', !open);
    if (toggleButton) {
      toggleButton.setAttribute('aria-expanded', String(open));
      toggleButton.textContent = open ? t('details.hide') : t('details.show');
    }
    detailRows.forEach((row, index) => row.classList.toggle('tlog-on', index === focus));
    pins.forEach((pin, index) => pin.classList.toggle('tlog-on', index === focus));
  };

  events.forEach((event, index) => {
    const pin = balloon.attach(
      h('button', {
        type: 'button',
        className: `tlog-pin tlog-kind-${event.kind}`,
        'aria-label': `${t('event.at', { kind: kindName(event.kind), time: at(event.t) })}: ${event.command}`,
        onClick: () => toggle(true, index),
      }),
      () => eventBalloon(event)
    );
    pin.style.left = `${percent(event.t)}%`;
    pins.push(pin);
    bar.append(pin);
  });

  const chips = h('div', { className: 'tlog-chips' });
  for (const kind of KINDS) {
    const label = kindName(kind);
    const list = events.filter((event) => event.kind === kind);
    if (list.length > 0) {
      const failed = list.filter((event) => event.failed).length;
      chips.append(
        balloon.attach(
          h('button', { type: 'button', className: `tlog-chip tlog-kind-${kind}`, onClick: () => toggle() }, label, h('b', {}, String(list.length))),
          () => [
            h('strong', {}, `${label}: ${list.length}${failed ? ` ${t('event.deniedCount', { count: failed })}` : ''}`),
            ...list.slice(0, 6).map((event) => h('code', {}, `${at(event.t)}  ${event.command}`)),
          ]
        )
      );
    }
  }
  if (login?.local) {
    chips.append(
      h(
        'span',
        { className: 'tlog-chip tlog-kind-ssh', title: t('login.localHelp') },
        login.parentStartedAt ? t('login.likelyJump', { time: formatTime(login.parentStartedAt) }) : t('login.local')
      )
    );
  } else if (login?.srcip) {
    chips.append(
      h(
        'span',
        {
          className: 'tlog-chip tlog-chip-neutral',
          title: login.ambiguous ? t('login.ambiguous') : t('login.alert'),
        },
        `${t('login.from', { ip: login.srcip })}${login.ambiguous ? ` ${t('login.uncertain')}` : ''}`
      )
    );
  }
  if (events.length > 0) {
    toggleButton = h('button', { type: 'button', className: 'tlog-link', 'aria-expanded': 'false', onClick: () => toggle() }, t('details.show'));
    chips.append(toggleButton);
  } else if (insights.promptsSeen > 0) {
    chips.append(h('span', { className: 'tlog-quiet' }, insights.partialDetection ? t('summary.noneEnabled') : t('summary.none')));
  } else {
    chips.append(
      h(
        'span',
        { className: 'tlog-quiet', title: t('summary.noPromptHelp') },
        t('summary.notVisible')
      )
    );
  }
  if (!insights.alertsAvailable && !insights.alertsDisabled) {
    chips.append(
      h(
        'span',
        { className: 'tlog-badge', title: t('summary.alertsPermission') },
        t('summary.alertsUnavailable')
      )
    );
  }

  const timeline = [
    bar,
    h(
      'div',
      { className: 'tlog-timeline-times' },
      timeLink(at(0), { kind: 'start' }),
      h('span', {}, t('timeline.totals', { active: formatDuration(activeMs / 1000), idle: formatDuration(idleMs / 1000) })),
      timeLink(at(end), { kind: 'end' })
    ),
    warnings.length > 0 ? h('span', { className: 'tlog-badge', title: warnings.join(' ') }, t('timeline.partial')) : null,
  ];
  return { timeline: timeline.filter(Boolean), summary: [chips, details] };
}

export const sessionFilters = () => [
  ['all', t('filter.all')],
  ['destructive', t('filter.destructive')],
  ['sudo', 'sudo'],
  ['ssh', 'SSH'],
  ['wazuh', t('filter.wazuh')],
];

const FILTER_KINDS = { destructive: ['destructive', 'pipe'], sudo: ['sudo', 'su'], ssh: ['ssh'] };

/** Um filtro sem nada para encontrar, por causa das configurações, não aparece. */
export function filterAvailable(id, settings) {
  if (id === 'wazuh') return settings.alertsEnabled;
  return FILTER_KINDS[id] ? FILTER_KINDS[id].some((kind) => settings.kinds.includes(kind)) : true;
}

export function matchesFilter(insights, id) {
  if (id === 'all') return true;
  if (!insights) return false;
  const { events } = insights;
  if (id === 'wazuh') return events.some((event) => event.rule);
  if (id === 'sudo') return events.some((event) => event.kind === 'sudo' || event.kind === 'su');
  if (id === 'destructive') return events.some((event) => event.kind === 'destructive' || event.kind === 'pipe');
  return events.some((event) => event.kind === id);
}
