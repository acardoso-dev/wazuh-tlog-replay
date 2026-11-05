import { commandFromLine, classifyCommand, compileDetection } from '../lib/session_events';
import { DEFAULT_SETTINGS, GROUPS, SETTINGS, displayValue, sameValue, validateSettings } from '../lib/settings';
import { formatDate, formatTime, h } from './dom';

const API = '/api/tlog_replay/settings';
const clone = (values) => Object.fromEntries(Object.entries(values).map(([id, value]) => [id, Array.isArray(value) ? [...value] : value]));
const errorMessage = (error) => error?.body?.message || error?.message || 'Erro inesperado ao falar com o servidor.';
const labelOf = (id) => SETTINGS.find((setting) => setting.id === id)?.label ?? id;
const describeChange = ({ id, from, to }) => `${labelOf(id)}: ${displayValue(id, from)} → ${displayValue(id, to)}`;

/** Aba Configurações. `onSaved` recebe os valores novos, para a lista de sessões usá-los. */
export function createSettingsPanel({ http, onSaved }) {
  let saved = clone(DEFAULT_SETTINGS);
  let draft = clone(DEFAULT_SETTINGS);
  let version = null;
  let canEdit = false;
  let history = [];
  let errors = {};
  let testerValue = 'teste@web01:~$ kubectl delete ns prod';
  const rows = new Map();

  const message = h('p', { className: 'tlog-status', role: 'status', hidden: 'hidden' });
  const reload = h('button', { type: 'button', hidden: 'hidden', onClick: () => load() }, 'Recarregar');
  const readOnlyNotice = h('p', { className: 'tlog-settings-notice', hidden: 'hidden' }, 'Você pode ver as configurações, mas só administradores podem alterá-las.');
  const search = h('input', { type: 'search', placeholder: 'Buscar configuração', 'aria-label': 'Buscar configuração', onInput: applyFilter });
  const onlyChanged = h('input', { type: 'checkbox', onChange: applyFilter });
  const restoreAll = h(
    'button',
    {
      type: 'button',
      className: 'tlog-link',
      onClick: () => {
        draft = clone(DEFAULT_SETTINGS);
        render();
      },
    },
    'Restaurar todos os padrões'
  );
  const nav = h('nav', { className: 'tlog-settings-nav', 'aria-label': 'Grupos de configurações' });
  const groups = h('div');
  const empty = h('p', { hidden: 'hidden' }, 'Nenhuma configuração encontrada.');
  const historyBody = h('tbody');
  const historySection = h(
    'section',
    { className: 'tlog-settings-group', hidden: 'hidden' },
    h('h2', {}, 'Últimas alterações'),
    h('p', { className: 'tlog-quiet' }, 'Quem alterou também fica registrado no log do dashboard.'),
    h(
      'div',
      { className: 'tlog-table-wrap' },
      h(
        'table',
        { className: 'tlog-simple-table' },
        h('thead', {}, h('tr', {}, ...['Quando', 'Quem', 'O que mudou'].map((title) => h('th', { scope: 'col' }, title)))),
        historyBody
      )
    )
  );

  const saveStatus = h('span');
  const saveButton = h('button', { type: 'button', className: 'tlog-primary', onClick: openReview }, 'Revisar e salvar');
  const saveBar = h(
    'div',
    { className: 'tlog-savebar', hidden: 'hidden' },
    saveStatus,
    h('span', { className: 'tlog-spacer' }),
    h(
      'button',
      {
        type: 'button',
        onClick: () => {
          draft = clone(saved);
          render();
        },
      },
      'Descartar'
    ),
    saveButton
  );

  const reviewList = h('div', { className: 'tlog-review-list' });
  const reviewError = h('p', { className: 'tlog-error', hidden: 'hidden' });
  const confirmButton = h('button', { type: 'button', className: 'tlog-primary', onClick: confirmSave }, 'Salvar');
  const review = h(
    'dialog',
    { className: 'tlog-review', 'aria-labelledby': 'tlog-review-title' },
    h('h2', { id: 'tlog-review-title' }, 'Salvar alterações?'),
    h('p', {}, 'As mudanças valem para todos os usuários, sem reiniciar o dashboard.'),
    reviewList,
    reviewError,
    h(
      'div',
      { className: 'tlog-review-actions' },
      h('button', { type: 'button', onClick: () => review.close() }, 'Voltar'),
      confirmButton
    )
  );

  const toolbar = h(
    'div',
    { className: 'tlog-settings-toolbar' },
    search,
    h('label', { className: 'tlog-check' }, onlyChanged, 'Só o que difere do padrão'),
    h('span', { className: 'tlog-spacer' }),
    restoreAll
  );
  const body = h(
    'div',
    { className: 'tlog-settings-layout' },
    nav,
    h('div', { className: 'tlog-settings-content' }, groups, empty, historySection, saveBar)
  );
  const element = h('div', { className: 'tlog-settings' }, readOnlyNotice, message, reload, toolbar, body, review);

  const changed = () => SETTINGS.filter(({ id }) => !sameValue(draft[id], saved[id]));

  function buildControl(setting) {
    const { id, type } = setting;
    const fieldId = `tlog-field-${id}`;
    const update = (value) => {
      draft[id] = value;
      refresh();
    };
    const disabled = !canEdit;
    if (type === 'toggle') {
      const input = h('input', { type: 'checkbox', id: fieldId, disabled, onChange: (event) => update(event.target.checked) });
      input.checked = draft[id];
      return h('label', { className: 'tlog-check' }, input, 'Ligado');
    }
    if (type === 'multi') {
      return h(
        'div',
        { className: 'tlog-options', role: 'group', 'aria-label': setting.label },
        ...setting.options.map((option) => {
          const input = h('input', {
            type: 'checkbox',
            disabled,
            onChange: (event) => {
              const list = draft[id].filter((item) => item !== option.id);
              if (event.target.checked) list.push(option.id);
              update(list);
            },
          });
          input.checked = draft[id].includes(option.id);
          return h(
            'label',
            { className: 'tlog-check tlog-check--top' },
            input,
            h('span', {}, option.mono ? h('code', {}, option.label) : option.label, option.hint ? h('span', { className: 'tlog-setting-help' }, option.hint) : null)
          );
        })
      );
    }
    if (type === 'lines') {
      const area = h('textarea', {
        id: fieldId,
        'aria-label': setting.label,
        'aria-describedby': `${fieldId}-error`,
        placeholder: setting.placeholder,
        spellcheck: 'false',
        disabled,
        onInput: (event) => update(event.target.value.split('\n').map((line) => line.trim().replace(/\s+/g, ' ')).filter(Boolean)),
      });
      area.value = draft[id].join('\n');
      return area;
    }
    return h(
      'div',
      { className: 'tlog-number' },
      h('input', {
        type: 'number',
        id: fieldId,
        'aria-label': setting.label,
        'aria-describedby': `${fieldId}-error`,
        value: Number.isNaN(draft[id]) ? '' : draft[id],
        disabled,
        onInput: (event) => update(event.target.value === '' ? NaN : Number(event.target.value)),
      }),
      setting.unit ? h('span', {}, setting.unit) : null
    );
  }

  function buildRow(setting) {
    const error = h('div', { className: 'tlog-error tlog-setting-error', id: `tlog-field-${setting.id}-error` });
    const warning = h('div', { className: 'tlog-setting-warning' });
    const restore = h(
      'button',
      {
        type: 'button',
        className: 'tlog-link',
        onClick: () => {
          draft[setting.id] = clone(DEFAULT_SETTINGS)[setting.id];
          render();
        },
      },
      'Restaurar padrão'
    );
    const row = h(
      'div',
      { className: 'tlog-setting' },
      h(
        'div',
        {},
        h('div', { className: 'tlog-setting-title' }, setting.label),
        setting.help ? h('div', { className: 'tlog-setting-help' }, setting.help) : null,
        warning
      ),
      h(
        'div',
        { className: 'tlog-setting-control' },
        buildControl(setting),
        error,
        h('div', { className: 'tlog-setting-default' }, setting.type === 'multi' ? null : h('span', {}, `Padrão: ${displayValue(setting.id, setting.def)}`), restore)
      )
    );
    rows.set(setting.id, { row, error, warning, restore, setting });
    return row;
  }

  const testerOutput = h('output', { className: 'tlog-tester-output' });
  function buildTester() {
    const input = h('input', {
      type: 'text',
      id: 'tlog-tester-input',
      className: 'tlog-mono',
      value: testerValue,
      spellcheck: 'false',
      onInput: (event) => {
        testerValue = event.target.value;
        updateTester();
      },
    });
    return h('div', { className: 'tlog-tester' }, h('label', { for: 'tlog-tester-input' }, 'Testar uma linha'), input, testerOutput);
  }

  function updateTester() {
    if (!testerValue.trim()) {
      testerOutput.replaceChildren(h('span', { className: 'tlog-quiet' }, 'Cole uma linha do terminal, com o prompt.'));
      return;
    }
    // Com a lista inválida, o teste ignora os extras em vez de mostrar um resultado enganoso.
    const detection = compileDetection({ ...draft, extra: errors.extra ? [] : draft.extra, prompts: errors.prompts ? [] : draft.prompts });
    const command = commandFromLine(testerValue, detection);
    if (command === null) {
      testerOutput.replaceChildren(h('span', { className: 'tlog-chip tlog-chip-neutral' }, 'Prompt não reconhecido'), ' O comando desta linha não seria analisado.');
      return;
    }
    const found = classifyCommand(command, detection);
    testerOutput.replaceChildren(
      found
        ? h('span', { className: `tlog-chip tlog-kind-${found.kind}` }, found.label)
        : h('span', { className: 'tlog-chip tlog-chip-neutral' }, 'Sem evento'),
      found ? ` Reconhecido em: ${command}` : ' Prompt reconhecido, nenhum comando crítico.'
    );
  }

  function render() {
    rows.clear();
    groups.replaceChildren(
      ...GROUPS.map((group) =>
        h(
          'section',
          { className: 'tlog-settings-group', 'data-group': group.id },
          h('h2', {}, group.title),
          group.help ? h('p', { className: 'tlog-quiet' }, group.help) : null,
          ...SETTINGS.filter((setting) => setting.group === group.id).map(buildRow),
          group.id === 'detect' ? buildTester() : null
        )
      )
    );
    nav.replaceChildren(
      ...GROUPS.map((group) => {
        // Link com # mudaria o endereço, que o dashboard usa para navegar.
        const button = h(
          'button',
          {
            type: 'button',
            onClick: () => groups.querySelector(`[data-group=${group.id}]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
          },
          group.title
        );
        button.dataset.nav = group.id;
        return button;
      })
    );
    historyBody.replaceChildren(
      ...(history.length > 0
        ? history.map((entry) => h('tr', {}, h('td', {}, formatDate(entry.at)), h('td', {}, entry.user), h('td', {}, entry.changes.map(describeChange).join('; '))))
        : [h('tr', {}, h('td', { colSpan: '3' }, 'Nenhuma alteração registrada.'))])
    );
    historySection.toggleAttribute('hidden', !canEdit);
    readOnlyNotice.toggleAttribute('hidden', canEdit);
    restoreAll.toggleAttribute('hidden', !canEdit);
    refresh();
  }

  function refresh() {
    errors = validateSettings(draft);
    for (const { row, error, warning, restore, setting } of rows.values()) {
      const value = draft[setting.id];
      const text = errors[setting.id] ?? '';
      error.textContent = text;
      error.toggleAttribute('hidden', !text);
      row.querySelectorAll('input:not([type=checkbox]), textarea').forEach((field) => field.setAttribute('aria-invalid', String(Boolean(text))));
      const warn = !text && setting.warn ? setting.warn(value) : '';
      warning.textContent = warn;
      warning.toggleAttribute('hidden', !warn);
      restore.toggleAttribute('hidden', !canEdit || sameValue(value, setting.def));
      row.classList.toggle('tlog-setting-changed', !sameValue(value, saved[setting.id]));
    }
    for (const group of GROUPS) {
      const count = SETTINGS.filter(({ id, group: owner }) => owner === group.id && !sameValue(draft[id], saved[id])).length;
      const button = nav.querySelector(`[data-nav=${group.id}]`);
      if (button) button.textContent = count ? `${group.title} · ${count}` : group.title;
    }
    const dirty = changed().length;
    const invalid = Object.keys(errors).length;
    saveBar.toggleAttribute('hidden', !canEdit || dirty === 0);
    saveStatus.replaceChildren(
      `${dirty} ${dirty === 1 ? 'alteração não salva' : 'alterações não salvas'}`,
      invalid ? h('span', { className: 'tlog-error' }, ` · corrija ${invalid} ${invalid === 1 ? 'erro' : 'erros'}`) : ''
    );
    saveButton.disabled = invalid > 0;
    restoreAll.disabled = SETTINGS.every(({ id, def }) => sameValue(draft[id], def));
    applyFilter();
    updateTester();
  }

  function applyFilter() {
    const term = search.value.trim().toLocaleLowerCase('pt-BR');
    let shown = 0;
    for (const { row, setting } of rows.values()) {
      const text = `${setting.label} ${setting.help ?? ''}`.toLocaleLowerCase('pt-BR');
      const visible = (!term || text.includes(term)) && (!onlyChanged.checked || !sameValue(draft[setting.id], setting.def));
      row.toggleAttribute('hidden', !visible);
      if (visible) shown += 1;
    }
    for (const group of GROUPS) {
      const has = SETTINGS.some(({ id, group: owner }) => owner === group.id && !rows.get(id)?.row.hasAttribute('hidden'));
      groups.querySelector(`[data-group=${group.id}]`)?.toggleAttribute('hidden', !has);
      nav.querySelector(`[data-nav=${group.id}]`)?.toggleAttribute('hidden', !has);
    }
    empty.toggleAttribute('hidden', shown > 0);
  }

  function openReview() {
    reviewError.setAttribute('hidden', 'hidden');
    reviewList.replaceChildren(
      ...changed().map(({ id }) =>
        h('div', { className: 'tlog-review-item' }, h('strong', {}, labelOf(id)), h('div', {}, h('span', { className: 'tlog-quiet' }, `${displayValue(id, saved[id])} → `), displayValue(id, draft[id])))
      )
    );
    review.showModal();
  }

  async function confirmSave() {
    confirmButton.disabled = true;
    try {
      const result = await http.put(API, { body: JSON.stringify({ values: draft, ...(version ? { version } : {}) }) });
      accept(result);
      review.close();
      showMessage(`Salvo às ${formatTime(Date.now())}. As mudanças já valem para as próximas consultas.`);
      onSaved(clone(saved));
    } catch (error) {
      reviewError.textContent = errorMessage(error);
      reviewError.removeAttribute('hidden');
      // Em um conflito, os valores daqui estão velhos: só recarregando dá para salvar.
      reload.toggleAttribute('hidden', error?.response?.status !== 409 && error?.body?.statusCode !== 409);
    } finally {
      confirmButton.disabled = false;
    }
  }

  function accept(result) {
    saved = clone(result.values);
    draft = clone(result.values);
    version = result.version;
    canEdit = result.canEdit;
    history = result.history ?? [];
    render();
  }

  function showMessage(text, isError = false) {
    message.className = isError ? 'tlog-status tlog-error' : 'tlog-status tlog-saved';
    message.textContent = text;
    message.toggleAttribute('hidden', !text);
  }

  /** Devolve os valores em vigor. Sem conseguir ler, a tela de sessões segue com o padrão. */
  async function load() {
    reload.setAttribute('hidden', 'hidden');
    showMessage('');
    if (review.open) review.close();
    try {
      accept(await http.get(API));
      toolbar.removeAttribute('hidden');
      body.removeAttribute('hidden');
      return clone(saved);
    } catch (error) {
      showMessage(errorMessage(error), true);
      reload.removeAttribute('hidden');
      toolbar.setAttribute('hidden', 'hidden');
      body.setAttribute('hidden', 'hidden');
      return clone(DEFAULT_SETTINGS);
    }
  }

  render();
  return { element, load };
}
