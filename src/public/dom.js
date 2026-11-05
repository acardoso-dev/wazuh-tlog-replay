/** Cria elementos sem innerHTML: host, usuário e comandos vêm das máquinas gravadas e não são confiáveis. */
export function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith('on')) {
      element.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'className' || key === 'value' || key === 'type' || key === 'disabled') {
      element[key] = value;
    } else {
      element.setAttribute(key, value);
    }
  }
  element.append(...children.filter((child) => child !== null && child !== undefined));
  return element;
}

export const formatDate = (value) => (value ? new Date(value).toLocaleString('pt-BR') : '-');
export const formatTime = (value) => new Date(value).toLocaleTimeString('pt-BR');

export function formatDuration(durationSeconds) {
  if (durationSeconds === null || durationSeconds === undefined) return '-';
  const seconds = Math.max(0, Math.round(durationSeconds));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes} min ${seconds % 60} s` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
