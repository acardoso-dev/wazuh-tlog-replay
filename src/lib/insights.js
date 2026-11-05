'use strict';

const { convert } = require('./tlog2asciicast');
const { DEFAULT_SETTINGS } = require('./settings');
const { buildActivity } = require('./activity');
const {
  KINDS,
  LOCAL_ADDRESS,
  compileDetection,
  correlate,
  describeRule,
  detectCommands,
  findLocalJumps,
  findLogin,
} = require('./session_events');
const {
  buildCloseAlertBody,
  buildLoginAlertsBody,
  buildOverlapBody,
  buildSessionAlertsBody,
  buildSessionAtBody,
  buildSessionStartsBody,
  parseOverlaps,
  parseSessionStarts,
} = require('./queries');

const { isoFromMs, isoFromSeconds } = require('./safe_time');
const { validPos } = require('./tlog2asciicast');

const sources = (body) => (body?.hits?.hits ?? []).map((hit) => hit._source);

/**
 * Timeline e eventos críticos de uma sessão. `searchLogs` lê `tlog-*` e `searchAlerts`, os alertas.
 * Sem permissão nos alertas, a sessão continua com o que está na captura.
 */
async function buildInsights({ rec, messages, searchLogs, searchAlerts, onAlertError, settings = DEFAULT_SETTINGS }) {
  const activity = buildActivity(messages, { idleGapMs: settings.idleSeconds * 1000 });
  const detection = compileDetection(settings);
  const { commands, promptsSeen, omitted, limited } = detectCommands(convert(messages).events, detection);
  if (omitted > 0) activity.warnings.push(`Só os primeiros ${commands.length} comandos críticos são listados; outros ${omitted} ficaram de fora. Veja o replay.`);
  if (limited) activity.warnings.push('A saída desta sessão tem edições de linha em excesso: comandos podem não ter sido reconhecidos. Veja o replay.');
  const { host, user } = messages.find((message) => message.host && message.user) ?? {};
  const startMs = activity.startedAt ? Date.parse(activity.startedAt) : null;
  const capture = commands.map((command) => ({ ...command, evidence: 'capture' }));
  const result = {
    ...activity,
    promptsSeen,
    events: capture,
    closedAtMs: null,
    login: null,
    alertsAvailable: false,
    // A tela não pode dizer "nenhum comando crítico" se parte da busca está desligada.
    partialDetection: settings.kinds.length < KINDS.length,
  };
  if (!settings.alertsEnabled) return { ...result, alertsDisabled: true };
  if (startMs === null || !host || !user) return result;

  let login;
  let closedAtMs = null;
  let alerts;
  try {
    login = findLogin(sources(await searchAlerts(buildLoginAlertsBody({ host, user, startMs }))), startMs);
    if (login?.pid && !login.ambiguous) {
      const fromMs = Date.parse(login.alert.timestamp);
      const [closed] = sources(await searchAlerts(buildCloseAlertBody({ host, pid: login.pid, fromMs })));
      const closedMs = Date.parse(closed?.timestamp);
      if (Number.isFinite(closedMs)) closedAtMs = closedMs - startMs;
    }
    const endMs = startMs + Math.max(closedAtMs ?? 0, activity.durationMs);
    alerts = sources(await searchAlerts(buildSessionAlertsBody({ host, fromMs: startMs - 2000, toMs: endMs + 3000 })));
  } catch (error) {
    onAlertError?.(error);
    return result;
  }

  const endMs = startMs + Math.max(closedAtMs ?? 0, activity.durationMs);
  const overlaps = parseOverlaps(await searchLogs(buildOverlapBody({ host, rec, fromMs: startMs - 5000, toMs: endMs + 60000 })));
  const events = correlate({
    user,
    startMs,
    commands,
    alerts,
    hasOverlap: overlaps.some((other) => other.user === user),
  });

  // Salto: a sessão de destino é a que começou junto do login vindo da própria máquina.
  for (const { event, alert } of findLocalJumps(events, alerts, startMs)) {
    event.rule = describeRule(alert);
    event.evidence = 'both';
    const [child] = sources(
      await searchLogs(
        buildSessionAtBody({ host, user: alert.data?.dstuser ?? user, rec, atMs: Date.parse(alert.timestamp) })
      )
    );
    const childStartedAt = isoFromSeconds(child?.time, validPos(child?.pos) ? -child.pos : 0);
    if (childStartedAt) event.childStartedAt = childStartedAt;
  }

  const isLocal = LOCAL_ADDRESS.test(login?.srcip ?? '');
  const parents =
    isLocal && overlaps.length > 0
      ? parseSessionStarts(await searchLogs(buildSessionStartsBody(overlaps.map((other) => other.rec)))).filter(
          (other) => other.startMs < startMs
        )
      : [];
  return {
    ...result,
    // Um tipo desligado também some quando vem só do alerta, como um sudo sem eco na captura.
    events: events.filter((event) => detection.enabled.has(event.kind)),
    closedAtMs,
    alertsAvailable: true,
    login: login
      ? {
          srcip: login.srcip,
          ambiguous: login.ambiguous,
          local: isLocal,
          // Só com um candidato: a outra sessão pode não ter sido a origem do salto.
          parentStartedAt: parents.length === 1 ? isoFromMs(parents[0].startMs) : null,
        }
      : null,
  };
}

module.exports = { buildInsights };
