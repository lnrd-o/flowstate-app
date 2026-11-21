// Variables form generated from methodology vars (text / textarea / select / path), shared by the run dialog and the walkthrough.
import { pickText } from '../../shared/methodology.js';
import { h, icon, nextId } from '../lib/dom.js';
import { t, getLanguage } from '../lib/i18n.js';
import { runDefaults, validateRunVars } from '../lib/method-utils.js';

/**
 * buildVarsForm({ vars, values?, api }) -> { el, values, validate(): boolean }.
 * `values` is mutated as the user types; validate() shows required errors and focuses the first bad field.
 */
export function buildVarsForm({ vars = [], values, api }) {
  const vals = values || runDefaults(vars);
  for (const [k, v] of Object.entries(runDefaults(vars))) if (vals[k] == null) vals[k] = v;
  const lang = getLanguage();
  const prefix = nextId('vf');
  const rows = [];
  let showErrors = false;

  const refresh = () => {
    const res = validateRunVars(vars, vals);
    for (const r of rows) {
      const bad = showErrors && !!res.errors[r.key];
      r.err.hidden = !bad;
      r.control.setAttribute('aria-invalid', bad ? 'true' : 'false');
    }
    return res;
  };

  for (const v of vars) {
    const id = `${prefix}-${v.key}`;
    let control;
    if (v.type === 'textarea') control = h('textarea', { class: 'textarea', id, rows: 3, value: vals[v.key] || '' });
    else if (v.type === 'select') {
      control = h('select', { class: 'select', id }, ...(v.options || []).map((o) => h('option', { value: o, text: o })));
      control.value = vals[v.key] || (v.options || [])[0] || '';
    } else control = h('input', { class: 'input' + (v.type === 'path' ? ' mono' : ''), id, type: 'text', value: vals[v.key] || '', autocomplete: 'off', spellcheck: false });
    if (v.required) control.setAttribute('aria-required', 'true');
    control.addEventListener(v.type === 'select' ? 'change' : 'input', () => { vals[v.key] = control.value; refresh(); });
    const err = h('div', { class: 'field__error', id: id + '-err', hidden: true, attrs: { role: 'alert' }, text: t('method.run.required') });
    control.setAttribute('aria-describedby', id + '-err');
    let line = control;
    if (v.type === 'path') {
      const browse = h('button', {
        class: 'btn', type: 'button', text: t('project.browse'),
        on: { click: async () => {
          try { const p = await api.projects.pickFolder(); if (p) { control.value = p; vals[v.key] = p; refresh(); } } catch { /* cancelled */ }
        } },
      });
      line = h('div', { class: 'row vf__path' }, control, browse);
    }
    rows.push({ key: v.key, control, err });
    rows.at(-1).el = h('div', { class: 'field' },
      h('label', { class: 'field__label', for: id }, pickText(v.label, lang) || v.key, v.required ? h('span', { class: 'prompt-req', attrs: { 'aria-hidden': 'true' }, text: ' *' }) : null,
        v.required ? h('span', { class: 'sr-only', text: ' ' + t('prompts.required') }) : null),
      line, err);
  }

  const el = h('div', { class: 'vf', attrs: { role: 'group', 'aria-label': t('method.run.variables') } },
    ...rows.map((r) => r.el),
    !rows.length ? h('div', { class: 'faint small', text: t('method.run.noVars') }) : null);

  return {
    el, values: vals,
    validate() {
      showErrors = true;
      const res = refresh();
      if (!res.ok) { const i = rows.findIndex((r) => res.errors[r.key]); if (i >= 0) rows[i].control.focus(); }
      return res.ok;
    },
  };
}
