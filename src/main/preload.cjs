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
  versionsList: 'versions:list', versionsSave: 'versions:save', versionsCompare: 'versions:compare', versionsRestore: 'versions:restore', versionsBranch: 'versions:branch',
  promptsList: 'prompts:list', promptsSave: 'prompts:save', promptsDelete: 'prompts:delete', promptsExport: 'prompts:export',
  filesList: 'files:list', filesRead: 'files:read', filesReveal: 'files:reveal', filesOpen: 'files:open', filesWatch: 'files:watch', filesPreview: 'files:preview',
  dashboardStatus: 'dashboard:status', dashboardSetup: 'dashboard:setup', dashboardStart: 'dashboard:start', dashboardStop: 'dashboard:stop',
  prereqInstall: 'prereq:install', authLogin: 'auth:login',
  remoteStatus: 'remote:status', remoteStart: 'remote:start', remoteStop: 'remote:stop',
  historyGet: 'history:get', historyClear: 'history:clear',
  methodList: 'method:list', methodGet: 'method:get', methodSave: 'method:save', methodDelete: 'method:delete', methodRecord: 'method:record',
  methodImport: 'method:import', methodExport: 'method:export', methodRun: 'method:run', methodRespond: 'method:respond', methodStop: 'method:stop',
  methodRunState: 'method:run-state', evMethod: 'ev:method',
  loginStart: 'login:start', loginInput: 'login:input', loginResize: 'login:resize', loginCancel: 'login:cancel',
  loginStatus: 'login:status', loginLogout: 'login:logout',
  windowInfo: 'window:info', windowSetTheme: 'window:set-theme', windowAction: 'window:action',
  modelsList: 'models:list', usageGet: 'usage:get', deepseekSetKey: 'deepseek:set-key', deepseekStatus: 'deepseek:status',
  menuModel: 'menu:model', menuInvoke: 'menu:invoke', tasksList: 'tasks:list', tasksStop: 'tasks:stop',
  storeStatus: 'store:status', storeSave: 'store:save', storeOpenFolder: 'store:open-folder', storeClear: 'store:clear',
  uiGet: 'ui:get', uiSet: 'ui:set', uiProjectGet: 'ui:project-get', uiProjectSet: 'ui:project-set',
  attachmentsSave: 'attachments:save', attachmentsRead: 'attachments:read',
  filesPick: 'files:pick', filesImport: 'files:import', projectsDefaultDir: 'projects:default-dir', projectsNewDir: 'projects:new-dir',
  appInfo: 'app:info', appReady: 'app:ready', appFlushed: 'app:flushed',
  evUsage: 'ev:usage', evTasks: 'ev:tasks', evMenu: 'ev:menu', evBeforeQuit: 'ev:before-quit',
  evLogin: 'ev:login', evWindow: 'ev:window',
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
    remove: call(CH.projectsRemove), pickFolder: call(CH.projectsPickFolder), defaultDir: call(CH.projectsDefaultDir), newDir: call(CH.projectsNewDir),
  },
  agent: { send: call(CH.agentSend), stop: call(CH.agentStop), status: call(CH.agentStatus) },
  health: { check: call(CH.healthCheck) },
  git: { status: call(CH.gitStatus), undoTurn: call(CH.gitUndoTurn) },
  versions: { list: call(CH.versionsList), save: call(CH.versionsSave), compare: call(CH.versionsCompare), restore: call(CH.versionsRestore), branch: call(CH.versionsBranch) },
  prompts: { list: call(CH.promptsList), save: call(CH.promptsSave), delete: call(CH.promptsDelete), export: call(CH.promptsExport) },
  files: { list: call(CH.filesList), read: call(CH.filesRead), preview: call(CH.filesPreview), reveal: call(CH.filesReveal), open: call(CH.filesOpen), watch: call(CH.filesWatch), pick: call(CH.filesPick), import: call(CH.filesImport) },
  dashboard: { status: call(CH.dashboardStatus), setup: call(CH.dashboardSetup), start: call(CH.dashboardStart), stop: call(CH.dashboardStop) },
  prereq: { install: call(CH.prereqInstall) },
  auth: { login: call(CH.authLogin) },
  remote: { status: call(CH.remoteStatus), start: call(CH.remoteStart), stop: call(CH.remoteStop) },
  history: { get: call(CH.historyGet), clear: call(CH.historyClear) },
  method: {
    list: call(CH.methodList), get: call(CH.methodGet), save: call(CH.methodSave), delete: call(CH.methodDelete), record: call(CH.methodRecord),
    import: call(CH.methodImport), export: call(CH.methodExport), run: call(CH.methodRun), respond: call(CH.methodRespond),
    stop: call(CH.methodStop), runState: call(CH.methodRunState),
  },
  login: {
    start: call(CH.loginStart), input: call(CH.loginInput), resize: call(CH.loginResize),
    cancel: call(CH.loginCancel), status: call(CH.loginStatus), logout: call(CH.loginLogout),
  },
  window: { info: call(CH.windowInfo), setTheme: call(CH.windowSetTheme), action: call(CH.windowAction) },
  models: { list: call(CH.modelsList) },
  usage: { get: call(CH.usageGet) },
  deepseek: { setKey: call(CH.deepseekSetKey), status: call(CH.deepseekStatus) },
  menu: { model: call(CH.menuModel), invoke: call(CH.menuInvoke) },
  tasks: { list: call(CH.tasksList), stop: call(CH.tasksStop) },
  store: { status: call(CH.storeStatus), save: call(CH.storeSave), openFolder: call(CH.storeOpenFolder), clear: call(CH.storeClear) },
  ui: { get: call(CH.uiGet), set: call(CH.uiSet), projectGet: call(CH.uiProjectGet), projectSet: call(CH.uiProjectSet) },
  attachments: { save: call(CH.attachmentsSave), read: call(CH.attachmentsRead) },
  app: { info: call(CH.appInfo), ready: call(CH.appReady), flushed: call(CH.appFlushed) },
  platform: process.platform,
  onUsage: subscribe(CH.evUsage),
  onTasks: subscribe(CH.evTasks),
  onMenu: subscribe(CH.evMenu),
  onBeforeQuit: subscribe(CH.evBeforeQuit),
  onLogin: subscribe(CH.evLogin),
  onWindow: subscribe(CH.evWindow),
  onAgentEvent: subscribe(CH.evAgent),
  onHealth: subscribe(CH.evHealth),
  onFiles: subscribe(CH.evFiles),
  onDashboard: subscribe(CH.evDashboard),
  onInstall: subscribe(CH.evInstall),
  onRemote: subscribe(CH.evRemote),
  onMethod: subscribe(CH.evMethod),
});
