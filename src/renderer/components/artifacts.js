// Artifacts pane (tabs) + splitter (pointer + keyboard resize, width persisted).
import { h, icon, clear } from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import { activeProject } from '../lib/store.js';
import { readStore, writeStore } from '../lib/storage.js';
import { confirmDialog } from './modal.js';

export const WIDTH_KEY = 'flowstate.artifactsWidth';
export const COLLAPSED_KEY = 'flowstate.artifactsCollapsed';
const TABS = ['preview', 'files', 'dashboard', 'git'];

/** Clamp the artifacts width to [min, 60% of viewport]. Pure. */
export function clampWidth(w, min, viewport) {
  const max = Math.max(min, Math.floor(viewport * 0.6));
  return Math.round(Math.min(Math.max(w, min), max));
}

export function mountArtifacts({ aside, splitter, app, store, actions }) {
  const tabsEl = h('div', { class: 'pill-tabs', attrs: { role: 'tablist' } });
  const closeBtn = h('button', { class: 'btn btn--ghost btn--icon btn--sm artifacts__close', type: 'button' }, icon('x'));
  closeBtn.addEventListener('click', () => actions.toggleArtifacts());
  const body = h('div', { class: 'artifacts__body', attrs: { role: 'tabpanel' } });
  aside.append(h('div', { class: 'artifacts__header' }, tabsEl, closeBtn), body);

  const minW = () => parseInt(getComputedStyle(document.documentElement).getPropertyValue('--artifacts-min-w'), 10) || 280;
  const curW = () => aside.getBoundingClientRect().width || parseInt(getComputedStyle(app).getPropertyValue('--artifacts-w'), 10) || 420;

  function setWidth(w, persist) {
    const c = clampWidth(w, minW(), window.innerWidth);
    app.style.setProperty('--artifacts-w', c + 'px');
    splitter.setAttribute('aria-valuenow', String(c));
    if (persist) writeStore(WIDTH_KEY, c);
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
    writeStore(WIDTH_KEY, parseInt(app.style.getPropertyValue('--artifacts-w'), 10) || curW());
  };
  splitter.addEventListener('pointerup', end);
  splitter.addEventListener('pointercancel', end);
  splitter.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    setWidth(curW() + (e.key === 'ArrowLeft' ? 24 : -24), true);
  });
  splitter.addEventListener('dblclick', () => actions.toggleArtifacts());

  function renderTabs(s) {
    clear(tabsEl);
    for (const id of TABS) {
      const on = s.artifactsTab === id;
      tabsEl.append(h('button', {
        class: 'pill-tab' + (on ? ' is-active' : ''), type: 'button', text: t('artifacts.' + id),
        attrs: { role: 'tab', 'aria-selected': String(on), tabindex: on ? '0' : '-1' },
        on: { click: () => { store.set({ artifactsTab: id }); if (id === 'git') actions.refreshGit(); } },
      }));
    }
    closeBtn.setAttribute('aria-label', t('nav.toggleArtifacts'));
    closeBtn.title = t('nav.toggleArtifacts');
    splitter.setAttribute('aria-label', t('nav.toggleArtifacts'));
  }
  tabsEl.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const s = store.get();
    const i = TABS.indexOf(s.artifactsTab);
    const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
    store.set({ artifactsTab: next });
    if (next === 'git') actions.refreshGit();
    const el = tabsEl.querySelector('[aria-selected="true"]');
    if (el) el.focus();
  });

  function renderGit(s, p) {
    const st = s.git[p.id];
    const wrap = h('div', { class: 'git-panel' });
    wrap.append(h('div', { class: 'row between' },
      h('strong', { text: t('artifacts.git') }),
      h('button', { class: 'btn btn--ghost btn--sm', type: 'button', on: { click: () => actions.refreshGit() } }, icon('refresh'), t('artifacts.refresh'))));
    if (!st) {
      wrap.append(h('div', { class: 'muted row' }, h('span', { class: 'spinner' }), t('common.loading')));
    } else if (!st.isRepo) {
      wrap.append(h('div', { class: 'muted', text: t('artifacts.notRepo') }));
    } else {
      wrap.append(
        h('div', { class: 'card' },
          h('div', { class: 'row between' },
            h('span', { class: 'row' }, icon('git'), h('span', { class: 'muted', text: t('artifacts.branch') })),
            h('span', { class: 'mono strong', text: st.branch || '-' })),
          h('div', { class: 'row between' },
            h('span', { class: 'muted', text: st.dirty ? t('artifacts.changes', { count: st.dirty }) : t('artifacts.clean') }),
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

  let sig = '';
  function render() {
    const s = store.get();
    const p = activeProject(s);
    const signature = JSON.stringify([s.artifactsTab, p && p.id, p && s.git[p.id]]) + t('artifacts.title');
    if (signature === sig) return;
    sig = signature;
    renderTabs(s);
    clear(body);
    if (s.artifactsTab === 'git' && p) {
      body.append(renderGit(s, p));
    } else {
      body.append(h('div', { class: 'empty-state' },
        h('div', { class: 'empty-state__icon' }, icon(s.artifactsTab === 'files' ? 'folder' : s.artifactsTab === 'dashboard' ? 'layers' : 'file', 'icon--lg')),
        h('div', { class: 'empty-state__title', text: t('artifacts.empty') }),
        h('div', { class: 'empty-state__text', text: t('artifacts.emptyText') })));
    }
    body.setAttribute('aria-label', t('artifacts.' + s.artifactsTab));
  }
  store.subscribe((s, prev) => {
    if (s.artifactsTab !== prev.artifactsTab || s.activeProjectId !== prev.activeProjectId || s.git !== prev.git) render();
  });
  render();
  return { update: () => { sig = ''; render(); } };
}
