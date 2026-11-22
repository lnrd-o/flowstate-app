// Artifacts pane (tabs) + splitter (pointer + keyboard resize, width persisted).
import { h, icon, clear } from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import { activeProject, isDev } from '../lib/store.js';
import { readStore, writeStore } from '../lib/storage.js';
import { confirmDialog } from './modal.js';
import { lastTouchedFile } from '../lib/touched.js';
import { createFileViewer } from './file-viewer.js';
import { mountFilesTab } from './files-tab.js';
import { mountDashboardTab } from './dashboard-tab.js';
import { mountActivityTab } from './activity-tab.js';
import { mountVersionsTab } from './versions-tab.js';

export const WIDTH_KEY = 'flowstate.artifactsWidth';
export const COLLAPSED_KEY = 'flowstate.artifactsCollapsed';
const TABS = ['preview', 'files', 'activity', 'dashboard', 'versions', 'git'];

/** Tabs shown for a mode: Simple hides the technical Activity tab. Pure. */
export function tabsFor(dev) {
  return dev ? TABS : TABS.filter((id) => id !== 'activity');
}

/** Clamp the artifacts width to [min, 60% of viewport]. Pure. */
export function clampWidth(w, min, viewport) {
  const max = Math.max(min, Math.floor(viewport * 0.6));
  return Math.round(Math.min(Math.max(w, min), max));
}

