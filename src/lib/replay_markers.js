'use strict';

/**
 * Inclui os eventos críticos na gravação como marcadores do player.
 *
 * O player comprime as pausas longas, então a hora real não serve para o salto. O marcador passa
 * pela mesma compressão e continua no ponto certo. Ele entra depois dos dados com a mesma hora,
 * para o salto já mostrar o comando na tela. O índice de cada marcador é o do evento na lista.
 */
function withMarkers(cast, events) {
  if (!events?.length) return cast;
  const [header, ...lines] = cast.trimEnd().split('\n');
  const markers = events
    .map((event) => [event.t / 1000, 'm', `${event.label}: ${event.command}`])
    .sort((a, b) => a[0] - b[0]);
  const output = [header];
  let next = 0;
  for (const line of lines) {
    const time = JSON.parse(line)[0];
    while (next < markers.length && markers[next][0] < time) {
      output.push(JSON.stringify(markers[next]));
      next += 1;
    }
    output.push(line);
  }
  for (; next < markers.length; next += 1) output.push(JSON.stringify(markers[next]));
  return `${output.join('\n')}\n`;
}

module.exports = { withMarkers };
