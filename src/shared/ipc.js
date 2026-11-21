// FlowState IPC contract v0 (frozen for Phase 1). Main implements, preload exposes, renderer consumes.
// The renderer only ever talks to `window.flowstate` (see preload.js). All calls are invoke/handle (async)
// except `on*` subscriptions which are main -> renderer pushes.
//
// Types (JSDoc):
//   Agent    = 'claude' | 'agy'
//   Project  = { id, name, path, agent, mode, sessionId|null, lastOpened: ISO, autoCommit: boolean }
//   Mode     = 'default' | 'acceptEdits' | 'plan'   (agy mapping: default->accept-edits, acceptEdits->accept-edits, plan->plan)
//   Settings = { language:'en'|'es', theme:'dark'|'light'|'gold', codeTheme, claudePath|null, agyPath|null,
//                lastProjectId|null, autoLaunch:boolean, walkthroughDone:boolean }
//   Event    = normalised event from src/shared/events.js, wrapped: { projectId, event }
//   Health   = { claude:{found,path,version,loggedIn}, agy:{found,path,version}, node:{found,version},
//                git:{found,version}, python:{found,version}, vpn:{active:boolean, adapters:string[]},
//                anthropicReachable:boolean }

export const CH = Object.freeze({
  // settings
  settingsGet: 'settings:get',               // () -> Settings
  settingsSet: 'settings:set',               // (patch: Partial<Settings>) -> Settings
  // projects
  projectsList: 'projects:list',             // () -> Project[]
  projectsAdd: 'projects:add',               // ({name?, path, agent?, mode?}) -> Project   (creates folder if missing; git init if autoCommit)
  projectsUpdate: 'projects:update',         // (id, patch) -> Project
  projectsRemove: 'projects:remove',         // (id) -> void   (never deletes files)
  projectsPickFolder: 'projects:pick-folder',// () -> string|null   (native dialog)
  // agent sessions
  agentSend: 'agent:send',                   // ({projectId, text}) -> {turnId}   spawns/continues; resumes project.sessionId
  agentStop: 'agent:stop',                   // (projectId) -> void
  agentStatus: 'agent:status',               // (projectId) -> {running:boolean}
  // health / prereqs
  healthCheck: 'health:check',               // () -> Health
  // git
  gitStatus: 'git:status',                   // (projectId) -> {isRepo, branch, dirty:number}
  gitUndoTurn: 'git:undo-turn',              // (projectId) -> {ok, message}
  // push channels (main -> renderer)
  evAgent: 'ev:agent',                       // {projectId, event}
  evHealth: 'ev:health',                     // Health   (pushed on change; VPN polling every 10 s)
});

// Methods exposed on window.flowstate by preload (1:1 with CH, plus subscriptions):
//   settings.get/set, projects.list/add/update/remove/pickFolder, agent.send/stop/status,
//   health.check, git.status/undoTurn, onAgentEvent(cb)->unsubscribe, onHealth(cb)->unsubscribe
export const API_SHAPE = Object.freeze({
  settings: ['get', 'set'],
  projects: ['list', 'add', 'update', 'remove', 'pickFolder'],
  agent: ['send', 'stop', 'status'],
  health: ['check'],
  git: ['status', 'undoTurn'],
  subscriptions: ['onAgentEvent', 'onHealth'],
});
