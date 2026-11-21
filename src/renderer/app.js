// FlowState renderer entry: wires settings, i18n, store, components and agent events.
import { getApi, isMockApi } from './lib/api.js';
import { setLanguage, detectLanguage, onChange, t } from './lib/i18n.js';
import { createStore, createInitialState, activeProject } from './lib/store.js';
import { reduceEvent, addUserMessage, failTurn, resolvePermission } from './lib/events.js';
import { h } from './lib/dom.js';
import { readStore, writeStore } from './lib/storage.js';
import { mountRail, mountSidebar } from './components/sidebar.js';
import { mountMain } from './components/main.js';
import { mountBanners } from './components/banners.js';
import { mountArtifacts, COLLAPSED_KEY } from './components/artifacts.js';
import { openSettingsDialog } from './components/settings-dialog.js';
import { openWalkthrough } from './components/walkthrough.js';
import { confirmDialog, toast } from './components/modal.js';

const api = getApi();
const store = createStore(createInitialState());

function applyAppearance(settings) {
  const root = document.documentElement;
  root.dataset.theme = settings.theme === 'light' ? 'light' : 'dark';
  if (settings.codeTheme) root.dataset.codeTheme = settings.codeTheme;
  else delete root.dataset.codeTheme;
}

async function refreshGit(projectId) {
  const id = projectId || store.get().activeProjectId;
  if (!id) return;
  try {
    const st = await api.git.status(id);
    store.set((s) => ({ git: { ...s.git, [id]: st } }));
  } catch {
    store.set((s) => ({ git: { ...s.git, [id]: { isRepo: false, branch: null, dirty: 0 } } }));
  }
}

const ui = {};

const actions = {
  async selectProject(id) {
    store.set({ activeProjectId: id, view: 'project' });
    persistLastProject(id);
    refreshGit(id);
  },
  setView(view) {
    if (view === 'project' && !store.get().activeProjectId && store.get().projects[0]) {
      actions.selectProject(store.get().projects[0].id);
      return;
    }
    store.set({ view });
  },
  async updateProject(id, patch) {
    try {
      const updated = await api.projects.update(id, patch);
      store.set((s) => ({ projects: s.projects.map((p) => (p.id === id ? { ...p, ...updated } : p)) }));
    } catch {
      toast(t('errors.saveFailed'), 'error');
    }
  },
  async updateSettings(patch) {
    const prevLang = store.get().settings.language;
    try {
      const next = await api.settings.set(patch);
      store.set({ settings: next });
      applyAppearance(next);
      if (next.language !== prevLang) await setLanguage(next.language);
    } catch {
      toast(t('errors.saveFailed'), 'error');
    }
  },
  async send(text) {
    const s = store.get();
    const p = activeProject(s);
    if (!p) return;
    store.updateChat(p.id, (c) => addUserMessage(c, text));
    ui.main.chat.stickToBottom();
    try {
      await api.agent.send({ projectId: p.id, text });
    } catch (e) {
      store.updateChat(p.id, (c) => failTurn(c, (e && e.message) || t('errors.spawnFailed', { agent: t('agent.' + p.agent) })));
    }
  },
  async stop() {
    const id = store.get().activeProjectId;
    if (id) { try { await api.agent.stop(id); } catch { /* ignore */ } }
  },
  async approveAndRetry(messageId) {
    const s = store.get();
    const p = activeProject(s);
    const chat = p && s.chats[p.id];
    if (!p || !chat || !chat.lastPrompt || chat.running) return;
    const ok = await confirmDialog({
      title: t('chat.approveRetry'), message: t('chat.approveRetryConfirm'), confirmLabel: t('chat.approveRetry'),
    });
    if (!ok) return;
    store.updateChat(p.id, (c) => resolvePermission(c, messageId, 'approved'));
    await actions.updateProject(p.id, { mode: 'acceptEdits' });
    await actions.send(chat.lastPrompt + '\n\n' + t('chat.approveRetryNote'));
  },
  async undoTurn() {
    const id = store.get().activeProjectId;
    if (!id) return;
    try {
      const r = await api.git.undoTurn(id);
      toast(r && r.message ? r.message : t('chat.undoDone'), r && r.ok ? 'success' : 'error');
    } catch {
      toast(t('errors.generic'), 'error');
    }
    refreshGit(id);
  },
  refreshGit: () => refreshGit(),
  async recheckHealth() {
    try { store.set({ health: await api.health.check() }); } catch { /* keep previous */ }
  },
  setHealth(health) { store.set({ health }); },
  toggleSidebar() {
    const collapsed = !store.get().sidebarCollapsed;
    store.set({ sidebarCollapsed: collapsed });
  },
  toggleArtifacts() {
    const collapsed = !store.get().artifactsCollapsed;
    store.set({ artifactsCollapsed: collapsed });
    writeStore(COLLAPSED_KEY, collapsed ? '1' : '0');
  },
  openSettings() { openSettingsDialog({ store, actions, onWalkthrough: () => actions.openWalkthrough() }); },
  openWalkthrough() { openWalkthrough({ store, api, actions }); },
  async createProject(data) {
    const payload = { name: data.name, path: data.path, agent: data.agent, mode: data.mode, autoCommit: data.autoCommit };
    let proj = await api.projects.add(payload);
    if (proj.autoCommit !== data.autoCommit || proj.mode !== data.mode || proj.agent !== data.agent) {
      proj = { ...proj, ...(await api.projects.update(proj.id, { autoCommit: data.autoCommit, mode: data.mode, agent: data.agent })) };
    }
    store.set((s) => ({ projects: [...s.projects.filter((p) => p.id !== proj.id), proj] }));
    await actions.selectProject(proj.id);
    return proj;
  },
  async walkthroughClosed() {
    if (!store.get().settings.walkthroughDone) await actions.updateSettings({ walkthroughDone: true });
  },
};

