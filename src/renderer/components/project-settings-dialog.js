// Per-project settings: agent, mode, model, effort, auto-commit and the Developer-mode override (Follow global / Always on / Always off).
// Changes apply immediately (projects.update), like the global Settings dialog.
import { h, radioKeys } from '../lib/dom.js';
import { t, onChange } from '../lib/i18n.js';
import { effectiveDeveloperMode } from '../lib/store.js';
import { displayEffort, effectiveModelId, effortValues, modelOptions, modelToStore } from '../lib/models.js';
import { openDialog } from './modal.js';

const MODES = ['default', 'acceptEdits', 'plan'];

/** project.developerMode (null|true|false) <-> select value. Pure; exported for tests. */
export const devToValue = (v) => (v === true ? 'on' : v === false ? 'off' : 'follow');
export const valueToDev = (v) => (v === 'on' ? true : v === 'off' ? false : null);

export function openProjectSettingsDialog({ store, actions, projectId }) {
  if (!store.get().projects.some((p) => p.id === projectId)) return null;
  const body = h('div', { class: 'pset settings-form' });
  const closeBtn = h('button', { class: 'btn btn--primary', type: 'button', text: t('common.close') });
  let unsubs = [];
  const dlg = openDialog({ title: t('pset.title'), body, footer: [closeBtn], size: 'lg', onClose: () => unsubs.forEach((u) => u()) });
  closeBtn.addEventListener('click', () => dlg.close('done'));

  const field = (label, control, hint) => h('div', { class: 'field' }, h('label', { class: 'field__label', for: control.id, text: label }), control, hint ? h('div', { class: 'field__hint', text: hint }) : null);

  function render() {
    const s = store.get();
    const p = s.projects.find((x) => x.id === projectId);
    if (!p) { dlg.close('gone'); return; }
    const dev = effectiveDeveloperMode(p, s.settings);
    const running = !!(s.chats[p.id] && s.chats[p.id].running);
    const activeId = document.activeElement && dlg.el.contains(document.activeElement) ? document.activeElement.id : '';
    dlg.setTitle(t('pset.title') + ' - ' + p.name);
    closeBtn.textContent = t('common.close');

    const seg = h('div', { class: 'segmented', attrs: { role: 'radiogroup', 'aria-label': t('pset.agent') } },
      ...['claude', 'agy'].map((a) => h('button', {
        class: 'segmented__item' + (p.agent === a ? ' is-active' : ''), type: 'button', text: t('agent.' + a), id: 'pset-agent-' + a, disabled: running,
        attrs: { role: 'radio', 'aria-checked': String(p.agent === a), tabindex: p.agent === a ? '0' : '-1' },
        on: { click: () => { if (p.agent !== a) actions.updateProject(p.id, { agent: a }); } },
      })));
    radioKeys(seg);

    const mode = h('select', { class: 'select', id: 'pset-mode', disabled: running }, ...MODES.map((m) => h('option', { value: m, text: t((dev ? 'mode.' : 'mode.friendly.') + m) })));
    mode.value = p.mode;
    mode.addEventListener('change', () => actions.updateProject(p.id, { mode: mode.value }));

    const list = s.models[p.agent];
    if (!list && !s.modelsLoading[p.agent]) actions.loadModels(p.agent);
    const opts = modelOptions(list, p, dev);
    const model = h('select', { class: 'select', id: 'pset-model', disabled: running || !opts.length },
      ...(opts.length ? opts.map((o) => h('option', { value: o.id, text: dev && o.sub && o.sub !== o.label ? o.label + ' (' + o.sub + ')' : o.label }))
        : [h('option', { value: '', text: s.modelsLoading[p.agent] ? t('model.loading') : t('model.defaultName') })]));
    if (opts.length) model.value = effectiveModelId(p, list);
    model.addEventListener('change', () => actions.updateProject(p.id, { model: modelToStore(model.value, list) }));

    const effort = h('select', { class: 'select', id: 'pset-effort', disabled: running },
      ...effortValues(dev).map((v) => h('option', { value: v, text: dev ? t('model.effortName.' + v) : t('model.speedName.' + v) })));
    effort.value = displayEffort(p.effort, dev);
    effort.addEventListener('change', () => actions.updateProject(p.id, { effort: effort.value }));

    const auto = h('input', { type: 'checkbox', id: 'pset-autocommit', checked: !!p.autoCommit });
    auto.addEventListener('change', () => actions.updateProject(p.id, { autoCommit: auto.checked }));

    const devSel = h('select', { class: 'select', id: 'pset-dev' },
      h('option', { value: 'follow', text: t('pset.devFollow') }), h('option', { value: 'on', text: t('pset.devOn') }), h('option', { value: 'off', text: t('pset.devOff') }));
    devSel.value = devToValue(p.developerMode);
    devSel.addEventListener('change', () => actions.updateProject(p.id, { developerMode: valueToDev(devSel.value) }));

    body.replaceChildren(
      h('div', { class: 'field' }, h('div', { class: 'field__label', text: t('pset.agent') }), h('div', null, seg)),
      h('div', { class: 'settings-grid' }, field(t('pset.mode'), mode), field(t('pset.model'), model)),
      h('div', { class: 'settings-grid' }, field(dev ? t('pset.effort') : t('model.speed'), effort), field(t('pset.dev'), devSel, t('pset.devHint'))),
      h('label', { class: 'toggle', for: 'pset-autocommit' }, auto, h('span', { class: 'toggle__track' }), h('span', { text: t('pset.autoCommit') })));
    if (activeId) { const el = dlg.el.querySelector('#' + activeId); if (el) el.focus(); }
  }

  render();
  unsubs = [onChange(() => render()), store.subscribe((s, prev) => {
    if (s.projects !== prev.projects || s.models !== prev.models || s.settings.developerMode !== prev.settings.developerMode) render();
  })];
  return dlg;
}
