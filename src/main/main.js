import { app, BrowserWindow, ipcMain, dialog, shell, session } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSettings } from './settings.js';
import { createProjects } from './projects.js';
import { createGit } from './git.js';
import { createHealth, createHealthPoller } from './health.js';
import { createAgentManager } from './agents/manager.js';
import { registerIpc } from './ipc.js';
import { CSP, isAllowedExternal, isInternalUrl } from './security.js';

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
    const agents = createAgentManager({
      projects, git,
      emit: (id, ev) => ipc.pushAgentEvent(id, ev),
      resolveLauncher: async (agent) => {
        const p = agent === 'agy' ? await health.findAgy() : await health.findClaude();
        return p ? { command: p } : null;
      },
    });
    const poller = createHealthPoller({ health, onChange: (h) => ipc.pushHealth(h) });
    ipc = registerIpc({
      ipcMain, dialog, settings, projects, agents, git, health: poller,
      getWindow: () => win, onSettings: applyLogin,
    });

    session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
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

    app.on('before-quit', () => { poller.stop(); agents.stopAll(); });
  });

  app.on('window-all-closed', () => app.quit());
}
