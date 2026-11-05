import { agentIdFromUrl, replayPath } from '../lib/agent_url';

/**
 * Adiciona o Session Replay à tela do agente, sem alterar arquivos do Wazuh.
 *
 * A lista desse menu é fixa no plugin do Wazuh, sem ponto de extensão. Por isso os itens são
 * inseridos no DOM. Se uma atualização mudar a tela, eles só deixam de aparecer, e o app
 * continua acessível pelo menu lateral.
 */
const MARKER = 'data-tlog-replay';
const LABEL = 'Session Replay';

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  node.setAttribute(MARKER, '');
  return node;
}

function bindReplayLink(link, application, agentId) {
  const path = replayPath(agentId);
  link.href = application.getUrlForApp('tlogReplay', { path });
  link.addEventListener('click', (event) => {
    // Ctrl/Cmd+clique continua abrindo em outra aba.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    application.navigateToApp('tlogReplay', { path });
  });
  return link;
}

function replayLink(application, agentId, className) {
  return bindReplayLink(element('a', className), application, agentId);
}

/**
 * Popover "More...": clona um grupo nativo, como Endpoint security, e troca o conteúdo.
 * Assim o grupo herda ícone, fontes e recuo sem depender de estilos próprios.
 */
function addToMoreMenu(application, agentId) {
  const grid = document.querySelector('.WzManagementSideMenu .euiFlexGrid');
  if (!grid || grid.querySelector(`[${MARKER}]`)) return;

  const column = grid.firstElementChild?.cloneNode(true);
  const icon = column?.querySelector('[class*="SideNavItemButton__icon"]');
  const label = column?.querySelector('[class*="SideNavItemButton__label"]');
  const items = column?.querySelector('[class*="SideNavItem__items"]');
  const link = items?.querySelector('a[href]');
  if (!icon || !label || !link) return;

  column.setAttribute(MARKER, '');
  // Um id repetido na página quebraria as referências de acessibilidade do grupo original.
  column.querySelectorAll('[id]').forEach((node) => node.removeAttribute('id'));
  column.querySelectorAll('[aria-controls]').forEach((node) => node.removeAttribute('aria-controls'));
  icon.replaceWith(videoIcon(icon));
  label.textContent = 'Session recording';
  label.removeAttribute('title');
  items.replaceChildren([...items.children].find((child) => child.contains(link)));
  // O item copiado pode estar selecionado ou com o ícone de fixar, visível só com o mouse em cima.
  items.querySelectorAll('[class*="isSelected"]').forEach((node) => {
    node.classList.remove(...[...node.classList].filter((name) => name.includes('isSelected')));
  });
  const linkItem = link.closest('[class*="FlexItem"]');
  if (linkItem) [...linkItem.parentNode.children].forEach((node) => node !== linkItem && node.remove());
  link.textContent = LABEL;
  bindReplayLink(link, application, agentId);
  grid.append(column);
}

/** Barra de abas: logo antes do botão "More...". */
function addTab(application, agentId) {
  if (document.querySelector(`.euiFlexItem[${MARKER}="tab"]`)) return;
  const more = [...document.querySelectorAll('button.euiButtonEmpty')].find(
    (button) => button.textContent.trim() === 'More...'
  );
  const moreItem = more?.closest('.euiFlexItem');
  if (!moreItem?.parentNode) return;

  const item = element('div', 'euiFlexItem euiFlexItem--flexGrowZero');
  item.setAttribute(MARKER, 'tab');
  item.style.marginLeft = '0';
  item.style.marginTop = '7px';
  const link = replayLink(application, agentId, 'euiButtonEmpty euiButtonEmpty--primary');
  const content = element('span', 'euiButtonContent euiButtonEmpty__content');
  content.append(element('span', 'euiButtonEmpty__text', LABEL));
  link.append(content);
  item.append(link);
  moreItem.parentNode.insertBefore(item, moreItem);
}

