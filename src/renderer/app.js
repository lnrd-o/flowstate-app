// FlowState renderer entry: wires settings, i18n, store, components and agent events.
import { getApi, isMockApi } from './lib/api.js';
import { setLanguage, detectLanguage, onChange, t } from './lib/i18n.js';
import { createStore, createInitialState, activeProject, isDev } from './lib/store.js';
import { reduceEvent, addUserMessage, failTurn, resolvePermission, addSystemNote, createChatState } from './lib/events.js';
import { RETRY_NOTE, stripRetryNote } from './lib/approvals.js';
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
import { openSetupWizard } from './components/setup-wizard.js';
import { openLoginDialog } from './components/login-dialog.js';
import { mountTitlebar } from './components/titlebar.js';
import { applyStatus, applyHealth, applyLoginEvent } from './lib/login-state.js';
import { normalizePlatform } from './lib/titlebar-state.js';
import { confirmDialog, toast, openDialog } from './components/modal.js';
import { createMethodActions } from './lib/method-actions.js';
import { stopNeedsConfirm } from './lib/tasks.js';
import { createThumbCache } from './lib/images.js';
import { createUiPersist } from './lib/ui-persist.js';
import { createMenuActions, dispatchMenu } from './lib/menu-actions.js';
import { acceleratorMatches } from './lib/menu-state.js';
import { flattenMenu } from '../shared/menu.js';
import { openUsageDialog } from './components/usage-dialog.js';
import { openProjectDataDialog } from './components/project-data-dialog.js';
import { openProjectSettingsDialog } from './components/project-settings-dialog.js';
import { openAboutDialog, openShortcutsDialog } from './components/help-dialogs.js';

const api = getApi();
const store = createStore(createInitialState());
const thumbs = createThumbCache(api);
const persist = createUiPersist({ api, store });

function applyAppearance(settings) {
  const root = document.documentElement;
  root.dataset.theme = ['light', 'gold'].includes(settings.theme) ? settings.theme : 'dark';
  // The default dark code palettes would clash with the light app theme: let the CSS pick github-light there.
  const darkDefault = settings.codeTheme === 'vs-dark' || settings.codeTheme === 'github-dark';
  if (settings.codeTheme && !(settings.theme === 'light' && darkDefault)) root.dataset.codeTheme = settings.codeTheme;
  else delete root.dataset.codeTheme;
  if (ui.titlebar) ui.titlebar.syncTheme(); // recolour the native window controls
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

/** Single entry for Health snapshots: also merges the per-agent signed-in flags. */
function setHealthState(health) {
  store.set((s) => ({ health, signedIn: applyHealth(s.signedIn, health) }));
}

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
      const agent = (store.get().projects.find((p) => p.id === pid) || {}).agent;
      let st = replayHistory(records, undefined, { agent });
      for (const ev of dedupeLive(records, buffered)) st = reduceEvent(st, ev, { now: Date.now() });
      return { ...st, running: running || (buffered.length > 0 && !buffered.some((e) => e && e.type === 'result')) };
    });
  } else {
    for (const ev of buffered) store.updateChat(pid, (c) => reduceEvent(c, ev, { now: Date.now() }));
  }
  if (store.get().activeProjectId === pid && ui.main) ui.main.chat.stickToBottom();
}

function setRemote(pid, patch) {
  store.set((s) => ({ remote: { ...s.remote, [pid]: { running: false, supported: true, ...(s.remote[pid] || {}), ...patch } } }));
}

/** Everything that follows "this project is now the active one". */
function openProject(id, opts) {
  refreshGit(id);
  try { if (api.files && api.files.watch) Promise.resolve(api.files.watch(id)).catch(() => {}); } catch { /* backend not ready */ }
  const hist = loadHistory(id);
  actions.refreshRemote(id);
  actions.refreshDashboard(id);
  actions.refreshStoreStatus(id);
  if (!(opts && opts.initial)) actions.loadMethods({ quiet: true });
  const p = store.get().projects.find((x) => x.id === id);
  if (p) actions.loadModels(p.agent);
  if (!(opts && opts.initial)) {
    store.set({ openFile: null });
    persist.readProject(id).then((pui) => applyProjectPlan(id, persist.plan(null, pui), hist));
  }
  return hist;
}

