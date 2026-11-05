import { getLocale, t, tn } from '../lib/i18n';
import { commandFromLine, classifyCommand, compileDetection } from '../lib/session_events';
import { DEFAULT_SETTINGS, GROUPS, SETTINGS, displayValue, sameValue, validateSettings } from '../lib/settings';
import { formatDate, formatTime, h } from './dom';

const API = '/api/tlog_replay/settings';
const clone = (values) => Object.fromEntries(Object.entries(values).map(([id, value]) => [id, Array.isArray(value) ? [...value] : value]));
const errorMessage = (error) => error?.body?.message || error?.message || t('common.unexpectedError');
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
  const reload = h('button', { type: 'button', hidden: 'hidden', onClick: () => load() }, t('settings.reload'));
  const readOnlyNotice = h('p', { className: 'tlog-settings-notice', hidden: 'hidden' }, t('settings.readOnly'));
  const search = h('input', { type: 'search', placeholder: t('settings.search'), 'aria-label': t('settings.search'), onInput: applyFilter });
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
    t('settings.restoreAll')
  );
  const nav = h('nav', { className: 'tlog-settings-nav', 'aria-label': t('settings.groupsLabel') });
  const groups = h('div');
  const empty = h('p', { hidden: 'hidden' }, t('settings.empty'));
  const historyBody = h('tbody');
  const historySection = h(
    'section',
    { className: 'tlog-settings-group', hidden: 'hidden' },
    h('h2', {}, t('settings.history.title')),
    h('p', { className: 'tlog-quiet' }, t('settings.history.help')),
    h(
      'div',
      { className: 'tlog-table-wrap' },
      h(
        'table',
        { className: 'tlog-simple-table' },
        h('thead', {}, h('tr', {}, ...[t('settings.history.when'), t('settings.history.who'), t('settings.history.what')].map((title) => h('th', { scope: 'col' }, title)))),
        historyBody
      )
    )
  );

  const saveStatus = h('span');
  const saveButton = h('button', { type: 'button', className: 'tlog-primary', onClick: openReview }, t('settings.reviewAndSave'));
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
      t('settings.discard')
    ),
    saveButton
  );

  const reviewList = h('div', { className: 'tlog-review-list' });
  const reviewError = h('p', { className: 'tlog-error', hidden: 'hidden' });
  const confirmButton = h('button', { type: 'button', className: 'tlog-primary', onClick: confirmSave }, t('settings.save'));
  const review = h(
    'dialog',
    { className: 'tlog-review', 'aria-labelledby': 'tlog-review-title' },
    h('h2', { id: 'tlog-review-title' }, t('settings.saveQuestion')),
    h('p', {}, t('settings.saveHelp')),
    reviewList,
    reviewError,
    h(
      'div',
      { className: 'tlog-review-actions' },
      h('button', { type: 'button', onClick: () => review.close() }, t('settings.back')),
      confirmButton
    )
  );

  const toolbar = h(
    'div',
    { className: 'tlog-settings-toolbar' },
    search,
    h('label', { className: 'tlog-check' }, onlyChanged, t('settings.onlyChanged')),
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
      return h('label', { className: 'tlog-check' }, input, t('settings.on'));
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
      t('settings.restoreDefault')
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
        h('div', { className: 'tlog-setting-default' }, setting.type === 'multi' ? null : h('span', {}, t('settings.default', { value: displayValue(setting.id, setting.def) })), restore)
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
    return h('div', { className: 'tlog-tester' }, h('label', { for: 'tlog-tester-input' }, t('settings.tester.title')), input, testerOutput);
  }

  function updateTester() {
    if (!testerValue.trim()) {
      testerOutput.replaceChildren(h('span', { className: 'tlog-quiet' }, t('settings.tester.empty')));
      return;
    }
    // Com a lista inválida, o teste ignora os extras em vez de mostrar um resultado enganoso.
    const detection = compileDetection({ ...draft, extra: errors.extra ? [] : draft.extra, prompts: errors.prompts ? [] : draft.prompts });
    const command = commandFromLine(testerValue, detection);
    if (command === null) {
      testerOutput.replaceChildren(h('span', { className: 'tlog-chip tlog-chip-neutral' }, t('settings.tester.noPrompt')), t('settings.tester.noPromptHelp'));
      return;
    }
    const found = classifyCommand(command, detection);
    testerOutput.replaceChildren(
      found
        ? h('span', { className: `tlog-chip tlog-kind-${found.kind}` }, t(`kind.${found.kind}`))
        : h('span', { className: 'tlog-chip tlog-chip-neutral' }, t('settings.tester.noEvent')),
      found ? t('settings.tester.recognized', { command }) : t('settings.tester.noCritical')
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
        : [h('tr', {}, h('td', { colSpan: '3' }, t('settings.history.none')))])
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
      tn('settings.unsaved', dirty),
      invalid ? h('span', { className: 'tlog-error' }, tn('settings.fixErrors', invalid)) : ''
    );
    saveButton.disabled = invalid > 0;
    restoreAll.disabled = SETTINGS.every(({ id, def }) => sameValue(draft[id], def));
    applyFilter();
    updateTester();
  }

  function applyFilter() {
    const term = search.value.trim().toLocaleLowerCase(getLocale());
    let shown = 0;
    for (const { row, setting } of rows.values()) {
      const text = `${setting.label} ${setting.help ?? ''}`.toLocaleLowerCase(getLocale());
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
      showMessage(t('settings.saved', { time: formatTime(Date.now()) }));
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