// Ícone videoPlayer do OUI (Apache-2.0), o mesmo usado na sidebar.
const VIDEO_ICON_PATH =
  'M0,1.99406028 C0,0.892771196 0.894513756,0 1.99406028,0 L14.0059397,0 C15.1072288,0 16,0.894513756 16,1.99406028 L16,14.0059397 C16,15.1072288 15.1054862,16 14.0059397,16 L1.99406028,16 C0.892771196,16 0,15.1054862 0,14.0059397 L0,1.99406028 Z M1,1.99406028 L1,14.0059397 C1,14.5539384 1.44579254,15 1.99406028,15 L14.0059397,15 C14.5539384,15 15,14.5542075 15,14.0059397 L15,1.99406028 C15,1.44606163 14.5542075,1 14.0059397,1 L1.99406028,1 C1.44606163,1 1,1.44579254 1,1.99406028 Z M1,4 L15,4 L15,5 L1,5 L1,4 Z M2.5,3 C2.22385763,3 2,2.77614237 2,2.5 C2,2.22385763 2.22385763,2 2.5,2 L3.5,2 C3.77614237,2 4,2.22385763 4,2.5 C4,2.77614237 3.77614237,3 3.5,3 L2.5,3 Z M5.5,3 C5.22385763,3 5,2.77614237 5,2.5 C5,2.22385763 5.22385763,2 5.5,2 L6.5,2 C6.77614237,2 7,2.22385763 7,2.5 C7,2.77614237 6.77614237,3 6.5,3 L5.5,3 Z M10.4472136,9.10557266 C11.1842621,9.4740969 11.1842621,10.5259027 10.4472136,10.8944269 L7.4472136,12.8944268 C6.7823125,13.2268773 6,12.7433816 6,11.9999996 L6,7.99999993 C6,7.25661796 6.7823125,6.77312228 7.4472136,7.1055728 L10.4472136,9.10557266 Z M10,9.99999993 L7,7.99999993 L7,11.9999999 L10,9.99999993 Z';

function videoIcon(original) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', original.getAttribute('class') ?? '');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.fill = 'currentColor';
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', VIDEO_ICON_PATH);
  svg.append(path);
  return svg;
}

/**
 * Home do Wazuh: clona um card real de "Security operations" e troca o conteúdo.
 * Clonar mantém a aparência sem depender das classes internas (nesta versão, ouiCard__*).
 * O clone não tem os eventos do React do original, por isso recebe o próprio clique.
 */
function addHomeCard(application) {
  if (document.querySelector(`[${MARKER}="card"]`)) return;
  const source = [...document.querySelectorAll('.wz-module-card-title')].find((card) =>
    card.textContent.trim().startsWith('IT Hygiene')
  );
  const sourceItem = source?.closest('[class*="FlexItem"]');
  const icon = source?.querySelector('svg');
  const description = source?.querySelector('[class*="Card__description"]');
  const title = source?.querySelector('a[href]');
  if (!sourceItem?.parentNode || !icon || !description || !title) return;

  const item = sourceItem.cloneNode(true);
  item.setAttribute(MARKER, 'card');
  const card = item.querySelector('.wz-module-card-title');
  const href = application.getUrlForApp('tlogReplay');
  card.removeAttribute('data-test-subj');
  card.setAttribute('data-test-subj', 'overviewWelcomeTlogReplay');
  card.querySelector('svg').replaceWith(videoIcon(icon));
  card.querySelector('[class*="Card__description"]').textContent =
    'Review and replay terminal sessions recorded on your endpoints.';
  const link = card.querySelector('a[href]');
  link.textContent = LABEL;
  link.href = href;
  item.addEventListener('click', (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    application.navigateToApp('tlogReplay');
  });
  sourceItem.parentNode.append(item);
}

export function installAgentMenu(application) {
  let lastAgent = null;
  let scheduled = false;

  const sync = () => {
    scheduled = false;
    if (window.location.pathname.endsWith('/app/wz-home')) addHomeCard(application);
    const onAgentView = window.location.hash.startsWith('#/agents');
    const agentId = onAgentView ? agentIdFromUrl(window.location.hash) : null;
    if (agentId !== lastAgent) {
      // Trocou de agente sem recarregar: os links antigos apontariam para o agente errado.
      document.querySelectorAll(`[${MARKER}]`).forEach((node) => node.remove());
      lastAgent = agentId;
    }
    if (!agentId) return;
    addToMoreMenu(application, agentId);
    addTab(application, agentId);
  };

  // O popover é criado e destruído pelo React; o timer agrupa rajadas de mudanças em uma verificação.
  const schedule = () => {
    if (!scheduled) {
      scheduled = true;
      setTimeout(sync, 50);
    }
  };
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  // Trocar de agente pode mudar só a URL, sem nenhuma mudança na página.
  window.addEventListener('hashchange', schedule);
  schedule();
}
