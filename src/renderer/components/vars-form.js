// Variables form generated from methodology vars (text / textarea / select / path / file), shared by the run dialog and the wizard.
// 'file' vars hold the ABSOLUTE path the user picked while editing; callers copy it into the project with importFileVars (lib/cases.js).
import { pickText } from '../../shared/methodology.js';
import { h, icon, nextId, radioKeys } from '../lib/dom.js';
import { t, getLanguage } from '../lib/i18n.js';
import { runDefaults, validateRunVars } from '../lib/method-utils.js';
import { baseName } from '../lib/cases.js';

const useSegmented = (v) => Array.isArray(v.options) && v.options.length <= 4 && v.options.every((o) => String(o).length <= 24);

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

  function segmented(v, id, label) {
    const opts = v.options.map(String);
    if (!opts.includes(vals[v.key])) vals[v.key] = opts[0];
    const group = h('div', { class: 'segmented vf__seg', id, attrs: { role: 'radiogroup', 'aria-label': label } });
    const items = opts.map((o) => h('button', { class: 'segmented__item', type: 'button', text: o, attrs: { role: 'radio' }, on: { click: () => { vals[v.key] = o; paint(); refresh(); } } }));
    const paint = () => items.forEach((b, i) => { const on = opts[i] === vals[v.key]; b.classList.toggle('is-active', on); b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; });
    group.append(...items);
    radioKeys(group);
    paint();
    group.focus = () => (items.find((b) => b.tabIndex === 0) || items[0]).focus();
    return group;
  }

  function fileField(v, id, label) {
    const chips = h('div', { class: 'vf__chips' });
    const hint = h('div', { class: 'field__hint', hidden: true, attrs: { role: 'status' } });
    const zone = h('button', { class: 'vf-drop', id, type: 'button', attrs: { 'aria-label': label + ': ' + t('vars.fileChoose') } },
      icon('upload'), h('span', { class: 'vf-drop__t', text: t('vars.fileDrop') }), h('span', { class: 'vf-drop__btn', text: t('vars.fileChoose') }));
    const paint = () => {
      const p = vals[v.key];
      chips.replaceChildren(...(p ? [h('span', { class: 'vf-chip' }, icon('fileText'), h('span', { class: 'vf-chip__name truncate', title: p, text: baseName(p) }),
        h('button', { class: 'btn btn--ghost btn--icon btn--sm', type: 'button', attrs: { 'aria-label': t('vars.fileRemove', { name: baseName(p) }) }, on: { click: () => { vals[v.key] = ''; paint(); refresh(); zone.focus(); } } }, icon('x')))] : []));
    };
    async function pick() {
      let list = [];
      try { list = await api.files.pick({ kind: 'office', multi: false }); } catch { list = []; }
      const p = Array.isArray(list) && list[0];
      if (p) { vals[v.key] = String(p); hint.hidden = true; paint(); refresh(); }
    }
    zone.addEventListener('click', pick);
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('is-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('is-over'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault(); zone.classList.remove('is-over');
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) { hint.textContent = t('vars.fileDropHint', { name: f.name }); hint.hidden = false; }
      pick(); // the real path only comes from the native picker
    });
    paint();
    return { control: zone, line: h('div', { class: 'vf__file' }, zone, chips, hint) };
  }

  for (const v of vars) {
    const id = `${prefix}-${v.key}`;
    const label = pickText(v.label, lang) || v.key;
    const ph = v.placeholder ? pickText(v.placeholder, lang) : '';
    let control;
    let line;
    if (v.type === 'file') ({ control, line } = fileField(v, id, label));
    else if (v.type === 'select' && useSegmented(v)) { control = segmented(v, id, label); line = control; }
    else {
      if (v.type === 'textarea') control = h('textarea', { class: 'textarea', id, rows: 4, value: vals[v.key] || '', placeholder: ph });
      else if (v.type === 'select') {
        control = h('select', { class: 'select', id }, ...(v.options || []).map((o) => h('option', { value: o, text: o })));
        control.value = vals[v.key] || (v.options || [])[0] || '';
      } else control = h('input', { class: 'input' + (v.type === 'path' ? ' mono' : ''), id, type: 'text', value: vals[v.key] || '', autocomplete: 'off', spellcheck: false, placeholder: ph });
      control.addEventListener(v.type === 'select' ? 'change' : 'input', () => { vals[v.key] = control.value; refresh(); });
      line = control;
      if (v.type === 'path') {
        const browse = h('button', {
          class: 'btn', type: 'button', text: t('project.browse'),
          on: { click: async () => {
            try { const p = await api.projects.pickFolder(); if (p) { control.value = p; vals[v.key] = p; refresh(); } } catch { /* cancelled */ }
          } },
        });
        line = h('div', { class: 'row vf__path' }, control, browse);
      }
    }
    if (v.required) control.setAttribute('aria-required', 'true');
    const errText = v.type === 'file' ? t('vars.errFile') : (v.type === 'text' || v.type === 'textarea') ? t('vars.errText') : t('method.run.required');
    const err = h('div', { class: 'field__error', id: id + '-err', hidden: true, attrs: { role: 'alert' }, text: errText });
    control.setAttribute('aria-describedby', id + '-err');
    rows.push({ key: v.key, control, err });
    rows.at(-1).el = h('div', { class: 'field' },
      h('label', { class: 'field__label', for: v.type === 'select' && useSegmented(v) ? null : id, text: undefined }, label, v.required ? h('span', { class: 'prompt-req', attrs: { 'aria-hidden': 'true' }, text: ' *' }) : null,
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
