// Prompt library view: searchable template list, generated variable form with live preview, actions.
import { h, icon } from '../lib/dom.js';
import { t, getLanguage } from '../lib/i18n.js';
import { activeProject } from '../lib/store.js';
import { pickLang, render as renderBody, validate, defaultValues, filterTemplates } from '../lib/templates.js';
import { copyText } from '../lib/clipboard.js';
import { confirmDialog, toast } from './modal.js';
import { openTemplateEditor } from './template-editor.js';

export function mountPrompts(el, { store, api, actions }) {
  let query = '';
  const values = new Map(); // templateId -> { key: value }
  let showErrors = false;
  let shownId = null;
  const root = h('div', { class: 'prompts' });
  el.replaceChildren(root);

  const lang = () => getLanguage();
  const templates = () => store.get().templates;
  const current = () => templates().find((x) => x.id === store.get().selectedTemplate) || null;

  function card(tpl) {
    const on = tpl.id === store.get().selectedTemplate;
    const tags = (tpl.tags || []).slice(0, 4).map((g) => h('span', { class: 'badge badge--muted', text: g }));
    return h('button', {
      class: 'prompt-card' + (on ? ' is-active' : ''), type: 'button', attrs: { 'aria-pressed': String(on) },
      on: { click: () => actions.selectTemplate(tpl.id) },
    },
    h('div', { class: 'row between gap-2 prompt-card__head' },
      h('span', { class: 'prompt-card__name truncate', text: pickLang(tpl.name, lang()) || tpl.id }),
      h('span', { class: 'badge ' + (tpl.source === 'user' ? 'badge--purple' : 'badge--muted') }, tpl.source === 'user' ? t('prompts.sourceUser') : t('prompts.sourceDefault'))),
    h('div', { class: 'prompt-card__desc', text: pickLang(tpl.description, lang()) }),
    tags.length ? h('div', { class: 'row wrap gap-1' }, ...tags) : null);
  }

  function buildList() {
    const all = templates();
    const list = filterTemplates(all, query, lang());
    const search = h('input', { class: 'input', type: 'search', id: 'prompt-search', value: query, autocomplete: 'off', spellcheck: false, placeholder: t('prompts.searchPlaceholder'), attrs: { 'aria-label': t('prompts.search') } });
    search.addEventListener('input', () => {
      query = search.value;
      const pos = search.selectionStart;
      renderAll();
      const s2 = root.querySelector('#prompt-search');
      if (s2) { s2.focus(); try { s2.setSelectionRange(pos, pos); } catch { /* ignore */ } }
    });
    return h('div', { class: 'prompts__list' },
      h('div', { class: 'prompts__toolbar' },
        h('div', { class: 'search-box' }, icon('search', 'search-box__icon'), search),
        h('button', { class: 'btn btn--primary', type: 'button', on: { click: () => newTemplate() } }, icon('plus'), t('prompts.newTemplate'))),
      h('div', { class: 'prompts__cards', attrs: { role: 'list', 'aria-label': t('prompts.listLabel') } },
        ...list.map((tpl) => h('div', { attrs: { role: 'listitem' } }, card(tpl))),
        !list.length ? h('div', { class: 'faint small side-empty', text: all.length ? t('prompts.noResults') : t('prompts.noTemplates') }) : null));
  }

  function newTemplate(base) {
    openTemplateEditor({ template: base || null, templates: templates(), api, onSaved: async (saved) => { await actions.loadTemplates(); actions.selectTemplate(saved.id); } });
  }

  function field(tpl, v, vals, onChange) {
    const id = 'pf-' + v.key;
    const label = pickLang(v.label, lang()) || v.key;
    let control;
    if (v.type === 'textarea') control = h('textarea', { class: 'textarea', id, rows: 4, value: vals[v.key] || '' });
    else if (v.type === 'select') {
      control = h('select', { class: 'select', id }, ...(v.options || []).map((o) => h('option', { value: o, text: o })));
      control.value = vals[v.key] || '';
    } else control = h('input', { class: 'input', id, type: 'text', value: vals[v.key] || '', autocomplete: 'off' });
    if (v.required) control.setAttribute('aria-required', 'true');
    const err = h('div', { class: 'field__error', id: id + '-err', hidden: true, text: t('prompts.requiredError') });
    control.addEventListener(v.type === 'select' ? 'change' : 'input', () => { vals[v.key] = control.value; onChange(); });
    return {
      el: h('div', { class: 'field' },
        h('label', { class: 'field__label', for: id }, label, v.required ? h('span', { class: 'prompt-req', attrs: { 'aria-hidden': 'true' }, text: ' *' }) : null, v.required ? h('span', { class: 'sr-only', text: ' ' + t('prompts.required') }) : null),
        control, err),
      err, control,
    };
  }

  function buildDetail() {
    const tpl = current();
    const box = h('div', { class: 'prompts__detail' });
    const back = h('button', { class: 'btn btn--ghost btn--sm prompts__back', type: 'button', on: { click: () => actions.selectTemplate(null) } }, icon('chevron', 'prompts__back-icon'), t('prompts.back'));
    if (!tpl) {
      box.append(back, h('div', { class: 'empty-state' },
        h('div', { class: 'empty-state__icon' }, icon('file', 'icon--lg')),
        h('div', { class: 'empty-state__title', text: t('prompts.pickTitle') }),
        h('div', { class: 'empty-state__text', text: t('prompts.pickText') })));
      return box;
    }
    if (!values.has(tpl.id)) values.set(tpl.id, defaultValues(tpl.vars));
    const vals = values.get(tpl.id);
    const vars = tpl.vars || [];
    const preview = h('pre', { class: 'prompt-preview', id: 'prompt-preview', tabindex: '0', attrs: { 'aria-label': t('prompts.preview') } });
    const fields = [];
    const refresh = () => {
      preview.textContent = renderBody(tpl.body, vals, vars);
      const res = validate(vars, vals);
      fields.forEach((f, i) => { const bad = showErrors && res.errors[vars[i].key]; f.err.hidden = !bad; f.control.setAttribute('aria-invalid', bad ? 'true' : 'false'); });
    };
    for (const v of vars) fields.push(field(tpl, v, vals, refresh));
    const ready = () => {
      showErrors = true; refresh();
      const res = validate(vars, vals);
      if (!res.ok) { const i = vars.findIndex((v) => res.errors[v.key]); if (i >= 0) fields[i].control.focus(); return null; }
      return renderBody(tpl.body, vals, vars);
    };
    const p = activeProject(store.get());
    const isUser = tpl.source === 'user';
    const btns = h('div', { class: 'row wrap gap-2 prompt-actions' },
      h('button', { class: 'btn btn--primary', type: 'button', on: { click: () => { const txt = ready(); if (txt != null) actions.useInChat(txt); } } }, icon('message'), t('prompts.useInChat')),
      h('button', { class: 'btn', type: 'button', on: { click: async () => { const txt = ready(); if (txt != null) toast(await copyText(txt) ? t('prompts.copied') : t('errors.generic'), 'success'); } } }, icon('copy'), t('prompts.copy')),
      h('button', {
        class: 'btn', type: 'button', disabled: !p, title: p ? '' : t('prompts.exportNeedsProject'),
        on: { click: async () => {
          if (!p) return;
          try { const r = await api.prompts.export(p.id, tpl.id); toast(t('prompts.exported', { path: (r && r.path) || '' }), 'success'); } catch (e) { toast((e && e.message) || t('errors.generic'), 'error'); }
        } },
      }, icon('download'), t('prompts.exportProject')),
      h('button', { class: 'btn', type: 'button', on: { click: () => newTemplate({ ...tpl, id: '', source: 'user', __duplicateOf: tpl.id }) } }, t('prompts.duplicate')),
      isUser ? h('button', { class: 'btn', type: 'button', on: { click: () => openTemplateEditor({ template: tpl, edit: true, templates: templates(), api, onSaved: async (saved) => { await actions.loadTemplates(); actions.selectTemplate(saved.id); } }) } }, icon('edit'), t('prompts.edit')) : null,
      isUser ? h('button', {
        class: 'btn btn--danger', type: 'button',
        on: { click: async () => {
          const ok = await confirmDialog({ title: t('prompts.delete'), message: t('prompts.deleteConfirm', { name: pickLang(tpl.name, lang()) }), confirmLabel: t('common.delete'), danger: true });
          if (!ok) return;
          try { await api.prompts.delete(tpl.id); values.delete(tpl.id); await actions.loadTemplates(); actions.selectTemplate(null); toast(t('prompts.deleted'), 'success'); } catch (e) { toast((e && e.message) || t('errors.generic'), 'error'); }
        } },
      }, icon('trash'), t('common.delete')) : null);
    box.append(...[back,
      h('div', { class: 'prompts__title' },
        h('h2', { class: 'prompts__name', text: pickLang(tpl.name, lang()) || tpl.id }),
        h('span', { class: 'badge ' + (isUser ? 'badge--purple' : 'badge--muted') }, isUser ? t('prompts.sourceUser') : t('prompts.sourceDefault'))),
      h('p', { class: 'muted prompts__desc', text: pickLang(tpl.description, lang()) }),
      (tpl.tags || []).length ? h('div', { class: 'row wrap gap-1' }, ...tpl.tags.map((g) => h('span', { class: 'badge badge--muted', text: g }))) : null,
      vars.length ? h('div', { class: 'prompts__form', attrs: { role: 'group', 'aria-label': t('prompts.variables') } }, ...fields.map((f) => f.el)) : h('div', { class: 'faint small', text: t('prompts.noVars') }),
      h('div', { class: 'field' }, h('div', { class: 'field__label', text: t('prompts.preview') }), preview),
      btns].filter(Boolean));
    refresh();
    return box;
  }

  function renderAll() {
    const s = store.get();
    root.classList.toggle('has-selection', !!s.selectedTemplate && !!current());
    const focusId = document.activeElement && root.contains(document.activeElement) ? document.activeElement.id : '';
    root.replaceChildren(buildList(), buildDetail());
    if (focusId && focusId !== 'prompt-search') { const f = root.querySelector('#' + focusId); if (f) f.focus(); }
  }

  return {
    render() {
      const id = store.get().selectedTemplate;
      if (id !== shownId) { shownId = id; showErrors = false; }
      renderAll();
      if (id) { const first = root.querySelector('.prompts__form input, .prompts__form textarea, .prompts__form select'); if (first && root.classList.contains('has-selection') && !root.contains(document.activeElement)) first.focus(); }
    },
    reset() { values.clear(); },
  };
}
