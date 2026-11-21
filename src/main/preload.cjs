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
  evAgent: 'ev:agent', evHealth: 'ev:health',
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
  onAgentEvent: subscribe(CH.evAgent),
  onHealth: subscribe(CH.evHealth),
});
