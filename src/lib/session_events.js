'use strict';

const { t } = require('./i18n');
/**
 * Reconhece comandos críticos em uma captura e liga cada um aos alertas do Wazuh.
 *
 * O texto vem do eco do terminal, então é uma evidência parcial: não vê `ssh host comando`,
 * scripts nem conteúdo ofuscado. Por isso, cada evento informa de onde veio.
 */

const MAX_LINE = 2000;
const MAX_COMMAND = 200;
const MAX_EVENTS = 200;
// A senha do sudo pode demorar. Acima disso, o comando e o alerta não são tratados como um só.
const MATCH_AFTER_MS = 120000;
const MATCH_BEFORE_MS = 3000;

// Estas regras rodam sobre texto escrito por quem está sendo gravado, no servidor. Nenhuma pode
// ter repetição ambígua: uma linha preparada travaria o dashboard de todos os usuários.
// Também reconhece caminho (/bin/rm), escape de alias (\rm), variáveis, comandos que só repassam
// e o início do texto entregue a um shell (bash -c "rm -rf x", eval "rm -rf x").
const PATH_PREFIX = '(?:[^\\s;&|]*/|\\\\)?';
const SHELL_TEXT = '(?:(?:[^\\s;&|]*/)?(?:(?:ba|z|da)?sh\\s+-\\w*c|eval)\\s+["\']?)?';
const COMMAND_START = `(^|[;&|]\\s*)(?:\\w+=[^\\s;&|]*\\s+)*(?:(?:command|env|exec|nohup|time)\\s+)*${SHELL_TEXT}${PATH_PREFIX}`;
const FLAG = '-[\\w-]*\\s+';
// `rm` com ao menos uma opção de recursão ou força, seguida de um alvo.
const RM = `rm\\s+(?:${FLAG})*?(?=-\\w*[rf]|--recursive|--force)${FLAG}(?:${FLAG})*\\S`;
const DESTRUCTIVE = `(sudo\\s+${PATH_PREFIX})?(${RM}|dd\\s[^;&|]*\\bof=|mkfs(\\.\\w+)?\\s|shred\\s|wipefs\\s|shutdown\\b|reboot\\b|userdel\\s|chmod\\s+(-R\\s+)?777\\s|find\\s[^;&|]*\\s-delete\\b)`;
const KINDS = [
  { id: 'destructive', get label() { return t('kind.destructive'); }, hint: 'rm -rf, dd, mkfs, shred, wipefs, shutdown, reboot, userdel, chmod 777, find -delete' },
  { id: 'pipe', get label() { return t('kind.pipe'); }, hint: 'curl ... | sh' },
  { id: 'sudo', label: 'sudo', hint: '' },
  { id: 'su', label: 'su', hint: '' },
  { id: 'ssh', label: 'SSH', hint: 'ssh, scp, sftp' },
];
const BUILT_IN = {
  destructive: new RegExp(`${COMMAND_START}${DESTRUCTIVE}`),
  pipe: new RegExp(`\\|\\s*(?:sudo\\s+)?${PATH_PREFIX}(ba|z|da)?sh(\\s|$)`),
  sudo: new RegExp(`${COMMAND_START}sudo\\s+\\S`),
  su: new RegExp(`${COMMAND_START}su(\\s|$)`),
  ssh: new RegExp(`${COMMAND_START}(ssh|scp|sftp)\\s+\\S`),
};
const PROMPT_FORMATS = [
  { id: 'debian', get label() { return t('prompt.debian'); }, hint: 'Debian, Ubuntu', source: '[\\w.-]+@[\\w.-]+:[^#$]*[#$]\\s' },
  { id: 'rhel', get label() { return t('prompt.rhel'); }, hint: 'Fedora, RHEL', source: '\\[[\\w.-]+@[\\w.-]+[^\\]]*\\][#$]\\s' },
  { id: 'zsh', get label() { return t('prompt.zsh'); }, hint: 'zsh', source: '[\\w.-]+@[\\w.-]+ [^%#$]*[%#]\\s' },
  { id: 'macos', get label() { return t('prompt.macos'); }, get hint() { return t('prompt.macosHint'); }, source: '[\\w.-]+:\\S* [\\w.-]+[#$]\\s' },
  // Prompt de duas linhas: o comando fica na segunda, depois de └─$.
  { id: 'kali', label: '└─$', hint: 'Kali Linux', source: '\\u2514\\u2500[#$]\\s' },
];

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Monta as regras a partir das configurações. Os comandos extras entram como texto literal: uma
 * expressão regular escrita à mão poderia travar o servidor, que analisa todas as sessões.
 */
function compileDetection({ kinds, extra = [], prompts } = {}) {
  const enabled = new Set(kinds ?? KINDS.map(({ id }) => id));
  const formats = PROMPT_FORMATS.filter(({ id }) => (prompts ?? ['debian', 'rhel']).includes(id));
  const extras = extra.map((command) => escapeRegex(command).replace(/ +/g, '\\s+'));
  const patterns = KINDS.filter(({ id }) => enabled.has(id)).map(({ id, label }) => {
    const pattern =
      id === 'destructive' && extras.length > 0
        ? new RegExp(`${BUILT_IN.destructive.source}|${COMMAND_START}(sudo\\s+)?(${extras.join('|')})(\\s|$)`)
        : BUILT_IN[id];
    return [id, label, pattern];
  });
  const prompt =
    formats.length > 0
      ? new RegExp(`^(?:\\([^)]*\\)\\s*)?(?:${formats.map(({ source }) => source).join('|')})(.*)$`)
      : null;
  return { enabled, patterns, prompt };
}

