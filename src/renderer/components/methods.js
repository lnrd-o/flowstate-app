// Methodologies page: searchable list with actions, or the editor when store.editing is set.
import { pickText } from '../../shared/methodology.js';
import { h, icon } from '../lib/dom.js';
import { t, getLanguage } from '../lib/i18n.js';
import { filterMethods } from '../lib/method-utils.js';
import { createMethodEditor } from './method-editor.js';
import { isCase, categoryOf } from '../lib/cases.js';

const SRC_TONE = { bundled: 'badge--muted', user: 'badge--accent', recorded: 'badge--amber' };

export function mountMethods(el, deps) {
  const { store, actions } = deps;
  let query = '';
  const listHost = h('div', { class: 'methods' });
  const editor = createMethodEditor(deps);
  el.replaceChildren(listHost, editor.el);

  function card(m) {
    const L = getLanguage();
    const name = pickText(m.name, L) || m.id;
    const date = m.updatedAt ? new Date(m.updatedAt).toLocaleDateString(L, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
    const btn = (ic, label, fn, cls = '') => h('button', { class: 'btn btn--sm ' + cls, type: 'button', on: { click: fn }, attrs: { 'aria-label': `${label}: ${name}` } }, icon(ic), h('span', { text: label }));
    return h('article', { class: 'method-card', attrs: { 'aria-label': name } },
      h('div', { class: 'row between gap-2 method-card__head' },
        h('h3', { class: 'method-card__name truncate', title: name, text: name }),
        h('span', { class: 'row gap-1' },
          isCase(m) ? h('span', { class: 'badge badge--accent', text: t('wizard.caseBadge') + ' \u00b7 ' + t('wizard.cat.' + categoryOf(m)) }) : null,
          h('span', { class: 'badge ' + (SRC_TONE[m.source] || 'badge--muted'), text: t('method.source.' + m.source) }))),
      h('div', { class: 'method-card__desc', text: pickText(m.description, L) }),
      (m.tags || []).length ? h('div', { class: 'row wrap gap-1' }, ...m.tags.slice(0, 5).map((g) => h('span', { class: 'badge badge--muted', text: g }))) : null,
      h('div', { class: 'faint small method-card__meta', text: [t('method.nodes', { n: m.nodeCount }), t('method.varsCount', { n: m.varCount }), date ? t('method.updated', { date }) : ''].filter(Boolean).join(' \u00b7 ') }),
      h('div', { class: 'row wrap gap-2 method-card__acts' },
        btn('edit', t('method.open'), () => actions.openMethodEditorById(m.id)),
        btn('play', t('method.run.button'), () => actions.runMethod(m.id), 'btn--primary'),
        btn('copy', t('method.duplicate'), () => actions.duplicateMethod(m.id)),
        btn('download', t('method.export'), () => actions.exportMethod(m.id)),
        m.source !== 'bundled' ? btn('trash', t('common.delete'), () => actions.deleteMethod(m.id), 'btn--danger') : null));
  }

  function renderList() {
    const s = store.get();
    const list = filterMethods(s.methods, query, getLanguage());
    const hadFocus = document.activeElement && document.activeElement.id === 'method-search';
    const search = h('input', { class: 'input', type: 'search', id: 'method-search', value: query, autocomplete: 'off', spellcheck: false, placeholder: t('method.searchPlaceholder'), attrs: { 'aria-label': t('method.search') } });
    search.addEventListener('input', () => { query = search.value; const pos = search.selectionStart; renderList(); const s2 = listHost.querySelector('#method-search'); if (s2) { s2.focus(); try { s2.setSelectionRange(pos, pos); } catch { /* ignore */ } } });
    const p = s.projects.find((x) => x.id === s.activeProjectId);
    listHost.replaceChildren(h('div', { class: 'methods__inner' },
      h('div', { class: 'methods__top' },
        h('div', { class: 'col' }, h('h2', { class: 'methods__title', text: t('nav.methodologies') }), h('p', { class: 'muted small methods__sub', text: t('method.subtitle') })),
        h('div', { class: 'row wrap gap-2 methods__tools' },
          h('button', { class: 'btn btn--primary', type: 'button', on: { click: () => actions.newMethod() } }, icon('plus'), t('method.new')),
          h('button', { class: 'btn', type: 'button', on: { click: () => actions.importMethod() } }, icon('upload'), t('method.import')),
          h('button', { class: 'btn', type: 'button', title: p ? t('method.record.tip', { name: p.name }) : t('method.record.needProject'), on: { click: () => actions.recordMethod() } }, icon('sparkles'), t('method.record.button')))),
      h('div', { class: 'search-box methods__search' }, icon('search', 'search-box__icon'), search),
      h('div', { class: 'methods__grid', attrs: { role: 'list', 'aria-label': t('method.listLabel') } }, ...list.map((m) => h('div', { attrs: { role: 'listitem' }, class: 'methods__item' }, card(m)))),
      !list.length ? h('div', { class: 'empty-state' },
        h('div', { class: 'empty-state__icon' }, icon('layers', 'icon--lg')),
        h('div', { class: 'empty-state__title', text: s.methods.length ? t('method.noResults') : t('method.empty') }),
        h('div', { class: 'empty-state__text', text: s.methods.length ? '' : t('method.emptyText') })) : null));
    if (hadFocus) { const s2 = listHost.querySelector('#method-search'); if (s2) s2.focus(); }
  }

  function render() {
    const s = store.get();
    const editing = !!s.editing;
    listHost.hidden = editing;
    editor.el.hidden = !editing;
    editor.show(s.editing);
    if (!editing) renderList();
  }

  return { render, update() { editor.update(); render(); }, editor };
}
