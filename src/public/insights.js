import { h, formatDuration, formatTime } from './dom';

const EVIDENCE = {
  both: ['Captura + Wazuh', 'O comando aparece na gravação e o Wazuh gerou um alerta para ele.'],
  capture: ['Só na captura', 'O comando aparece na gravação, mas não há alerta do Wazuh ligado a ele.'],
  wazuh: ['Só no Wazuh', 'O Wazuh gerou o alerta, mas o comando não foi reconhecido na gravação.'],
};
const KINDS = [
  ['destructive', 'Destrutivo'],
  ['pipe', 'Pipe para shell'],
  ['sudo', 'sudo'],
  ['su', 'su'],
  ['ssh', 'SSH'],
];

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
    'aria-label': `Início às ${at(0)}. Fim às ${at(end)}. Ativa por ${formatDuration(activeMs / 1000)}, ociosa por ${formatDuration(idleMs / 1000)}. ${events.length} evento(s) crítico(s).`,
  });
  for (const part of timelineParts({ segments }, end)) {
    const name = part.kind === 'active' ? 'Atividade' : 'Ocioso';
    const element = h('span', {
      className: `tlog-timeline-${part.kind}`,
      title: `${name}: ${at(part.start)} até ${at(part.end)} (${formatDuration((part.end - part.start) / 1000)})`,
    });
    element.style.left = `${percent(part.start)}%`;
    element.style.width = end > 0 ? `${((part.end - part.start) / end) * 100}%` : '100%';
    bar.append(element);
  }
  const closedKnown = insights.closedAtMs !== null && insights.closedAtMs >= insights.durationMs;
  bar.append(
    h('span', { className: 'tlog-timeline-mark tlog-timeline-start', title: `Início: ${at(0)}` }),
    h('span', {
      className: 'tlog-timeline-mark tlog-timeline-end',
      title: `${closedKnown ? 'Encerrada, segundo o Wazuh' : 'Última saída gravada'}: ${at(end)}`,
    })
  );

  const timeLink = (label, moment) =>
    h(
      'button',
      {
        type: 'button',
        className: 'tlog-time-link',
        title: 'Abrir o replay neste momento',
        'aria-label': `Abrir o replay em ${label}`,
        onClick: () => openAt({ ...moment, label }),
      },
      label
    );

  const eventBalloon = (event) => [
    h('strong', {}, `${event.label} às ${at(event.t)}${event.failed ? ' (negado)' : ''}`),
    h('code', {}, event.command),
    h('div', {}, `${EVIDENCE[event.evidence][0]}${event.rule ? ` · regra ${event.rule.id}` : ''}`),
  ];

  const pins = [];
  const detailRows = events.map((event, index) =>
    h(
      'tr',
      {},
      h('td', { 'data-label': 'Hora' }, timeLink(at(event.t), { kind: 'event', index })),
      h('td', { 'data-label': 'Tipo' }, h('span', { className: `tlog-chip tlog-kind-${event.kind}` }, event.label)),
      h(
        'td',
        { 'data-label': 'Comando' },
        h('code', {}, event.command),
        event.alternate ? h('div', { className: 'tlog-quiet' }, 'Visto em tela alternativa: pode ser só texto exibido por um programa, como o less.') : null,
        event.childStartedAt ? h('div', { className: 'tlog-quiet' }, `Abriu uma sessão nesta máquina às ${formatTime(event.childStartedAt)}`) : null
      ),
      h(
        'td',
        { 'data-label': 'Evidência' },
        h('span', { className: `tlog-evidence tlog-evidence-${event.evidence}`, title: EVIDENCE[event.evidence][1] }, EVIDENCE[event.evidence][0]),
        event.failed ? h('span', { className: 'tlog-evidence tlog-evidence-failed' }, 'Negado') : null
      ),
      h(
        'td',
        { 'data-label': 'Alerta do Wazuh' },
        event.rule
          ? h(
              'div',
              {},
              h('div', { className: 'tlog-nowrap' }, `Regra ${event.rule.id} · nível ${event.rule.level}${event.rule.mitre.length ? ` · ${event.rule.mitre.join(', ')}` : ''}`),
              h('div', { className: 'tlog-quiet' }, event.rule.description)
            )
          : h('span', { className: 'tlog-quiet' }, 'Sem alerta')
      )
    )
  );
  const details = h(
    'div',
    { className: 'tlog-details-wrap', hidden: 'hidden' },
    h(
      'table',
      { className: 'tlog-details' },
      h('thead', {}, h('tr', {}, ...['Hora', 'Tipo', 'Comando', 'Evidência', 'Alerta do Wazuh'].map((title) => h('th', { scope: 'col' }, title)))),
      h('tbody', {}, ...detailRows)
    )
  );

  let toggleButton = null;
  const toggle = (force, focus) => {
    const open = force ?? details.hasAttribute('hidden');
    details.toggleAttribute('hidden', !open);
    if (toggleButton) {
      toggleButton.setAttribute('aria-expanded', String(open));
      toggleButton.textContent = open ? 'Ocultar detalhes' : 'Ver detalhes';
    }
    detailRows.forEach((row, index) => row.classList.toggle('tlog-on', index === focus));
    pins.forEach((pin, index) => pin.classList.toggle('tlog-on', index === focus));
  };

  events.forEach((event, index) => {
    const pin = balloon.attach(
      h('button', {
        type: 'button',
        className: `tlog-pin tlog-kind-${event.kind}`,
        'aria-label': `${event.label} às ${at(event.t)}: ${event.command}`,
        onClick: () => toggle(true, index),
      }),
      () => eventBalloon(event)
    );
    pin.style.left = `${percent(event.t)}%`;
    pins.push(pin);
    bar.append(pin);
  });

  const chips = h('div', { className: 'tlog-chips' });
  for (const [kind, label] of KINDS) {
    const list = events.filter((event) => event.kind === kind);
    if (list.length > 0) {
      const failed = list.filter((event) => event.failed).length;
      chips.append(
        balloon.attach(
          h('button', { type: 'button', className: `tlog-chip tlog-kind-${kind}`, onClick: () => toggle() }, label, h('b', {}, String(list.length))),
          () => [
            h('strong', {}, `${label}: ${list.length}${failed ? ` (${failed} negado)` : ''}`),
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
        { className: 'tlog-chip tlog-kind-ssh', title: 'O login veio da própria máquina. A origem é provável, não confirmada.' },
        login.parentStartedAt ? `Provável salto da sessão de ${formatTime(login.parentStartedAt)}` : 'Login local'
      )
    );
  } else if (login?.srcip) {
    chips.append(
      h(
        'span',
        {
          className: 'tlog-chip tlog-chip-neutral',
          title: login.ambiguous ? 'Outro login ocorreu quase ao mesmo tempo: a origem pode ser de outra sessão.' : 'Alerta de login do Wazuh',
        },
        `Login de ${login.srcip}${login.ambiguous ? ' (incerto)' : ''}`
      )
    );
  }
  if (events.length > 0) {
    toggleButton = h('button', { type: 'button', className: 'tlog-link', 'aria-expanded': 'false', onClick: () => toggle() }, 'Ver detalhes');
    chips.append(toggleButton);
  } else if (insights.promptsSeen > 0) {
    chips.append(h('span', { className: 'tlog-quiet' }, insights.partialDetection ? 'Nenhum comando crítico entre os tipos ligados' : 'Nenhum comando crítico reconhecido'));
  } else {
    chips.append(
      h(
        'span',
        { className: 'tlog-quiet', title: 'Sessões sem prompt reconhecido, como ssh host comando, não mostram o que foi executado.' },
        'Comandos não visíveis nesta captura'
      )
    );
  }
  if (!insights.alertsAvailable && !insights.alertsDisabled) {
    chips.append(
      h(
        'span',
        { className: 'tlog-badge', title: 'O usuário precisa da permissão read em wazuh-alerts-* para ver os alertas ligados à sessão.' },
        'Alertas indisponíveis'
      )
    );
  }

  const timeline = [
    bar,
    h(
      'div',
      { className: 'tlog-timeline-times' },
      timeLink(at(0), { kind: 'start' }),
      h('span', {}, `Ativa ${formatDuration(activeMs / 1000)} · Ociosa ${formatDuration(idleMs / 1000)}`),
      timeLink(at(end), { kind: 'end' })
    ),
    warnings.length > 0 ? h('span', { className: 'tlog-badge', title: warnings.join(' ') }, 'parcial') : null,
  ];
  return { timeline: timeline.filter(Boolean), summary: [chips, details] };
}

export const SESSION_FILTERS = [
  ['all', 'Todas'],
  ['destructive', 'Destrutivos'],
  ['sudo', 'sudo'],
  ['ssh', 'SSH'],
  ['wazuh', 'Com alerta do Wazuh'],
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
