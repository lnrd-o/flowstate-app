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
  // ---- Phase 2 ----
  // prompt templates (see Template below)
  promptsList: 'prompts:list',               // () -> Template[]   (bundled prompts/default/*.md + userData/prompts/*.md + <project>/.claude/commands is NOT listed)
  promptsSave: 'prompts:save',               // (Template) -> Template   (always saved as source:'user' in userData/prompts/<id>.md)
  promptsDelete: 'prompts:delete',           // (id) -> void   (user templates only)
  promptsExport: 'prompts:export',           // (projectId, id) -> {path}   writes <project>/.claude/commands/<id>.md (body only, vars left as $ARGUMENTS hint)
  // project files / artifacts (all paths relative to the project root, traversal-guarded, never leave the project dir)
  filesList: 'files:list',                   // (projectId, relDir='') -> FileEntry[]   (skips .git, node_modules, .venv, __pycache__)
  filesRead: 'files:read',                   // (projectId, rel) -> {kind:'text'|'image'|'html'|'markdown'|'binary', content?, dataUrl?, size, truncated, lang?}
  filesReveal: 'files:reveal',               // (projectId, rel) -> void   (show in Explorer)
  filesOpen: 'files:open',                   // (projectId, rel) -> void   (open with default app, e.g. html in browser; refuse .exe/.bat/.cmd/.ps1/.lnk etc.)
  filesWatch: 'files:watch',                 // (projectId) -> void   (switches the single active watcher to this project)
  // dashboards (Python venv per project, Streamlit on 127.0.0.1)
  dashboardStatus: 'dashboard:status',       // (projectId) -> {python:{found,version}, venv:boolean, deps:boolean, running:boolean, url:string|null, app:string|null, apps:string[]}
  dashboardSetup: 'dashboard:setup',         // (projectId) -> {ok}   creates .venv and pip installs streamlit plotly pandas; progress via evDashboard
  dashboardStart: 'dashboard:start',         // (projectId, appRel) -> {url}   `.venv\Scripts\python -m streamlit run <app> --server.address 127.0.0.1 --server.headless true --browser.gatherUsageStats false`
  dashboardStop: 'dashboard:stop',           // (projectId) -> void
  // prerequisites / auth
  prereqInstall: 'prereq:install',           // (id:'git'|'node'|'python') -> {ok, log}   winget install, per-user/silent; progress via evInstall
  authLogin: 'auth:login',                   // (agent) -> {ok}   opens a visible console window running `<cli> auth login` (claude) / `agy` login flow; never touches credentials
  // remote control
  remoteStatus: 'remote:status',             // (projectId) -> {running, info?, supported}
  remoteStart: 'remote:start',               // (projectId) -> {running, info?}   claude: `claude remote-control --name <project>` managed child in project cwd; agy: `agy remote-control start --session --name <project>` (login-scoped daemon)
  remoteStop: 'remote:stop',                 // (projectId) -> {running}
  // chat history
  historyGet: 'history:get',                 // (projectId) -> HistoryRecord[]   (last 500)
  historyClear: 'history:clear',             // (projectId) -> void
  // push channels (main -> renderer)
  evAgent: 'ev:agent',                       // {projectId, event}
  evHealth: 'ev:health',                     // Health   (pushed on change; VPN polling every 10 s)
  evFiles: 'ev:files',                       // {projectId, changed: string[]}   debounced 300 ms, rel paths
  evDashboard: 'ev:dashboard',               // {projectId, kind:'log'|'status'|'done'|'error', text?, status?}
  evInstall: 'ev:install',                   // {id, kind:'log'|'done'|'error', text?}
  evRemote: 'ev:remote',                     // {projectId, running, info?}
});

// Phase 2 types (JSDoc):
//   Template = { id, source:'default'|'user', name:{en,es}, description:{en,es}, tags:string[], body:string,
//                vars:[{ key, label:{en,es}, type:'text'|'textarea'|'select', default?:string, options?:string[], required?:boolean }] }
//              body uses {{key}} placeholders. On disk: markdown with YAML-ish frontmatter (see prompts/default/*.md).
//   FileEntry = { name, rel, isDir, size, mtimeMs }
//   HistoryRecord = { ts:number, t:'user', text:string } | { ts:number, t:'event', event: Event }   // replayed through the renderer reducer
//   Backend appends a 'user' record on agent.send and an 'event' record for every normalised event (skip 'text-delta'
//   records: store the final 'text'/'result' text instead by coalescing deltas into one 'text' event per turn).

// Methods exposed on window.flowstate by preload (1:1 with CH, plus subscriptions):
//   settings.get/set, projects.list/add/update/remove/pickFolder, agent.send/stop/status,
//   health.check, git.status/undoTurn, onAgentEvent(cb)->unsubscribe, onHealth(cb)->unsubscribe
export const API_SHAPE = Object.freeze({
  settings: ['get', 'set'],
  projects: ['list', 'add', 'update', 'remove', 'pickFolder'],
  agent: ['send', 'stop', 'status'],
  health: ['check'],
  git: ['status', 'undoTurn'],
  prompts: ['list', 'save', 'delete', 'export'],
  files: ['list', 'read', 'reveal', 'open', 'watch'],
  dashboard: ['status', 'setup', 'start', 'stop'],
  prereq: ['install'],
  auth: ['login'],
  remote: ['status', 'start', 'stop'],
  history: ['get', 'clear'],
  subscriptions: ['onAgentEvent', 'onHealth', 'onFiles', 'onDashboard', 'onInstall', 'onRemote'],
});
