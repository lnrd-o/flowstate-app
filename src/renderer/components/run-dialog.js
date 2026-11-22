// "Run methodology" dialog: target project + generated variables form -> actions.startRun.
import { pickText } from '../../shared/methodology.js';
import { h } from '../lib/dom.js';
import { t, getLanguage } from '../lib/i18n.js';
import { isActiveRun } from '../lib/method-utils.js';
import { openDialog } from './modal.js';
import { buildVarsForm } from './vars-form.js';
import { importFileVars } from '../lib/cases.js';

export async function openRunDialog({ store, api, actions, methodologyId, projectId }) {
  let m;
  try { m = await api.method.get(methodologyId, projectId || undefined); } catch (e) { actions.toastError(e); return null; }
  const lang = getLanguage();
  const s = store.get();
  const projects = s.projects;
  const body = h('div', { class: 'col gap-3 run-dlg' });
  const err = h('div', { class: 'field__error', hidden: true, attrs: { role: 'alert' } });
  const cancel = h('button', { class: 'btn', type: 'button', text: t('common.cancel') });
  const start = h('button', { class: 'btn btn--primary', type: 'button', text: t('method.run.start') });
  const dlg = openDialog({ title: t('method.run.title', { name: pickText(m.name, lang) }), body, footer: [cancel, start], size: 'lg' });
  cancel.addEventListener('click', () => dlg.close('cancel'));

  if (!projects.length) {
    body.append(h('div', { class: 'empty-state__text', text: t('method.run.noProject') }));
    start.disabled = true;
    return dlg;
  }
  const sel = h('select', { class: 'select', id: 'run-project' }, ...projects.map((p) => h('option', { value: p.id, text: p.name })));
  sel.value = projectId || s.activeProjectId || projects[0].id;
  const busy = h('div', { class: 'me__warn', hidden: true, attrs: { role: 'status' }, text: t('method.run.busy') });
  const form = buildVarsForm({ vars: m.vars || [], api });
  const hasCommand = m.nodes.some((n) => n.type === 'command');
  body.append(
    m.description ? h('p', { class: 'muted', text: pickText(m.description, lang) }) : null,
    h('div', { class: 'field' }, h('label', { class: 'field__label', for: 'run-project', text: t('method.run.project') }), sel),
    busy, form.el,
    hasCommand ? h('div', { class: 'faint small', text: t('method.run.commandNote') }) : null,
    err);
  const syncBusy = () => { const a = isActiveRun(store.get().runs[sel.value]); busy.hidden = !a; start.disabled = a; };
  sel.addEventListener('change', syncBusy);
  syncBusy();
  sel.focus();

  const imported = {};
  sel.addEventListener('change', () => { for (const k of Object.keys(imported)) delete imported[k]; });
  start.addEventListener('click', async () => {
    err.hidden = true;
    if (!form.validate()) return;
    start.disabled = true;
    try {
      const vals = await importFileVars(api, sel.value, m.vars || [], form.values, imported);
      await actions.startRun(sel.value, m.id, vals);
      dlg.close('started');
    } catch (e) {
      err.textContent = (e && e.message) || t('errors.generic');
      err.hidden = false;
      start.disabled = false;
    }
  });
  return dlg;
}