export function mountArtifacts({ aside, splitter, app, store, api, actions }) {
  const tabsEl = h('div', { class: 'pill-tabs', attrs: { role: 'tablist' } });
  const closeBtn = h('button', { class: 'btn btn--ghost btn--icon btn--sm artifacts__close', type: 'button' }, icon('x'));
  closeBtn.addEventListener('click', () => actions.toggleArtifacts());
  const body = h('div', { class: 'artifacts__body' });
  aside.append(h('div', { class: 'artifacts__header' }, tabsEl, closeBtn), body);

  const minW = () => parseInt(getComputedStyle(document.documentElement).getPropertyValue('--artifacts-min-w'), 10) || 280;
  const curW = () => aside.getBoundingClientRect().width || parseInt(getComputedStyle(app).getPropertyValue('--artifacts-w'), 10) || 420;

  function setWidth(w, persist) {
    const c = clampWidth(w, minW(), window.innerWidth);
    app.style.setProperty('--artifacts-w', c + 'px');
    splitter.setAttribute('aria-valuenow', String(c));
    if (persist) { writeStore(WIDTH_KEY, c); store.set({ artifactsWidth: c }); }
    return c;
  }
  const saved = parseInt(readStore(WIDTH_KEY, ''), 10);
  if (saved > 0) setWidth(saved, false);
  splitter.setAttribute('aria-valuemin', String(minW()));
  splitter.setAttribute('aria-valuemax', String(Math.floor(window.innerWidth * 0.6)));
  window.addEventListener('resize', () => {
    const cw = parseInt(app.style.getPropertyValue('--artifacts-w'), 10);
    if (cw > 0) setWidth(cw, false);
    splitter.setAttribute('aria-valuemax', String(Math.floor(window.innerWidth * 0.6)));
  });

  let dragging = false;
  splitter.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    splitter.setPointerCapture(e.pointerId);
    splitter.classList.add('is-dragging');
    app.classList.add('is-resizing');
    e.preventDefault();
  });
  splitter.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    setWidth(window.innerWidth - e.clientX, false);
  });
  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    try { splitter.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    splitter.classList.remove('is-dragging');
    app.classList.remove('is-resizing');
    const w = parseInt(app.style.getPropertyValue('--artifacts-w'), 10) || curW();
    writeStore(WIDTH_KEY, w);
    store.set({ artifactsWidth: w });
  };
  splitter.addEventListener('pointerup', end);
  splitter.addEventListener('pointercancel', end);
  splitter.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    setWidth(curW() + (e.key === 'ArrowLeft' ? 24 : -24), true);
  });
  splitter.addEventListener('dblclick', () => actions.toggleArtifacts());

  const tabEls = new Map();
  function renderTabs(s) {
    clear(tabsEl);
    const p = activeProject(s);
    const dashRunning = !!(p && s.dashboard[p.id] && s.dashboard[p.id].running);
    const agentRunning = !!(p && s.chats[p.id] && s.chats[p.id].running);
    for (const id of tabsFor(isDev(s))) {
      const on = s.artifactsTab === id;
      const b = h('button', {
        class: 'pill-tab' + (on ? ' is-active' : ''), type: 'button', id: 'art-tab-' + id,
        attrs: { role: 'tab', 'aria-selected': String(on), 'aria-controls': 'art-panel-' + id, tabindex: on ? '0' : '-1' },
        on: { click: () => selectTab(id) },
      }, h('span', { class: 'truncate', text: t(id === 'git' && !isDev(s) ? 'artifacts.gitSimple' : 'artifacts.' + id) }),
      id === 'activity' && agentRunning ? h('span', { class: 'tab-live', title: t('act.tab.working') }, h('span', { class: 'dot dot--agent dot--' + ((p && p.agent) || 'claude'), attrs: { 'aria-hidden': 'true' } }), h('span', { class: 'sr-only', text: t('act.tab.working') })) : null,
      id === 'dashboard' && dashRunning ? h('span', { class: 'tab-live', title: t('dashboard.running') }, h('span', { class: 'dot dot--green', attrs: { 'aria-hidden': 'true' } }), h('span', { class: 'sr-only', text: t('dashboard.running') })) : null);
      tabEls.set(id, b);
      tabsEl.append(b);
    }
    const activeTab = tabEls.get(s.artifactsTab);
    if (activeTab && activeTab.scrollIntoView) activeTab.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    closeBtn.setAttribute('aria-label', t('nav.toggleArtifacts'));
    closeBtn.title = t('nav.toggleArtifacts');
    splitter.setAttribute('aria-label', t('nav.toggleArtifacts'));
  }
  function selectTab(id) {
    store.set({ artifactsTab: id });
    if (id === 'git') actions.refreshGit();
  }
  tabsEl.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const s = store.get();
    const tabs = tabsFor(isDev(s));
    const i = tabs.indexOf(s.artifactsTab);
    const next = e.key === 'Home' ? tabs[0] : e.key === 'End' ? tabs[tabs.length - 1]
      : tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    selectTab(next);
    const el = tabsEl.querySelector('[aria-selected="true"]');
    if (el) el.focus();
  });

  function renderGit(s, p) {
    const st = s.git[p.id];
    const dev = isDev(s);
    const wrap = h('div', { class: 'git-panel' });
    wrap.append(h('div', { class: 'row between' },
      h('strong', { text: t(dev ? 'artifacts.git' : 'artifacts.gitSimple') }),
      h('button', { class: 'btn btn--ghost btn--sm', type: 'button', on: { click: () => actions.refreshGit() } }, icon('refresh'), t('artifacts.refresh'))));
    if (!st) {
      wrap.append(h('div', { class: 'muted row' }, h('span', { class: 'spinner' }), t('common.loading')));
    } else if (!st.isRepo) {
      wrap.append(h('div', { class: 'muted', text: t(dev ? 'artifacts.notRepo' : 'artifacts.notRepoSimple') }));
    } else {
      wrap.append(
        h('div', { class: 'card' },
          dev ? h('div', { class: 'row between' },
            h('span', { class: 'row' }, icon('git'), h('span', { class: 'muted', text: t('artifacts.branch') })),
            h('span', { class: 'mono strong', text: st.branch || '-' })) : null,
          h('div', { class: 'row between' },
            h('span', { class: 'muted', text: dev ? (st.dirty ? t('artifacts.changes', { count: st.dirty }) : t('artifacts.clean')) : (st.dirty ? t('artifacts.changesSimple', { count: st.dirty }) : t('artifacts.cleanSimple')) }),
            h('span', { class: 'badge ' + (st.dirty ? 'badge--amber' : 'badge--green') }, h('span', { class: 'badge__dot' }), String(st.dirty || 0)))),
        h('button', {
          class: 'btn btn--danger', type: 'button',
          on: { click: async () => {
            const ok = await confirmDialog({ title: t('chat.undoTurn'), message: t('chat.undoConfirm'), confirmLabel: t('chat.undoTurn'), danger: true });
            if (ok) actions.undoTurn();
          } },
        }, icon('undo'), t('chat.undoTurn')));
    }
    return wrap;
  }

  // Persistent panels (so the dashboard iframe and tree state survive tab switches).
  const panel = (id) => h('div', { class: 'artifacts__panel', id: 'art-panel-' + id, attrs: { role: 'tabpanel', 'aria-labelledby': 'art-tab-' + id } });
  const panels = Object.fromEntries(TABS.map((id) => [id, panel(id)]));
  body.append(...TABS.map((id) => panels[id]));
  const previewViewer = createFileViewer({ api, emptyIcon: 'file', emptyTitle: () => t('preview.emptyTitle'), emptyText: () => t('preview.emptyText') });
  panels.preview.append(previewViewer.el);
  const filesTab = mountFilesTab(panels.files, { store, api, actions });
  const dashTab = mountDashboardTab(panels.dashboard, { store, api, actions });
  const activityTab = mountActivityTab(panels.activity, { store, actions });
  const versionsTab = mountVersionsTab(panels.versions, { store, api, actions });

  function syncPreview() {
    const s = store.get();
    const p = activeProject(s);
    if (!p) { previewViewer.clear(); return; }
    const chat = s.chats[p.id];
    const rel = lastTouchedFile(chat ? chat.messages : [], p.path);
    if (!rel) { if (previewViewer.projectId() !== p.id || previewViewer.current()) previewViewer.clear(); return; }
    previewViewer.show(p.id, rel);
  }

  const agentRunning = (st) => { const pr = activeProject(st); return !!(pr && st.chats[pr.id] && st.chats[pr.id].running); };
  let sig = '';
  function render() {
    const s = store.get();
    const p = activeProject(s);
    const dash = p && s.dashboard[p.id];
    const signature = JSON.stringify([isDev(s), s.artifactsTab, p && p.id, p && s.git[p.id], dash && [dash.running, dash.url], !!(p && s.chats[p.id] && s.chats[p.id].running)]) + t('artifacts.title');
    if (signature !== sig) {
      sig = signature;
      renderTabs(s);
      for (const id of TABS) panels[id].hidden = id !== s.artifactsTab || !tabsFor(isDev(s)).includes(id);
      if (s.artifactsTab === 'git') {
        panels.git.replaceChildren(p ? renderGit(s, p) : h('div', { class: 'empty-state' },
          h('div', { class: 'empty-state__title', text: t('files.noProject') })));
      }
      if (s.artifactsTab === 'files') filesTab.render();
      if (s.artifactsTab === 'dashboard') dashTab.render();
      if (s.artifactsTab === 'activity') activityTab.render();
      if (s.artifactsTab === 'versions') versionsTab.render();
    }
    if (s.artifactsTab === 'preview') syncPreview();
  }
  store.subscribe((s, prev) => {
    if (s.artifactsTab !== prev.artifactsTab || s.activeProjectId !== prev.activeProjectId || s.git !== prev.git
      || s.dashboard !== prev.dashboard || s.projects !== prev.projects || s.settings.developerMode !== prev.settings.developerMode) render();
    if (!isDev(s) && s.artifactsTab === 'activity') store.set({ artifactsTab: 'preview' });
    if (s.dashboard !== prev.dashboard && s.artifactsTab === 'dashboard') dashTab.render();
    if (s.chats !== prev.chats && s.artifactsTab === 'preview') syncPreview();
    if (s.chats !== prev.chats && agentRunning(s) !== agentRunning(prev)) render();
  });
  render();
  return {
    update() { sig = ''; render(); previewViewer.update(); filesTab.update(); dashTab.update(); activityTab.update(); versionsTab.update(); },
    openFile(rel) { filesTab.render(); filesTab.openPath(rel); },
    applyWidth(w) { setWidth(w, false); },
    onFiles(evt) {
      filesTab.onFiles(evt);
      const p = activeProject(store.get());
      if (p && evt && evt.projectId === p.id && previewViewer.current()) previewViewer.refresh();
    },
    dashboard: dashTab,
    versions: versionsTab,
  };
}
