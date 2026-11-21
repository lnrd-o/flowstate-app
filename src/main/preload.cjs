'use strict';
// Sandboxed preload must be CommonJS and may only require('electron'); channel names are mirrored from
// src/shared/ipc.js (a unit test asserts they stay in sync).
const { contextBridge, ipcRenderer } = require('electron');

const CH = {
  settingsGet: 'settings:get', settingsSet: 'settings:set',
  projectsList: 'projects:list', projectsAdd: 'projects:add', projectsUpdate: 'projects:update',
  projectsRemove: 'projects:remove', projectsPickFolder: 'projects:pick-folder',
  agentSend: 'agent:send', agentStop: 'agent:stop', agentStatus: 'agent:status',
  healthCheck: 'health:check', gitStatus: 'git:status', gitUndoTurn: 'git:undo-turn',
  promptsList: 'prompts:list', promptsSave: 'prompts:save', promptsDelete: 'prompts:delete', promptsExport: 'prompts:export',
  filesList: 'files:list', filesRead: 'files:read', filesReveal: 'files:reveal', filesOpen: 'files:open', filesWatch: 'files:watch',
  dashboardStatus: 'dashboard:status', dashboardSetup: 'dashboard:setup', dashboardStart: 'dashboard:start', dashboardStop: 'dashboard:stop',
  prereqInstall: 'prereq:install', authLogin: 'auth:login',
  remoteStatus: 'remote:status', remoteStart: 'remote:start', remoteStop: 'remote:stop',
  historyGet: 'history:get', historyClear: 'history:clear',
  evAgent: 'ev:agent', evHealth: 'ev:health', evFiles: 'ev:files', evDashboard: 'ev:dashboard', evInstall: 'ev:install', evRemote: 'ev:remote',
};

const call = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);
const subscribe = (ch) => (cb) => {
  if (typeof cb !== 'function') throw new TypeError('callback required');
  const l = (_e, payload) => cb(payload);
  ipcRenderer.on(ch, l);
  return () => ipcRenderer.removeListener(ch, l);
};

contextBridge.exposeInMainWorld('flowstate', {
  settings: { get: call(CH.settingsGet), set: call(CH.settingsSet) },
  projects: {
    list: call(CH.projectsList), add: call(CH.projectsAdd), update: call(CH.projectsUpdate),
    remove: call(CH.projectsRemove), pickFolder: call(CH.projectsPickFolder),
  },
  agent: { send: call(CH.agentSend), stop: call(CH.agentStop), status: call(CH.agentStatus) },
  health: { check: call(CH.healthCheck) },
  git: { status: call(CH.gitStatus), undoTurn: call(CH.gitUndoTurn) },
  prompts: { list: call(CH.promptsList), save: call(CH.promptsSave), delete: call(CH.promptsDelete), export: call(CH.promptsExport) },
  files: { list: call(CH.filesList), read: call(CH.filesRead), reveal: call(CH.filesReveal), open: call(CH.filesOpen), watch: call(CH.filesWatch) },
  dashboard: { status: call(CH.dashboardStatus), setup: call(CH.dashboardSetup), start: call(CH.dashboardStart), stop: call(CH.dashboardStop) },
  prereq: { install: call(CH.prereqInstall) },
  auth: { login: call(CH.authLogin) },
  remote: { status: call(CH.remoteStatus), start: call(CH.remoteStart), stop: call(CH.remoteStop) },
  history: { get: call(CH.historyGet), clear: call(CH.historyClear) },
  onAgentEvent: subscribe(CH.evAgent),
  onHealth: subscribe(CH.evHealth),
  onFiles: subscribe(CH.evFiles),
  onDashboard: subscribe(CH.evDashboard),
  onInstall: subscribe(CH.evInstall),
  onRemote: subscribe(CH.evRemote),
});
