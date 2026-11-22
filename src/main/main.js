import { app, BrowserWindow, Menu, ipcMain, dialog, shell, session, safeStorage, screen, net } from 'electron';
import { createServices, fanoutAgentEvent, disposeServices } from './services.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSettings } from './settings.js';
import { createProjects } from './projects.js';
import { createGit } from './git.js';
import { createHealth, createHealthPoller } from './health.js';
import { createAgentManager } from './agents/manager.js';
import { registerIpc } from './ipc.js';
import { CSP, isAllowedExternal, isInternalUrl, shouldApplyCsp } from './security.js';
import { createPrompts } from './prompts.js';
import { createFiles } from './files.js';
import { createDashboards } from './dashboards.js';
import { createPrereq } from './prereq.js';
import { createAuth } from './auth.js';
import { createRemote } from './remote.js';
import { createHistory } from './history.js';
import { createMethodologies } from './methodologies.js';
import { createRecorder } from './recorder.js';
import { createRunner } from './runner.js';
import { createLoginManager } from './login.js';
import { buildWindowOptions, createWindowController } from './window.js';
import { createBoot, createQuitFlow } from './svc/boot.js';
import { killTree } from './agents/base.js';
import { runCommand } from './run.js';
import { CH } from '../shared/ipc.js';

const here = path.dirname(fileURLToPath(import.meta.url));
let win = null;
let winCtl = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(async () => {
    const dir = app.getPath('userData');
    // Auto-detect the language: the user's top PREFERRED system language (Windows display/language list) wins over
    // Chromium's UI locale, which can lag behind (e.g. 'en-US' on a Spanish PC without a matching locale pack).
    const sysLocale = (typeof app.getPreferredSystemLanguages === 'function' ? app.getPreferredSystemLanguages()[0] : null) || app.getLocale();
    const settings = createSettings({ dir, locale: sysLocale });
    const projects = createProjects({ dir });

    // Splash first (before the heavier wiring below), then the main window opens hidden and is shown when the renderer calls app:ready.
    const services = {}; // Phase 7 pluggable services (src/main/svc/*.js), filled by createServices below
    const boot = createBoot({ app, BrowserWindow, screen, dir, here, settings });
    services.boot = boot;
    const lastProject = projects.get(settings.get().lastProjectId);
    boot.start({ projectCount: projects.list().length, lastProjectName: lastProject?.name ?? null });
    boot.step('modules');
    boot.step('settings');
    boot.step('projects');
    if (lastProject) boot.step('resume');

    const git = createGit();
    const health = createHealth({ getSettings: settings.get });
    const applyLogin = (s) => { try { app.setLoginItemSettings({ openAtLogin: !!s.autoLaunch }); } catch { /* unsupported */ } };
    applyLogin(settings.get());

    let ipc;
    let runner;
    const history = createHistory({
      dir,
      storeDirOf: (id) => { const p = projects.get(id); return p ? path.join(p.path, '.flowstate') : null; },
      threadOf: (id) => { const a = projects.get(id)?.activeThread; return a && a !== '00000000' ? a : null; }, // conversations: see svc/threads.js
    });
    const findCli = (agent) => (agent === 'agy' ? health.findAgy() : agent === 'opencode' ? health.findOpencode() : health.findClaude());
    const agents = createAgentManager({
      // DeepSeek route: the key is read from safeStorage here in main and goes ONLY into the child env (see agents/routes.js).
      routeEnv: async (project, route) => (route === 'deepseek' ? services.deepseek?.routeEnv?.(project.model) ?? { error: 'DeepSeek is not available' } : null),
      contextNote: async (project, text) => [await dashboards?.pythonNote(project.id, text), services?.threads?.handoffNote?.(project)].filter(Boolean).join('\n\n') || null,
      projects, git, history,
      emit: (id, ev, meta) => { history.recordEvent(id, ev); ipc.pushAgentEvent(id, ev); runner?.onAgentEvent(id, ev); fanoutAgentEvent(services, id, ev, meta); },
      resolveLauncher: async (agent) => {
        const p = await findCli(agent);
        return p ? { command: p } : null;
      },
    });
    const poller = createHealthPoller({ health, onChange: (h) => ipc.pushHealth(h) });
    const getProject = (id) => projects.get(id);
    const push = (ch) => (payload) => ipc.push(ch, payload);
    const prompts = createPrompts({ userDir: dir });
    const files = createFiles({ getProject, shell, push: push(CH.evFiles) });
    const dashboards = createDashboards({ getProject, push: push(CH.evDashboard), updateProject: (id, patch) => projects.update(id, patch) });
    const prereq = createPrereq({ push: push(CH.evInstall), recheck: () => poller.poll(true) });
    const auth = createAuth({ health });
    const remote = createRemote({
      getProject, push: push(CH.evRemote),
      findExe: (agent) => (findCli(agent)),
    });
    const methodologies = createMethodologies({ userDir: dir, dialog, getWindow: () => win, getProject });
    const recorder = createRecorder({ history, getProject });
    runner = createRunner({
      dir, getProject, getMethodology: methodologies.get, agents, git,
      emit: (projectId, state) => ipc?.push(CH.evMethod, { projectId, state }),
    });
    const login = createLoginManager({
      resolveCli: (agent) => (findCli(agent)),
      run: runCommand, killTree, emit: (evt) => ipc?.push(CH.evLogin, evt),
    });
    const windowCtl = {
      windowInfo: () => winCtl?.windowInfo(), setTheme: (t) => winCtl?.setTheme(t), action: (a) => winCtl?.action(a),
    };
    ipc = registerIpc({
      ipcMain, dialog, settings, projects, agents, git, health: poller,
      prompts, files, dashboards, prereq, auth, remote, history, methodologies, recorder, runner,
      login, windowCtl, getWindow: () => win, onSettings: applyLogin, services,
    });

    session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
      if (!shouldApplyCsp(details.url)) { cb({}); return; }
      cb({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [CSP] } });
    });
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));

    boot.step('services');
    try {
      await createServices({
        app, dir, settings, projects, agents, history, git, health, poller, files, dashboards, remote, runner, login,
        methodologies, prereq, prompts, getProject, getWindow: () => win, services,
        push: (ch, payload) => ipc.push(ch, payload),
        electron: { app, BrowserWindow, Menu, dialog, shell, safeStorage, screen, net, session },
      });
    } catch (e) { console.error('[services] startup failed:', e?.message ?? e); }

    boot.step('tools');
    // first health poll (bounded to 6 s) runs while the hidden window loads; the window is shown after BOTH it and the renderer are ready
    boot.hold(Promise.race([poller.poll().catch(() => {}), new Promise((r) => setTimeout(r, 6000))]));

    // Quit flow: ev:before-quit -> wait for app:flushed (max 2 s) -> save projects -> flush usage -> stop everything -> quit.
    const quitFlow = createQuitFlow({
      pushBeforeQuit: () => {
        const w = win;
        if (!w || w.isDestroyed() || w.webContents.isDestroyed()) return false;
        ipc.push(CH.evBeforeQuit, {});
        return true;
      },
      saveAll: () => services.store?.saveAll?.({ onlyExisting: true }),
      flushUsage: () => services.usage?.flush?.(),
      stopAll: () => {
        poller.stop(); login.cancelAll(); runner.stopAll(); agents.stopAll(); dashboards.stopAll(); remote.stopAll(); files.closeWatcher();
        disposeServices(services);
      },
      quit: () => app.quit(),
    });
    boot.quitFlow = quitFlow;

    let pollerStarted = false;
    const createWindow = () => {
      const w = new BrowserWindow(boot.windowOptions(buildWindowOptions(process.platform, { preload: path.join(here, 'preload.cjs') })));
      win = w;
      boot.attachWindow(w);
      winCtl = createWindowController(w, { platform: process.platform, push: (ch, p) => ipc.push(ch, p) });
      w.setMenuBarVisibility(false);
      w.setAutoHideMenuBar(false); // the HTML menu bar replaces the native one on win/linux: Alt must not reveal it (accelerators keep working)
      const openExternal = (url) => { if (isAllowedExternal(url)) shell.openExternal(url); };
      w.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
      w.webContents.on('will-navigate', (e, url) => {
        if (!isInternalUrl(url)) { e.preventDefault(); openExternal(url); }
      });
      // Closing the window quits on win/linux: give the renderer a chance to persist UI state first (macOS keeps the app running).
      w.on('close', (e) => {
        if (process.platform !== 'darwin' && !quitFlow.done) { e.preventDefault(); quitFlow.run(); }
      });
      w.on('closed', () => { if (win === w) { win = null; winCtl = null; } });
      w.loadFile(path.join(here, '..', 'renderer', 'index.html'));
      w.webContents.once('did-finish-load', () => { if (!pollerStarted) { pollerStarted = true; poller.start(); } });
    };
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0 && !quitFlow.done) createWindow(); });

    app.on('before-quit', (e) => {
      if (quitFlow.done) return;
      e.preventDefault();
      quitFlow.run();
    });
  });

  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
