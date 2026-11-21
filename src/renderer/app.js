// FlowState renderer entry: wires settings, i18n, store, components and agent events.
import { getApi, isMockApi } from './lib/api.js';
import { setLanguage, detectLanguage, onChange, t } from './lib/i18n.js';
import { createStore, createInitialState, activeProject } from './lib/store.js';
import { reduceEvent, addUserMessage, failTurn, resolvePermission, createChatState } from './lib/events.js';
import { replayHistory, dedupeLive } from './lib/history.js';
import { installJobs, dashboardJobs, WINGET_IDS } from './lib/install-state.js';
import { openInstallDialog } from './components/install-dialog.js';
import { h } from './lib/dom.js';
import { readStore, writeStore } from './lib/storage.js';
import { mountRail, mountSidebar } from './components/sidebar.js';
import { mountMain } from './components/main.js';
import { mountBanners } from './components/banners.js';
import { mountArtifacts, COLLAPSED_KEY } from './components/artifacts.js';
import { openSettingsDialog } from './components/settings-dialog.js';
import { openWalkthrough } from './components/walkthrough.js';
import { confirmDialog, toast, openDialog } from './components/modal.js';

const api = getApi();
const store = createStore(createInitialState());

function applyAppearance(settings) {
  const root = document.documentElement;
  root.dataset.theme = ['light', 'gold'].includes(settings.theme) ? settings.theme : 'dark';
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

const histLoaded = new Set();
const histBuffer = new Map(); // projectId -> live events received while history loads

/** Load persisted history once per project, replay it through the reducer, then apply buffered live events. */
async function loadHistory(pid, force) {
  if (!force && histLoaded.has(pid)) return;
  histLoaded.add(pid);
  histBuffer.set(pid, []);
  let records = [];
  try { records = (api.history && (await api.history.get(pid))) || []; } catch { records = []; }
  const buffered = histBuffer.get(pid) || [];
  histBuffer.delete(pid);
  const existing = store.get().chats[pid];
  if (!existing || !existing.messages.length) {
    let running = false;
    try { running = !!(api.agent.status && (await api.agent.status(pid)).running); } catch { running = false; }
    store.updateChat(pid, () => {
      let st = replayHistory(records);
      for (const ev of dedupeLive(records, buffered)) st = reduceEvent(st, ev);
      return { ...st, running: running || (buffered.length > 0 && !buffered.some((e) => e && e.type === 'result')) };
    });
  } else {
    for (const ev of buffered) store.updateChat(pid, (c) => reduceEvent(c, ev));
  }
  if (store.get().activeProjectId === pid && ui.main) ui.main.chat.stickToBottom();
}

function setRemote(pid, patch) {
  store.set((s) => ({ remote: { ...s.remote, [pid]: { running: false, supported: true, ...(s.remote[pid] || {}), ...patch } } }));
}

/** Everything that follows "this project is now the active one". */
function openProject(id) {
  refreshGit(id);
  try { if (api.files && api.files.watch) Promise.resolve(api.files.watch(id)).catch(() => {}); } catch { /* backend not ready */ }
  loadHistory(id);
  actions.refreshRemote(id);
  actions.refreshDashboard(id);
}

const actions = {
  async selectProject(id) {
    store.set({ activeProjectId: id, view: 'project' });
    persistLastProject(id);
    openProject(id);
  },
  setView(view) {
    if (view === 'project' && !store.get().activeProjectId && store.get().projects[0]) {
      actions.selectProject(store.get().projects[0].id);
      return;
    }
    store.set({ view });
    if (view === 'prompts') actions.loadTemplates();
  },
  // ---- prompt library ----
  async loadTemplates() {
    try {
      const list = api.prompts ? await api.prompts.list() : [];
      store.set({ templates: Array.isArray(list) ? list : [] });
    } catch {
      toast(t('prompts.loadFailed'), 'error');
    }
  },
  selectTemplate(id) { store.set({ selectedTemplate: id }); },
  async openTemplate(id) {
    store.set({ view: 'prompts', selectedTemplate: id });
    await actions.loadTemplates();
    if (!store.get().templates.some((x) => x.id === id)) store.set({ selectedTemplate: null });
  },
  useInChat(text) {
    if (!activeProject(store.get())) { toast(t('prompts.useNeedsProject'), 'warn'); return; }
    store.set({ view: 'project' });
    ui.main.composer.setText(text);
    toast(t('prompts.insertedInComposer'), 'success');
  },
  // ---- project menu ----
  renameProject(id) {
    const p = store.get().projects.find((x) => x.id === id);
    if (!p) return;
    const input = h('input', { class: 'input', id: 'rename-input', type: 'text', value: p.name, maxLength: 80 });
    const err = h('div', { class: 'field__error', hidden: true, attrs: { role: 'alert' }, text: t('menu.nameRequired') });
    const cancel = h('button', { class: 'btn', type: 'button', text: t('common.cancel') });
    const ok = h('button', { class: 'btn btn--primary', type: 'button', text: t('common.save') });
    const dlg = openDialog({
      title: t('menu.rename'), footer: [cancel, ok],
      body: h('div', { class: 'field' }, h('label', { class: 'field__label', for: 'rename-input', text: t('project.name') }), input, err),
    });
    const save = async () => {
      const name = input.value.trim();
      if (!name) { err.hidden = false; input.focus(); return; }
      dlg.close('ok');
      if (name !== p.name) await actions.updateProject(id, { name });
    };
    cancel.addEventListener('click', () => dlg.close('cancel'));
    ok.addEventListener('click', save);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
    input.select();
  },
  async removeProject(id) {
    const p = store.get().projects.find((x) => x.id === id);
    if (!p) return;
    const ok = await confirmDialog({ title: t('menu.remove'), message: t('menu.removeConfirm', { name: p.name }), confirmLabel: t('menu.remove'), danger: true });
    if (!ok) return;
    try { await api.projects.remove(id); } catch { toast(t('errors.generic'), 'error'); return; }
    const rest = store.get().projects.filter((x) => x.id !== id);
    const wasActive = store.get().activeProjectId === id;
    store.set((s) => {
      const chats = { ...s.chats }; delete chats[id];
      return { projects: rest, chats, activeProjectId: wasActive ? (rest[0] ? rest[0].id : null) : s.activeProjectId };
    });
    histLoaded.delete(id);
    if (wasActive) { if (rest[0]) { persistLastProject(rest[0].id); openProject(rest[0].id); } else persistLastProject(null); }
    toast(t('menu.removed', { name: p.name }), 'success');
  },
  async clearHistory(id) {
    const ok = await confirmDialog({ title: t('history.clear'), message: t('history.clearConfirm'), confirmLabel: t('history.clear'), danger: true });
    if (!ok) return;
    try { if (api.history) await api.history.clear(id); } catch { toast(t('errors.generic'), 'error'); return; }
    store.updateChat(id, () => createChatState());
    toast(t('history.cleared'), 'success');
  },
  // ---- remote control ----
  async refreshRemote(pid) {
    try {
      const r = await api.remote.status(pid);
      setRemote(pid, { running: !!r.running, info: r.info || '', supported: r.supported !== false, busy: false });
    } catch {
      setRemote(pid, { running: false, supported: false, busy: false });
    }
  },
  async toggleRemote(pid) {
    const p = store.get().projects.find((x) => x.id === pid);
    const cur = store.get().remote[pid] || { running: false, supported: true };
    if (!p || cur.busy || cur.supported === false) return;
    if (!cur.running) {
      const msg = t('remote.confirm') + (p.agent === 'agy' ? '\n\n' + t('remote.confirmAgy') : '');
      const ok = await confirmDialog({ title: t('remote.confirmTitle'), message: msg, confirmLabel: t('remote.enable') });
      if (!ok) return;
    }
    setRemote(pid, { busy: true });
    try {
      const r = cur.running ? await api.remote.stop(pid) : await api.remote.start(pid);
      if (!cur.running && r && r.supported === false) {
        setRemote(pid, { running: false, supported: false, busy: false });
        toast(t('remote.notSupported'), 'warn', 7000);
        return;
      }
      setRemote(pid, { running: !!(r && r.running), info: (r && r.info) || '', busy: false });
      if (!cur.running && !(r && r.running)) toast(t('remote.startFailed'), 'error');
    } catch (e) {
      setRemote(pid, { busy: false });
      toast(t('remote.error', { message: (e && e.message) || t('errors.generic') }), 'error', 7000);
    }
  },
  // ---- dashboard ----
  setDashboard(pid, st) { store.set((s) => ({ dashboard: { ...s.dashboard, [pid]: st } })); },
  async refreshDashboard(pid) {
    try { actions.setDashboard(pid, await api.dashboard.status(pid)); } catch {
      actions.setDashboard(pid, { python: { found: false, version: null }, venv: false, deps: false, running: false, url: null, app: null, apps: [] });
    }
  },
  // ---- prerequisites / auth ----
  async installPrereq(id, { dialog = true } = {}) {
    if (installJobs.get(id).running) return false;
    const ok = await confirmDialog({
      title: t('prereq.installTitle', { name: t('health.' + id) }),
      message: t('prereq.installConfirm', { name: t('health.' + id), pkg: WINGET_IDS[id] || id }),
      confirmLabel: t('prereq.install'),
    });
    if (!ok) return false;
    installJobs.start(id);
    if (dialog) openInstallDialog(id);
    let good = false;
    try {
      const r = await api.prereq.install(id);
      good = !(r && r.ok === false);
      if (r && r.log && !installJobs.get(id).lines.length) installJobs.log(id, r.log);
      installJobs.finish(id, good ? null : t('prereq.failed'));
    } catch (e) {
      installJobs.finish(id, (e && e.message) || t('prereq.failed'));
    }
    await actions.recheckHealth();
    if (id === 'python') actions.refreshDashboard(store.get().activeProjectId);
    toast(good ? t('prereq.installedToast', { name: t('health.' + id) }) : t('prereq.failed'), good ? 'success' : 'error');
    return good;
  },
  async signIn(agent) {
    try {
      const r = await api.auth.login(agent);
      if (r && r.ok === false) toast(t('auth.loginFailed'), 'error');
      else toast(t('auth.loginStarted'), 'success', 10000);
    } catch (e) {
      toast((e && e.message) || t('auth.loginFailed'), 'error');
    }
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
  ui.artifacts = mountArtifacts({ aside: artifacts, splitter, app, store, api, actions });
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
  if (last) openProject(last.id);
  actions.loadTemplates();

  api.health.check().then((health) => store.set({ health })).catch(() => {});
  api.onHealth((health) => store.set({ health }));
  api.onAgentEvent(({ projectId, event }) => {
    if (histBuffer.has(projectId)) { histBuffer.get(projectId).push(event); return; }
    store.updateChat(projectId, (c) => reduceEvent(c, event));
    if (event && event.type === 'result') refreshGit(projectId);
  });

  if (api.onFiles) api.onFiles((evt) => ui.artifacts.onFiles(evt));
  if (api.onRemote) api.onRemote(({ projectId, running, info }) => setRemote(projectId, { running: !!running, info: info || '', busy: false }));
  if (api.onInstall) {
    api.onInstall(({ id, kind, text }) => {
      if (kind === 'log' || kind === 'error') installJobs.log(id, text);
    });
  }
  if (api.onDashboard) {
    api.onDashboard(({ projectId, kind, text, status }) => {
      if (kind === 'log' || kind === 'error') { if (dashboardJobs.get(projectId).running) dashboardJobs.log(projectId, text); }
      if (kind === 'error') toast(text || t('errors.generic'), 'error');
      if (kind === 'status' && status && typeof status === 'object') actions.setDashboard(projectId, status);
      if (kind === 'done' || (kind === 'status' && !status)) actions.refreshDashboard(projectId);
    });
  }

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