const DEFAULT_DETECTION = compileDetection();

const CSI_FINAL = /[@-~]/;
// Inserir e apagar no meio da linha custa o tamanho dela. Sem teto, poucos KB de sequências
// escritas de propósito ocupam o servidor por minutos.
const MAX_EDIT_WORK = 200000000;

/**
 * Reproduz as linhas do terminal, com cursor: backspace e setas só movem o cursor, e o que apaga
 * é a sequência seguinte. A hora de cada linha é a do Enter, quando o comando começa a rodar.
 *
 * Entrega uma linha por vez: uma saída feita só de quebras de linha não pode virar milhões de
 * objetos em memória. `stats.limited` indica que o teto de edições foi atingido.
 */
function* scanLines(events, stats = {}) {
  let chars = [];
  let cursor = 0;
  let escape = null;
  let alternate = false;
  let editWork = 0;

  const canEdit = () => {
    editWork += chars.length + 1;
    if (editWork <= MAX_EDIT_WORK) return true;
    stats.limited = true;
    return false;
  };

  const applyCsi = (sequence) => {
    const final = sequence.at(-1);
    const params = sequence.slice(0, -1);
    const count = Number.parseInt(params, 10) || 1;
    if (/^\?(1049|1047|47)$/.test(params) && (final === 'h' || final === 'l')) {
      alternate = final === 'h';
      chars = [];
      cursor = 0;
    } else if (final === 'D') cursor = Math.max(0, cursor - count);
    else if (final === 'C') cursor += count;
    else if (final === 'K') {
      const mode = Number.parseInt(params, 10) || 0;
      if (mode === 0) chars.length = Math.min(chars.length, cursor);
      else if (mode === 2) chars = [];
    } else if (final === 'P') {
      if (canEdit()) chars.splice(cursor, count);
    } else if (final === '@' && cursor < chars.length && canEdit()) {
      // Inserir depois do fim não muda o texto, e a linha nunca passa de MAX_LINE.
      chars.splice(cursor, 0, ...Array(Math.min(count, MAX_LINE - cursor)).fill(' '));
      chars.length = Math.min(chars.length, MAX_LINE);
    }
  };

  for (const [time, code, data] of events) {
    if (code !== 'o') continue;
    for (const ch of data) {
      if (escape !== null) {
        escape += ch;
        const type = escape[0];
        if (type === ']') {
          // OSC, como o título da janela: termina em BEL ou em ESC \.
          if (ch === '\u0007' || escape.endsWith('\u001b\\') || escape.length > MAX_LINE) escape = null;
        } else if (type === '[') {
          if (escape.length > 1 && CSI_FINAL.test(ch)) {
            applyCsi(escape.slice(1));
            escape = null;
          } else if (escape.length > 64) escape = null;
        } else if (type === '(' || type === ')') {
          if (escape.length >= 2) escape = null;
        } else escape = null;
        continue;
      }
      if (ch === '\u001b') escape = '';
      else if (ch === '\n') {
        // A tela alternativa continua sendo lida: um comando `printf` bastaria para ligá-la e
        // esconder o resto da sessão. O que aparece nela é marcado, porque pode ser só texto
        // exibido por um programa, como o `less`.
        yield { text: chars.join('').trimEnd(), time, alternate };
        chars = [];
        cursor = 0;
      } else if (ch === '\r') cursor = 0;
      else if (ch === '\b') cursor = Math.max(0, cursor - 1);
      else if (ch >= ' ' && ch !== '\u007f' && cursor < MAX_LINE) {
        while (chars.length < cursor) chars.push(' ');
        chars[cursor] = ch;
        cursor += 1;
      }
    }
  }
}

const terminalLines = (events) => [...scanLines(events)];

function classifyCommand(command, detection = DEFAULT_DETECTION) {
  const text = command.slice(0, MAX_LINE);
  for (const [kind, label, pattern] of detection.patterns) {
    if (pattern.test(text)) return { kind, label };
  }
  return null;
}

/** Comando depois do prompt, ou `null` se a linha não tiver um prompt conhecido. */
const commandFromLine = (line, detection = DEFAULT_DETECTION) => detection.prompt?.exec(line.slice(0, MAX_LINE))?.[1] ?? null;

