// Artifacts "Files" tab: lazy keyboard-navigable tree of the active project + shared file viewer.
import { h, icon } from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import { activeProject } from '../lib/store.js';
import { flattenTree, normRel, parentOf, ARTIFACTS_DIR } from '../lib/files.js';
import { createFileViewer } from './file-viewer.js';

export function mountFilesTab(el, { store, api }) {
  const states = new Map(); // projectId -> { children, expanded, loading, selected, focus, error }
  const viewer = createFileViewer({ api, emptyIcon: 'folder', emptyTitle: () => t('files.pick'), emptyText: () => t('files.pickText') });
  const refreshBtn = h('button', { class: 'btn btn--ghost btn--sm', type: 'button' }, icon('refresh'), h('span'));
  const title = h('strong');
  const treeEl = h('div', { class: 'ft__tree', attrs: { role: 'tree', tabindex: '-1' } });
  el.append(
    h('div', { class: 'ft' },
      h('div', { class: 'ft__head row between' }, title, refreshBtn),
      treeEl,
      h('div', { class: 'ft__viewer' }, viewer.el)));
  let shown = null;
  let timer = null;

  const stateFor = (pid) => {
    if (!states.has(pid)) states.set(pid, { children: new Map(), expanded: new Set(), loading: new Set(), selected: null, focus: null, error: null });
    return states.get(pid);
  };

  async function loadDir(pid, dir) {
    const st = stateFor(pid);
    st.loading.add(dir);
    paint();
    try {
      const list = await api.files.list(pid, dir);
      st.children.set(dir, (list || []).map((e) => ({ ...e, rel: normRel(e.rel) })));
      if (dir === '') st.error = null;
    } catch (e) {
      if (dir === '') st.error = (e && e.message) || t('files.readFailed');
      st.children.set(dir, st.children.get(dir) || []);
    }
    st.loading.delete(dir);
    paint();
  }

  async function loadRoot(pid) {
    await loadDir(pid, '');
    const st = stateFor(pid);
    if ((st.children.get('') || []).some((e) => e.isDir && e.name.toLowerCase() === ARTIFACTS_DIR)) {
      const rel = (st.children.get('').find((e) => e.isDir && e.name.toLowerCase() === ARTIFACTS_DIR)).rel;
      await loadDir(pid, rel);
    }
  }

  function toggle(pid, entry) {
    const st = stateFor(pid);
    if (st.expanded.has(entry.rel)) st.expanded.delete(entry.rel);
    else { st.expanded.add(entry.rel); if (!st.children.has(entry.rel)) loadDir(pid, entry.rel); }
    paint();
  }

  function select(pid, entry) {
    const st = stateFor(pid);
    st.focus = entry.rel;
    if (entry.isDir) { toggle(pid, entry); return; }
    st.selected = entry.rel;
    viewer.show(pid, entry.rel);
    paint();
  }

  function row(pid, st, r, total, index) {
    const e = r.entry;
    const open = r.expanded;
    const isArt = e.isDir && parentOf(e.rel) === '' && e.name.toLowerCase() === ARTIFACTS_DIR;
    const count = isArt && st.children.has(e.rel) ? st.children.get(e.rel).length : 0;
    const node = h('div', {
      class: 'ft__row' + (st.selected === e.rel ? ' is-selected' : ''),
      attrs: {
        role: 'treeitem', 'aria-level': String(r.depth), 'aria-posinset': String(index + 1), 'aria-setsize': String(total),
        tabindex: st.focus === e.rel || (!st.focus && index === 0) ? '0' : '-1',
        ...(e.isDir ? { 'aria-expanded': String(open) } : { 'aria-selected': String(st.selected === e.rel) }),
      },
      dataset: { rel: e.rel },
      style: '--depth:' + (r.depth - 1),
    },
    e.isDir ? icon('chevron', 'ft__chev' + (open ? ' is-open' : '')) : h('span', { class: 'ft__chev-gap' }),
    icon(e.isDir ? 'folder' : 'file', 'ft__icon'),
    h('span', { class: 'ft__name truncate', text: e.name }),
    count ? h('span', { class: 'badge badge--accent ft__badge', attrs: { 'aria-label': t('files.artifactsCount', { count }) } }, String(count)) : null,
    st.loading.has(e.rel) ? h('span', { class: 'spinner ft__spin' }) : null);
    node.addEventListener('click', () => select(pid, e));
    return node;
  }

  function paint() {
    const s = store.get();
    const p = activeProject(s);
    title.textContent = t('artifacts.files');
    refreshBtn.lastChild.textContent = t('artifacts.refresh');
    treeEl.setAttribute('aria-label', t('files.treeLabel'));
    if (!p) { treeEl.replaceChildren(h('div', { class: 'faint small ft__msg', text: t('files.noProject') })); return; }
    const st = stateFor(p.id);
    const hadFocus = treeEl.contains(document.activeElement);
    if (!st.children.has('')) {
      treeEl.replaceChildren(h('div', { class: 'row muted ft__msg' }, h('span', { class: 'spinner' }), t('common.loading')));
      return;
    }
    const rows = flattenTree(st.children, st.expanded);
    if (st.error) { treeEl.replaceChildren(h('div', { class: 'field__error ft__msg', attrs: { role: 'alert' }, text: st.error })); return; }
    if (!rows.length) { treeEl.replaceChildren(h('div', { class: 'faint small ft__msg', text: t('files.emptyDir') })); return; }
    treeEl.replaceChildren(...rows.map((r, i) => row(p.id, st, r, rows.length, i)));
    if (hadFocus && st.focus) {
      const f = [...treeEl.children].find((c) => c.dataset.rel === st.focus);
      if (f) f.focus({ preventScroll: false });
    }
  }

  treeEl.addEventListener('keydown', (e) => {
    const p = activeProject(store.get());
    if (!p) return;
    const st = stateFor(p.id);
    const item = e.target instanceof Element ? e.target.closest('[role="treeitem"]') : null;
    if (item && item.dataset.rel != null) st.focus = item.dataset.rel;
    const rows = flattenTree(st.children, st.expanded);
    const cur = rows.findIndex((r) => r.entry.rel === st.focus);
    const go = (i) => {
      const r = rows[Math.max(0, Math.min(rows.length - 1, i))];
      if (!r) return;
      st.focus = r.entry.rel;
      paint();
      const n = [...treeEl.children].find((c) => c.dataset.rel === st.focus);
      if (n) n.focus();
    };
    const r = rows[cur];
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); go(cur + 1); break;
      case 'ArrowUp': e.preventDefault(); go(cur - 1); break;
      case 'Home': e.preventDefault(); go(0); break;
      case 'End': e.preventDefault(); go(rows.length - 1); break;
      case 'ArrowRight':
        e.preventDefault();
        if (r && r.entry.isDir) { if (!r.expanded) toggle(p.id, r.entry); else go(cur + 1); }
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (r && r.entry.isDir && r.expanded) toggle(p.id, r.entry);
        else if (r) { const pi = rows.findIndex((x) => x.entry.rel === r.parent && r.parent !== ''); if (pi >= 0) go(pi); }
        break;
      case 'Enter': case ' ':
        e.preventDefault();
        if (r) select(p.id, r.entry);
        break;
      default:
    }
  });

  async function refreshAll(pid) {
    const st = stateFor(pid);
    const dirs = ['', ...st.expanded];
    if (!dirs.includes(ARTIFACTS_DIR)) dirs.push(ARTIFACTS_DIR);
    await Promise.all(dirs.map((d) => loadDir(pid, d)));
    if (st.selected) viewer.refresh();
  }
  refreshBtn.addEventListener('click', () => { const p = activeProject(store.get()); if (p) refreshAll(p.id); });

  function render() {
    const p = activeProject(store.get());
    const pid = p ? p.id : null;
    if (pid !== shown) {
      shown = pid;
      if (!pid) viewer.clear();
      else {
        const st = stateFor(pid);
        if (st.selected) viewer.show(pid, st.selected); else viewer.clear();
        if (!st.children.has('')) loadRoot(pid);
      }
    }
    paint();
  }

  /** Select a file by project-relative path: expand its folders, show it in the viewer. */
  async function openPath(rel) {
    const p = activeProject(store.get());
    if (!p) return;
    const st = stateFor(p.id);
    const clean = normRel(rel);
    const parts = clean.split('/');
    st.selected = clean;
    st.focus = clean;
    let dir = '';
    const loads = [];
    if (!st.children.has('')) loads.push(loadDir(p.id, ''));
    for (let i = 0; i < parts.length - 1; i++) {
      dir = dir ? dir + '/' + parts[i] : parts[i];
      st.expanded.add(dir);
      if (!st.children.has(dir)) loads.push(loadDir(p.id, dir));
    }
    viewer.show(p.id, clean);
    paint();
    await Promise.all(loads);
    const node = [...treeEl.children].find((x) => x.dataset.rel === clean);
    if (node && node.scrollIntoView) node.scrollIntoView({ block: 'nearest' });
  }

  return {
    render,
    openPath,
    update() { viewer.update(); paint(); },
    onFiles(evt) {
      if (!evt || !states.has(evt.projectId)) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const p = activeProject(store.get());
        if (p && p.id === evt.projectId) refreshAll(p.id);
        else states.delete(evt.projectId);
      }, 300);
    },
  };
}
