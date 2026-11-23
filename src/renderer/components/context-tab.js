// Context tab (side panel): what the agents know about this project, in plain text: the project overview and the notes of the active
// conversation (.flowstate/context/*.md, the same files that let any provider continue the work), plus a refresh and open-in-Files.
import { h, icon } from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import { activeProject } from '../lib/store.js';
import { renderMarkdown } from '../lib/markdown.js';

export function mountContextTab(panel, { store, api, actions }) {
  panel.classList.add('ctx-tab');
  let token = 0;
  let lastKey = '';

  async function readNote(pid, rel) {
    try {
      const r = await api.files.preview(pid, rel);
      if (r && (r.type === 'markdown' || r.type === 'text') && typeof r.text === 'string') return r.text;
      if (r && typeof r.content === 'string') return r.content;
    } catch { /* not written yet */ }
    return '';
  }

  function section(title, rel, text, pid) {
    const body = h('div', { class: 'md ctx-tab__md' });
    if (text.trim()) body.append(renderMarkdown(text)); else body.append(h('p', { class: 'muted small', text: t('ctx.empty') }));
    return h('section', { class: 'ctx-tab__section' },
      h('div', { class: 'ctx-tab__head' }, h('strong', { text: title }),
        h('button', { class: 'btn btn--ghost btn--icon btn--sm', type: 'button', title: t('ctx.open'), attrs: { 'aria-label': t('ctx.open') }, on: { click: () => actions.openFile(rel) } }, icon('external'))),
      body);
  }

  async function render(force) {
    const s = store.get();
    const p = activeProject(s);
    if (!p) { panel.replaceChildren(h('div', { class: 'empty-state' }, h('div', { class: 'empty-state__title', text: t('files.noProject') }))); return; }
    const my = ++token;
    const refresh = h('button', { class: 'btn btn--ghost btn--sm', type: 'button', on: { click: () => { lastKey = ''; render(true); } } }, icon('refresh'), t('artifacts.refresh'));
    let info = (s.threads || {})[p.id];
    try { info = await api.threads.list(p.id); store.set((st) => ({ threads: { ...(st.threads || {}), [p.id]: info } })); } catch { /* keep */ }
    if (my !== token) return;
    const cur = info && info.threads.find((x) => x.id === info.active);
    const noteRel = cur ? cur.contextPath : '.flowstate/context/main.md';
    const projRel = (info && info.projectContextPath) || '.flowstate/context/PROJECT.md';
    const [mine, overall] = await Promise.all([readNote(p.id, noteRel), readNote(p.id, projRel)]);
    if (my !== token) return;
    const key = JSON.stringify([p.id, noteRel, mine.length, overall.length, mine.slice(-60), t('ctx.title')]);
    if (key === lastKey && !force) return;
    lastKey = key;
    panel.replaceChildren(
      h('div', { class: 'ctx-tab__intro small muted', text: t('ctx.intro') }),
      h('div', null, refresh),
      section(t('ctx.conversation', { name: cur ? (cur.main ? t('threads.main') : cur.title) : '' }), noteRel, mine, p.id),
      section(t('ctx.project'), projRel, overall, p.id));
  }

  // refresh when a turn finishes (the notes are rewritten then)
  store.subscribe((s, prev) => {
    const p = activeProject(s);
    if (!p || s.artifactsTab !== 'context') return;
    const c = s.chats[p.id]; const pc = prev.chats[p.id];
    if (c && pc && pc.running && !c.running) setTimeout(() => render(false), 600);
  });
  return { render: () => render(false) };
}
