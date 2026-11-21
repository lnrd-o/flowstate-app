import { app, BrowserWindow, ipcMain, dialog, shell, session } from 'electron';
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
import { CH } from '../shared/ipc.js';

const here = path.dirname(fileURLToPath(import.meta.url));
let win = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(() => {
    const dir = app.getPath('userData');
    const settings = createSettings({ dir, locale: app.getLocale() });
    const projects = createProjects({ dir });
    const git = createGit();
    const health = createHealth({ getSettings: settings.get });
    const applyLogin = (s) => { try { app.setLoginItemSettings({ openAtLogin: !!s.autoLaunch }); } catch { /* unsupported */ } };
    applyLogin(settings.get());

    let ipc;
    let runner;
    const history = createHistory({ dir });
    const agents = createAgentManager({
      projects, git, history,
      emit: (id, ev) => { history.recordEvent(id, ev); ipc.pushAgentEvent(id, ev); runner?.onAgentEvent(id, ev); },
      resolveLauncher: async (agent) => {
        const p = agent === 'agy' ? await health.findAgy() : await health.findClaude();
        return p ? { command: p } : null;
      },
    });
    const poller = createHealthPoller({ health, onChange: (h) => ipc.pushHealth(h) });
    const getProject = (id) => projects.get(id);
    const push = (ch) => (payload) => ipc.push(ch, payload);
    const prompts = createPrompts({ userDir: dir });
    const files = createFiles({ getProject, shell, push: push(CH.evFiles) });
    const dashboards = createDashboards({ getProject, push: push(CH.evDashboard) });
    const prereq = createPrereq({ push: push(CH.evInstall), recheck: () => poller.poll(true) });
    const auth = createAuth({ health });
    const remote = createRemote({
      getProject, push: push(CH.evRemote),
      findExe: (agent) => (agent === 'agy' ? health.findAgy() : health.findClaude()),
    });
    const methodologies = createMethodologies({ userDir: dir, dialog, getWindow: () => win });
    const recorder = createRecorder({ history, getProject });
    runner = createRunner({
      dir, getProject, getMethodology: methodologies.get, agents, git,
      emit: (projectId, state) => ipc?.push(CH.evMethod, { projectId, state }),
    });
    ipc = registerIpc({
      ipcMain, dialog, settings, projects, agents, git, health: poller,
      prompts, files, dashboards, prereq, auth, remote, history, methodologies, recorder, runner,
      getWindow: () => win, onSettings: applyLogin,
    });

    session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
      if (!shouldApplyCsp(details.url)) { cb({}); return; }
      cb({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [CSP] } });
    });
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));

    win = new BrowserWindow({
      width: 1280, height: 800, minWidth: 1000, minHeight: 650, title: 'FlowState', backgroundColor: '#17171a',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(here, 'preload.cjs'),
        contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false,
      },
    });
    win.setMenuBarVisibility(false);
    const openExternal = (url) => { if (isAllowedExternal(url)) shell.openExternal(url); };
    win.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
    win.webContents.on('will-navigate', (e, url) => {
      if (!isInternalUrl(url)) { e.preventDefault(); openExternal(url); }
    });
    win.on('closed', () => { win = null; });
    win.loadFile(path.join(here, '..', 'renderer', 'index.html'));
    win.webContents.once('did-finish-load', () => poller.start());

    app.on('before-quit', () => {
      poller.stop(); runner.stopAll(); agents.stopAll(); dashboards.stopAll(); remote.stopAll(); files.closeWatcher();
    });
  });

  app.on('window-all-closed', () => app.quit());
}