let lastPersisted = null;
function persistLastProject(id) {
  if (id === lastPersisted) return;
  lastPersisted = id;
  api.settings.set({ lastProjectId: id }).catch(() => {});
}

function syncLayout(app) {
  const s = store.get();
  app.classList.toggle('is-sidebar-collapsed', s.sidebarCollapsed);
  app.classList.toggle('is-artifacts-collapsed', s.artifactsCollapsed);
}

function buildShell() {
  const root = document.getElementById('root');
  root.replaceChildren();
  const bannerSlot = h('div', { class: 'banner-slot' });
  const rail = h('nav', { class: 'rail' });
  const sidebar = h('aside', { class: 'sidebar' });
  const main = h('main', { class: 'main' });
  const splitter = h('div', { class: 'splitter', attrs: { role: 'separator', 'aria-orientation': 'vertical', tabindex: '0', 'aria-valuenow': '420' } });
  const artifacts = h('aside', { class: 'artifacts' });
  const app = h('div', { class: 'app' }, rail, sidebar, main, splitter, artifacts);
  root.append(bannerSlot, app);
  const deps = { store, api, actions };
  ui.rail = mountRail(rail, deps);
  ui.sidebar = mountSidebar(sidebar, deps);
  ui.main = mountMain(main, deps);
  ui.banners = mountBanners(bannerSlot, deps);
  ui.artifacts = mountArtifacts({ aside: artifacts, splitter, app, store, actions });
  store.subscribe((s, prev) => {
    if (s.sidebarCollapsed !== prev.sidebarCollapsed || s.artifactsCollapsed !== prev.artifactsCollapsed) syncLayout(app);
  });
  syncLayout(app);
  nav(rail);
}

function nav(rail) { rail.setAttribute('aria-label', t('nav.workspace')); }

async function boot() {
  let settings = await api.settings.get();
  const lang = settings.language || detectLanguage(navigator.language);
  await setLanguage(lang);
  settings = { ...settings, language: lang };
  applyAppearance(settings);
  store.set({
    settings,
    sidebarCollapsed: false,
    artifactsCollapsed: readStore(COLLAPSED_KEY, '0') === '1',
  });
  const projects = await api.projects.list();
  const last = projects.find((p) => p.id === settings.lastProjectId) || projects[0] || null;
  store.set({ projects, activeProjectId: last ? last.id : null });
  lastPersisted = last ? last.id : null;

  buildShell();
  if (last) refreshGit(last.id);

  api.health.check().then((health) => store.set({ health })).catch(() => {});
  api.onHealth((health) => store.set({ health }));
  api.onAgentEvent(({ projectId, event }) => {
    store.updateChat(projectId, (c) => reduceEvent(c, event));
    if (event && event.type === 'result') refreshGit(projectId);
  });

  onChange((l) => {
    document.title = t('app.name');
    ui.rail.update();
    ui.sidebar.update();
    ui.main.update();
    ui.banners.update();
    ui.artifacts.update();
    nav(document.querySelector('.rail'));
    if (store.get().settings.language !== l) store.set({ settings: { ...store.get().settings, language: l } });
  });
  document.title = t('app.name');

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (store.get().sidebarCollapsed) store.set({ sidebarCollapsed: false });
      ui.sidebar.focusSearch();
    }
  });

  if (!settings.walkthroughDone) actions.openWalkthrough();
  if (isMockApi()) window.__flowstate = { store, actions };
}

boot().catch((e) => {
  console.error(e);
  const root = document.getElementById('root');
  if (root) root.replaceChildren(h('div', { class: 'empty-state' }, h('div', { class: 'empty-state__title', text: 'FlowState' }), h('div', { class: 'empty-state__text', text: String((e && e.message) || e) })));
});