/** `events` no formato do asciicast, com tempo em segundos. */
function detectCommands(events, detection = DEFAULT_DETECTION) {
  const commands = [];
  const stats = {};
  let promptsSeen = 0;
  let omitted = 0;
  for (const { text, time, alternate } of scanLines(events, stats)) {
    if (!text) continue;
    const command = commandFromLine(text, detection);
    if (command === null) continue;
    promptsSeen += 1;
    const found = classifyCommand(command, detection);
    if (!found) continue;
    // Quem imprime milhares de falsos comandos não pode gerar uma resposta sem limite. O aviso
    // deixa claro que há mais, e o replay continua mostrando tudo.
    if (commands.length >= MAX_EVENTS) omitted += 1;
    else commands.push({ t: Math.round(time * 1000), ...found, command: command.slice(0, MAX_COMMAND), ...(alternate ? { alternate: true } : {}) });
  }
  return { commands, promptsSeen, omitted, limited: Boolean(stats.limited) };
}

const LOCAL_ADDRESS = /^(::1$|127\.)/;
const processId = (log) => /\b(?:sshd|sudo|su)\[(\d+)\]/.exec(log ?? '')?.[1] ?? null;

const describeRule = (alert) => ({
  id: alert.rule.id,
  level: alert.rule.level,
  description: alert.rule.description,
  mitre: alert.rule.mitre?.id ?? [],
});

/** Alerta de login mais próximo do início. Dois logins quase juntos deixam a origem incerta. */
function findLogin(alerts, startMs) {
  const near = alerts
    .map((alert) => ({ alert, distance: Math.abs(Date.parse(alert.timestamp) - startMs) }))
    .sort((a, b) => a.distance - b.distance);
  if (near.length === 0) return null;
  return {
    alert: near[0].alert,
    srcip: near[0].alert.data?.srcip ?? null,
    pid: processId(near[0].alert.full_log),
    ambiguous: near.length > 1 && near[1].distance - near[0].distance < 2000,
  };
}

/**
 * Liga os comandos da captura aos alertas da mesma máquina e do mesmo período.
 *
 * Só o horário não basta: uma sessão aberta dentro de outra veria os alertas da primeira. Por
 * isso, o usuário precisa bater e o alerta de sudo precisa citar o comando. Um alerta sem comando
 * correspondente só entra se não houver outra sessão aberta no período (`hasOverlap`).
 */
function correlate({ user, startMs, commands, alerts, hasOverlap }) {
  const events = commands.map((command) => ({ ...command, evidence: 'capture' }));
  const at = (alert) => Date.parse(alert.timestamp) - startMs;
  const inRange = (event, t) => t >= event.t - MATCH_BEFORE_MS && t <= event.t + MATCH_AFTER_MS;

  for (const alert of alerts) {
    if (!alert.rule.groups?.includes('sudo') || alert.data?.srcuser !== user) continue;
    const binary = /COMMAND=(\S+)/.exec(alert.full_log ?? '')?.[1]?.split('/').pop();
    const t = at(alert);
    const match = events.find(
      (event) => event.kind === 'sudo' && !event.rule && event.command.split(/\s+/).includes(binary) && inRange(event, t)
    );
    if (match) {
      match.rule = describeRule(alert);
      match.evidence = 'both';
    } else if (!hasOverlap) {
      events.push({
        // O alerta pode vir pouco antes do primeiro dado gravado; a timeline começa em zero.
        t: Math.max(0, t),
        kind: 'sudo',
        label: 'sudo',
        command: (/COMMAND=(.*)/.exec(alert.full_log ?? '')?.[1] ?? alert.rule.description).slice(0, MAX_COMMAND),
        evidence: 'wazuh',
        rule: describeRule(alert),
      });
    }
  }

  // O alerta de senha errada não traz o comando; vale a tentativa anterior mais próxima.
  for (const alert of alerts) {
    if (alert.rule.id !== '5503' || !/^(?:\S+ \d+ [\d:]+ \S+ )?sudo\[/.test(alert.full_log ?? '')) continue;
    if (alert.data?.srcuser !== user) continue;
    const t = at(alert);
    const match = [...events].reverse().find((event) => event.kind === 'sudo' && !event.rule && inRange(event, t));
    if (match) {
      match.rule = describeRule(alert);
      match.evidence = 'both';
      match.failed = true;
    }
  }
  return events.sort((a, b) => a.t - b.t).slice(0, MAX_EVENTS);
}

/** Um login vindo da própria máquina logo depois do `ssh` digitado é o destino do salto. */
function findLocalJumps(events, alerts, startMs) {
  const jumps = [];
  const used = new Set();
  for (const event of events) {
    if (event.kind !== 'ssh') continue;
    const alert = alerts.find((candidate) => {
      if (candidate.rule.id !== '5715' || used.has(candidate) || !LOCAL_ADDRESS.test(candidate.data?.srcip ?? '')) return false;
      const t = Date.parse(candidate.timestamp) - startMs;
      return t >= event.t - MATCH_BEFORE_MS && t <= event.t + MATCH_AFTER_MS;
    });
    if (alert) {
      used.add(alert);
      jumps.push({ event, alert });
    }
  }
  return jumps;
}

module.exports = {
  KINDS,
  LOCAL_ADDRESS,
  MAX_EVENTS,
  PROMPT_FORMATS,
  classifyCommand,
  commandFromLine,
  compileDetection,
  correlate,
  describeRule,
  detectCommands,
  findLocalJumps,
  findLogin,
  processId,
  terminalLines,
};