/** Apply a validated per-project UI plan (tab, open file, composer draft, chat scroll). */
function applyProjectPlan(id, plan, hist) {
  if (store.get().activeProjectId !== id) return;
  if (plan.openFile && ui.artifacts) ui.artifacts.openFile(plan.openFile);
  if (plan.artifactsTab) store.set({ artifactsTab: plan.artifactsTab });
  if (plan.draft && ui.main) ui.main.composer.setDraft(id, plan.draft);
  if (plan.scroll != null && ui.main) Promise.resolve(hist).then(() => { if (store.get().activeProjectId === id) ui.main.chat.restoreScroll(plan.scroll); });
}

const actions = {
  async selectProject(id) {
    store.set({ activeProjectId: id, view: 'project' });
    persistLastProject(id);
    await openProject(id);
  },
  setView(view) {
    if (view === 'project' && !store.get().activeProjectId && store.get().projects[0]) {
      actions.selectProject(store.get().projects[0].id);
      return;
    }
    store.set({ view });
    if (view === 'prompts') actions.loadTemplates();
    if (view === 'methodologies') actions.loadMethods();
    if (view === 'tasks') actions.refreshTasks();
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
  /** In-app sign-in (Claude URL + code, AGY terminal). */
  openLogin(agent) { openLoginDialog({ store, api, actions, agent }); },
  signIn(agent) { actions.openLogin(agent); },
  applyLoginStatus(status) { store.set((s) => ({ signedIn: applyStatus(s.signedIn, status) })); },
  async refreshLoginStatus() {
    try { actions.applyLoginStatus(await api.login.status()); } catch { /* backend not ready */ }
  },
  async signOut(agent) {
    if (agent !== 'claude') { actions.openLogin(agent); return false; }
    const name = t('agent.' + agent);
    const ok = await confirmDialog({ title: t('login.signOutConfirmTitle', { agent: name }), message: t('login.signOutConfirm', { agent: name }), confirmLabel: t('login.signOut'), danger: true });
    if (!ok) return false;
    try {
      const r = await api.login.logout(agent);
      if (r && r.ok === false) { toast(t('login.signOutFailed'), 'error'); return false; }
      toast(t('login.signedOutToast', { agent: name }), 'success');
    } catch { toast(t('login.signOutFailed'), 'error'); return false; }
    await actions.refreshLoginStatus();
    actions.recheckHealth();
    return true;
  },
  /** Old behaviour: sign in from a separate console window. */
  async signInExternal(agent) {
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
      if (patch.agent) actions.loadModels(patch.agent);
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
  /** opts.allow: optional per-turn narrow permission rules [{tool, pattern}] (claude only; never persisted). */
  async send(text, opts) {
    const s = store.get();
    const p = activeProject(s);
    if (!p) return;
    const images = opts && Array.isArray(opts.images) ? opts.images.filter((i) => i && typeof i.rel === 'string').slice(0, 5) : [];
    store.updateChat(p.id, (c) => addUserMessage(c, text, { agent: p.agent, now: Date.now(), images: images.map((i) => i.rel) }));
    ui.main.chat.stickToBottom();
    try {
      const allow = opts && Array.isArray(opts.allow) && opts.allow.length ? opts.allow : null;
      await api.agent.send({ projectId: p.id, text, ...(allow ? { allow } : {}), ...(images.length ? { images } : {}) });
    } catch (e) {
      store.updateChat(p.id, (c) => failTurn(c, (e && e.message) || t('errors.spawnFailed', { agent: t('agent.' + p.agent) })));
    }
  },
  /** Show a project file in the Files tab (opens the pane if collapsed). */
  openFile(rel) {
    if (!rel) return;
    store.set({ artifactsTab: 'files', artifactsCollapsed: false });
    writeStore(COLLAPSED_KEY, '0');
    if (ui.artifacts) ui.artifacts.openFile(rel);
  },
  /** Scroll the chat to a tool card (Activity tab and turn summary links). */
  revealCard(id) { if (ui.main) ui.main.chat.reveal(id); },
  async stop() {
    const id = store.get().activeProjectId;
    if (id) { try { await api.agent.stop(id); } catch { /* ignore */ } }
  },
  /** Approval card: "Allow this once" = re-send the last prompt of the turn with narrow per-turn allow rules. */
  async allowOnce(approvalId, rules) {
    const s = store.get();
    const p = activeProject(s);
    const chat = p && s.chats[p.id];
    if (!p || !chat || !chat.lastPrompt || chat.running || !Array.isArray(rules) || !rules.length) return;
    store.updateChat(p.id, (c) => resolvePermission(c, approvalId, 'allowed'));
    await actions.send(stripRetryNote(chat.lastPrompt) + '\n\n' + RETRY_NOTE, { allow: rules });
  },
  /** "Allow for this project" (and the only option for AGY / tools that cannot be narrowed): switch to Accept edits, retry. */
  async allowForProject(approvalId) {
    const s = store.get();
    const p = activeProject(s);
    const chat = p && s.chats[p.id];
    if (!p || !chat || !chat.lastPrompt || chat.running) return;
    const ok = await confirmDialog({
      title: t('approval.projectConfirmTitle'), message: t('approval.projectConfirm', { agent: t('agent.' + p.agent) }), confirmLabel: t('approval.projectConfirmOk'),
    });
    if (!ok) return;
    store.updateChat(p.id, (c) => resolvePermission(c, approvalId, 'allowed'));
    await actions.updateProject(p.id, { mode: 'acceptEdits' });
    await actions.send(stripRetryNote(chat.lastPrompt) + '\n\n' + RETRY_NOTE);
  },
  dismissApproval(approvalId) {
    const id = store.get().activeProjectId;
    if (!id) return;
    store.updateChat(id, (c) => addSystemNote(resolvePermission(c, approvalId, 'dismissed'), 'approval.dismissedNote'));
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
    try { setHealthState(await api.health.check()); } catch { /* keep previous */ }
  },
  setHealth(health) { setHealthState(health); },
  toggleSidebar() {
    const collapsed = !store.get().sidebarCollapsed;
    store.set({ sidebarCollapsed: collapsed });
  },
  toggleArtifacts() {
    const collapsed = !store.get().artifactsCollapsed;
    store.set({ artifactsCollapsed: collapsed });
    writeStore(COLLAPSED_KEY, collapsed ? '1' : '0');
  },
  openSettings() { openSettingsDialog({ store, actions, onWalkthrough: () => actions.openSetup() }); },
  /** New-project wizard (What do you need help with?). */
  openWalkthrough() { openWalkthrough({ store, api, actions }); },
  /** First-run setup wizard (language, look, helpers, tools...). */
  openSetup() { openSetupWizard({ store, api, actions }); },
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
  // ---- Phase 7: models, usage, limits, DeepSeek, tasks, project store, dialogs, menu ----
  async loadModels(agent, { force } = {}) {
    const s = store.get();
    if (!agent || !api.models || !api.models.list) return;
    if (s.modelsLoading[agent] || (!force && s.models[agent] && !s.models[agent].error)) return;
    store.set({ modelsLoading: { ...s.modelsLoading, [agent]: true } });
    let list;
    try { list = await api.models.list(agent); } catch (e) { list = { agent, source: 'static', models: [], efforts: [], error: (e && e.message) || 'error' }; }
    store.set((st) => ({ models: { ...st.models, [agent]: list }, modelsLoading: { ...st.modelsLoading, [agent]: false } }));
  },
  async refreshUsage() {
    try { if (api.usage && api.usage.get) store.set({ usage: await api.usage.get() }); } catch { /* keep the last snapshot */ }
  },
  openUsage() { openUsageDialog({ store, api, actions }); },
  /** Limit card / banner: move the active project to the other agent. */
  async switchAgent(agent) {
    const p = activeProject(store.get());
    if (!p || p.agent === agent) return;
    await actions.updateProject(p.id, { agent });
    toast(t('usage.limit.switched', { agent: t('agent.' + agent) }), 'success');
  },
  async refreshDeepseek(force) {
    try {
      const st = await api.deepseek.status(!!force);
      store.set({ deepseek: st });
      return st;
    } catch {
      store.set((s) => ({ deepseek: { configured: !!(s.deepseek && s.deepseek.configured), enabled: !!s.settings.deepseekEnabled, error: 'offline' } }));
      return null;
    }
  },
  async saveDeepseekKey(key) {
    const r = await api.deepseek.setKey(key);
    if (r && r.ok) await actions.refreshDeepseek(true);
    return r;
  },
  async removeDeepseekKey() {
    const r = await api.deepseek.setKey(null);
    await actions.refreshDeepseek(true);
    return r;
  },
  async refreshTasks() {
    try { if (api.tasks && api.tasks.list) store.set({ tasks: await api.tasks.list() }); } catch { /* backend not ready */ }
  },
  /** item: { kind, id, name, project }. Agents and methodology runs ask first. */
  async stopTask(item) {
    if (stopNeedsConfirm(item.kind)) {
      const ok = await confirmDialog({ title: t('tasks.stopConfirmTitle', { name: item.name }), message: t('tasks.stopConfirm', { project: item.project || item.name }), confirmLabel: t('tasks.stop'), danger: true });
      if (!ok) { actions.refreshTasks(); return; }
    }
    try {
      const r = await api.tasks.stop({ kind: item.kind, id: item.id });
      if (r && r.ok === false) toast(t('tasks.stopFailed'), 'error');
    } catch { toast(t('tasks.stopFailed'), 'error'); }
    actions.refreshTasks();
  },
  async refreshStoreStatus(pid) {
    try {
      if (!api.store || !api.store.status) return;
      const st = await api.store.status(pid);
      store.set((s) => ({ storeStatus: { ...s.storeStatus, [pid]: st } }));
    } catch { /* not available (older backend) */ }
  },
  async saveProjectNow(pid) {
    try {
      const r = await api.store.save(pid);
      toast(r && r.ok === false ? t('pdata.saveFailed') : t('pdata.saved'), r && r.ok === false ? 'error' : 'success');
    } catch { toast(t('pdata.saveFailed'), 'error'); }
    await actions.refreshStoreStatus(pid);
  },
  revealStore(pid) { try { Promise.resolve(api.files.reveal(pid, '.flowstate')).catch(() => {}); } catch { /* ignore */ } },
  /** Double confirm, then remove <project>/.flowstate. Resolves true when it was deleted. */
  async deleteProjectData(pid) {
    const p = store.get().projects.find((x) => x.id === pid);
    if (!p) return false;
    const first = await confirmDialog({ title: t('pdata.deleteTitle'), message: t('pdata.deleteConfirm1', { project: p.name }), confirmLabel: t('common.continue'), danger: true });
    if (!first) return false;
    const second = await confirmDialog({ title: t('pdata.deleteTitle'), message: t('pdata.deleteConfirm2', { project: p.name }), confirmLabel: t('pdata.deleteAll'), danger: true });
    if (!second) return false;
    try { await api.store.clear(pid, 'all'); } catch { toast(t('errors.generic'), 'error'); return false; }
    store.updateChat(pid, () => createChatState());
    await actions.refreshStoreStatus(pid);
    toast(t('pdata.deleted'), 'success');
    return true;
  },
  openProjectData(id) { openProjectDataDialog({ store, api, actions, projectId: id }); },
  openProjectSettings(id) { openProjectSettingsDialog({ store, actions, projectId: id }); },
  openAbout() { openAboutDialog({ store, api }); },
  openShortcuts() { openShortcutsDialog({ store, api }); },
  /** File > Open folder: import an existing .flowstate or register a fresh folder. */
  async openFolder() {
    let r;
    try { r = await api.store.openFolder(); } catch { toast(t('menu.openFailed'), 'error'); return; }
    if (!r || !r.project) return;
    const proj = r.project;
    store.set((s) => ({ projects: [...s.projects.filter((x) => x.id !== proj.id), proj] }));
    histLoaded.delete(proj.id);
    store.set((s) => { const chats = { ...s.chats }; delete chats[proj.id]; return { chats }; });
    await actions.selectProject(proj.id);
    const c = store.get().chats[proj.id];
    const n = c ? c.messages.filter((m) => m.role === 'user' || m.role === 'assistant').length : 0;
    const loaded = r.loaded && (r.loaded.projectJson || r.loaded.state || r.loaded.history);
    toast(!r.created && loaded ? t('menu.loadedFolder', { n }) : t('menu.projectAdded'), 'success');
  },
  /** Developer mode toggle (title-bar pill, View menu): flips the project's own override when it has one, else the global setting. */
  async toggleDeveloper() {
    const s = store.get();
    const p = activeProject(s);
    if (p && typeof p.developerMode === 'boolean') await actions.updateProject(p.id, { developerMode: !isDev(s) });
    else await actions.updateSettings({ developerMode: !isDev(s) });
  },
  draftChanged(pid, text) { persist.setDraft(pid, text); },
  chatScrolled(pid, top) { persist.setScroll(pid, top); },
  async walkthroughClosed() {
    if (!store.get().settings.walkthroughDone) await actions.updateSettings({ walkthroughDone: true });
  },
};

Object.assign(actions, createMethodActions({ store, api, actions }));

const menuActions = createMenuActions({ store, api, actions, ui, notify: (m, k, ms) => toast(m, k, ms) });
actions.menuDispatch = async (item) => {
  const ok = await dispatchMenu(item, { api, menuActions });
  if (ok && item.id === 'file.saveState') toast(t('menu.saved'), 'success');
  return ok;
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
  app.classList.toggle('is-wide-view', s.view === 'methodologies');
}

function buildShell() {
  const root = document.getElementById('root');
  root.replaceChildren();
  const titlebar = h('header', { class: 'titlebar' });
  const bannerSlot = h('div', { class: 'banner-slot' });
  const rail = h('nav', { class: 'rail' });
  const sidebar = h('aside', { class: 'sidebar' });
  const main = h('main', { class: 'main' });
  const splitter = h('div', { class: 'splitter', attrs: { role: 'separator', 'aria-orientation': 'vertical', tabindex: '0', 'aria-valuenow': '420' } });
  const artifacts = h('aside', { class: 'artifacts' });
  const app = h('div', { class: 'app' }, rail, sidebar, main, splitter, artifacts);
  root.append(titlebar, bannerSlot, app);
  const deps = { store, api, actions, thumbs, menuDispatch: (item) => actions.menuDispatch(item) };
  ui.rail = mountRail(rail, deps);
  ui.sidebar = mountSidebar(sidebar, deps);
  ui.main = mountMain(main, deps);
  ui.banners = mountBanners(bannerSlot, deps);
  ui.titlebar = mountTitlebar(titlebar, deps);
  ui.titlebar.syncTheme();
  ui.artifacts = mountArtifacts({ aside: artifacts, splitter, app, store, api, actions });
  store.subscribe((s, prev) => {
    if (s.sidebarCollapsed !== prev.sidebarCollapsed || s.artifactsCollapsed !== prev.artifactsCollapsed || s.view !== prev.view) syncLayout(app);
  });
  syncLayout(app);
  nav(rail);
}

function nav(rail) { rail.setAttribute('aria-label', t('nav.workspace')); }

async function boot() {
  document.documentElement.classList.add('platform-' + normalizePlatform(api.platform));
  let settings = await api.settings.get();
  const lang = settings.language || detectLanguage(navigator.language);
  await setLanguage(lang);
  settings = { ...settings, language: lang };
  applyAppearance(settings);
  const gui = await persist.readGlobal(); // UI state is read BEFORE the first render of the chat
  const gplan = persist.plan(gui, null);
  store.set({
    settings,
    sidebarCollapsed: gplan.sidebarCollapsed ?? false,
    artifactsCollapsed: gplan.artifactsCollapsed ?? readStore(COLLAPSED_KEY, '0') === '1',
    artifactsWidth: gplan.artifactsWidth ?? null,
    sidebarWidth: gplan.sidebarWidth ?? null,
  });
  try {
    const info = api.window && (await api.window.info());
    if (info) store.set((s) => ({ win: { ...s.win, ...info, platform: normalizePlatform(info.platform || api.platform) } }));
  } catch { /* keep defaults */ }
  const projects = await api.projects.list();
  const last = projects.find((p) => p.id === settings.lastProjectId) || projects[0] || null;
  const pplan = persist.plan(gui, last ? await persist.readProject(last.id) : null);
  store.set({ projects, activeProjectId: last ? last.id : null, view: gplan.view && (gplan.view !== 'project' || last) ? gplan.view : 'project', ...(pplan.artifactsTab ? { artifactsTab: pplan.artifactsTab } : {}) });
  lastPersisted = last ? last.id : null;
  if (gplan.sidebarWidth) document.documentElement.style.setProperty('--sidebar-w', gplan.sidebarWidth + 'px');

  buildShell();
  if (gplan.artifactsWidth) ui.artifacts.applyWidth(gplan.artifactsWidth);
  if (last) { const hist = openProject(last.id, { initial: true }); applyProjectPlan(last.id, pplan, hist); }
  persist.watch();
  actions.loadTemplates();
  actions.loadMethods({ quiet: true });
  for (const p of projects) actions.refreshRun(p.id);

  api.health.check().then((health) => setHealthState(health)).catch(() => {});
  api.onHealth((health) => setHealthState(health));
  actions.refreshLoginStatus();
  if (api.onLogin) api.onLogin((ev) => store.set((s) => ({ signedIn: applyLoginEvent(s.signedIn, ev) })));
  if (api.onWindow) api.onWindow((w) => store.set((s) => ({ win: { ...s.win, ...w } })));
  api.onAgentEvent(({ projectId, event }) => {
    if (histBuffer.has(projectId)) { histBuffer.get(projectId).push(event); return; }
    store.updateChat(projectId, (c) => reduceEvent(c, event, { now: Date.now() }));
    if (event && event.type === 'result') refreshGit(projectId);
  });

  actions.refreshUsage();
  if (api.onUsage) api.onUsage((u) => store.set({ usage: u }));
  actions.refreshTasks();
  if (api.onTasks) api.onTasks((snap) => store.set({ tasks: snap }));
  if (settings.deepseekEnabled) actions.refreshDeepseek(false);
  if (api.onMenu) api.onMenu(({ id }) => { menuActions.run(id); });
  if (api.onBeforeQuit) api.onBeforeQuit(async () => { try { await persist.flush(); } finally { try { if (api.app && api.app.flushed) await api.app.flushed(); } catch { /* quitting */ } } });
  if (api.onMethod) api.onMethod(({ projectId, state }) => { if (state) actions.setRun(projectId, state); });
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
    ui.titlebar.update();
    ui.artifacts.update();
    nav(document.querySelector('.rail'));
    if (store.get().settings.language !== l) store.set({ settings: { ...store.get().settings, language: l } });
  });
  document.title = t('app.name');

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      ui.titlebar.focusSearch();
    }
  });
  // In a plain browser (mock) there is no native menu to own the accelerators: handle the renderer ones here.
  if (isMockApi()) {
    const accels = flattenMenu().filter((i) => i.accelerator && i.handler === 'renderer' && i.id !== 'edit.find');
    document.addEventListener('keydown', (e) => {
      if (e.defaultPrevented) return;
      const hit = accels.find((i) => acceleratorMatches(e, i.accelerator, store.get().win.platform));
      if (hit) { e.preventDefault(); menuActions.run(hit.id); }
    });
  }

  if (!settings.walkthroughDone) actions.openSetup();
  if (isMockApi()) window.__flowstate = { store, actions, persist, menuActions };
  // First render is done: main hides the splash and shows the window (no-op in the mock / a plain browser).
  try { if (api.app && api.app.ready) await api.app.ready(); } catch { /* the window shows itself anyway */ }
}

boot().catch((e) => {
  console.error(e);
  const root = document.getElementById('root');
  if (root) root.replaceChildren(h('div', { class: 'empty-state' }, h('div', { class: 'empty-state__title', text: 'FlowState' }), h('div', { class: 'empty-state__text', text: String((e && e.message) || e) })));
});
