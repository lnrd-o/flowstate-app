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
  // ---- Phase 3: methodologies (model + validator in src/shared/methodology.js) ----
  methodList: 'method:list',                 // () -> MethodSummary[]  {id, source, name, description, tags, nodeCount, varCount, updatedAt}   (bundled methodologies/*.json + userData/methodologies/*.json; user overrides bundled by id)
  methodGet: 'method:get',                   // (id) -> Methodology
  methodSave: 'method:save',                 // (Methodology) -> Methodology   (validateMethodology must pass; saved as source:'user'; updates updatedAt)
  methodDelete: 'method:delete',             // (id) -> void   (user methodologies only)
  methodRecord: 'method:record',             // (projectId, {name?, fromTs?, toTs?}) -> Methodology draft (NOT saved; source:'recorded'; built from chat history, see recorder rules)
  methodImport: 'method:import',             // () -> Methodology|null   (native open dialog for a .json file; validated; returned as a draft, not saved)
  methodExport: 'method:export',             // (id) -> {path}|null   (native save dialog)
  methodRun: 'method:run',                   // (projectId, methodologyId, vars) -> {runId}   (one active run per project; vars validated against declared vars)
  methodRespond: 'method:respond',           // (runId, nodeId, response) -> void   response: {approve:boolean} for checkpoint/command confirmation, {answer:string} for ask-user
  methodStop: 'method:stop',                 // (runId) -> void
  methodRunState: 'method:run-state',        // (projectId) -> RunState|null   (active or last run)
  // ---- Phase 4: in-app sign-in, custom title bar ----
  // Sign-in. claude: `claude auth login [--claudeai|--console|--sso] [--email e]` over PIPES (prints the URL + 'Paste code here' prompt);
  // agy: no login subcommand - signing in = launching `agy` with NO args (interactive TUI: 'Log in with Google' / 'Gemini Enterprise'),
  // so it runs in a PTY (@lydell/node-pty) and the renderer shows it in xterm.js.
  loginStart: 'login:start',                 // (agent:'claude'|'agy', opts?:{kind?:'claudeai'|'console'|'sso', email?:string, cols?:number, rows?:number}) -> {ok, mode:'pipe'|'pty'}   one session per agent; a second start cancels the first
  loginInput: 'login:input',                 // (agent, data:string) -> void   claude: a pasted code (backend appends the newline); agy: raw keystrokes for the PTY
  loginResize: 'login:resize',               // (agent, cols, rows) -> void   (pty only)
  loginCancel: 'login:cancel',               // (agent) -> void   kills the process tree
  loginStatus: 'login:status',               // () -> LoginStatus   fresh check (claude: `claude auth status` JSON; agy: `agy models` output not asking to sign in)
  loginLogout: 'login:logout',               // (agent) -> {ok, error?}   claude: `claude auth logout`; agy: {ok:false, error:'use-terminal'} (use /logout inside the agy terminal)
  // Custom title bar / window
  windowInfo: 'window:info',                 // () -> {platform:'win32'|'darwin'|'linux', maximized:boolean, overlay:boolean, controlsInset:{left:number,right:number}, fullscreen:boolean}
  windowSetTheme: 'window:set-theme',        // ({color:string '#rrggbb', symbolColor:string '#rrggbb', height:number}) -> void   recolours the native window-controls overlay (win/linux) live when the theme changes
  windowAction: 'window:action',             // ('minimize'|'toggle-maximize'|'close') -> void
  // push channels (main -> renderer)
  evLogin: 'ev:login',                       // {agent, kind:'url'|'prompt'|'data'|'status'|'done'|'error', url?, text?, data?, loggedIn?, ok?}   see LoginEvent
  evWindow: 'ev:window',                     // {maximized:boolean, fullscreen:boolean}
  evMethod: 'ev:method',                     // {projectId, state: RunState}   on every node transition
  evAgent: 'ev:agent',                       // {projectId, event}
  evHealth: 'ev:health',                     // Health   (pushed on change; VPN polling every 10 s)
  evFiles: 'ev:files',                       // {projectId, changed: string[]}   debounced 300 ms, rel paths
  evDashboard: 'ev:dashboard',               // {projectId, kind:'log'|'status'|'done'|'error', text?, status?}
  evInstall: 'ev:install',                   // {id, kind:'log'|'done'|'error', text?}
  evRemote: 'ev:remote',                     // {projectId, running, info?}
});

// Phase 4 types (JSDoc):
//   LoginStatus = { claude:{ loggedIn:boolean, authMethod?:string, email?:string }, agy:{ loggedIn:boolean } }   Health.agy also gains `loggedIn:boolean|null` (null = unknown / agy missing)
//   LoginEvent  = { agent, kind:'url', url }                    first https URL seen in the output (claude: from stdout; agy: from the ANSI-stripped PTY text). `url` is only ever
//                                                               emitted to the renderer; opening it in the browser is done by the renderer through window.open / main's allow-list
//                                                               (security.js) - hosts: claude.com, claude.ai, anthropic.com, platform.claude.com, console.anthropic.com, accounts.google.com, *.google.com, *.googleapis.com
//               | { agent, kind:'prompt', text }                claude only: the CLI is asking for a pasted code (stdout line containing 'Paste code')
//               | { agent, kind:'data', data }                  agy only: raw PTY output chunk (feed to xterm.write)
//               | { agent, kind:'status', loggedIn }            emitted when a periodic check (every 2 s while a session is open) flips the state
//               | { agent, kind:'done', ok, loggedIn }          process exited or sign-in detected; the session is closed (agy PTY is killed 1 s after loggedIn turns true)
//               | { agent, kind:'error', text }
//   Platform notes: sign-in never reads or stores credentials; tokens stay in the CLIs' own stores.
//
// Phase 3 types (JSDoc):
//   RunState = { runId, projectId, methodologyId, status:'running'|'waiting'|'done'|'error'|'stopped', vars:object,
//                current: nodeId|null, startedAt, endedAt?, error?: string,
//                nodes: { [nodeId]: { state:'pending'|'running'|'waiting'|'done'|'error'|'skipped'|'warn', message?, startedAt?, endedAt? } },
//                waiting?: { nodeId, kind:'checkpoint'|'ask-user'|'command-confirm', text, command?: {exe,args} } }
//   Recorder rules (method:record): each user history record starts a 'prompt' node (text = the user text; the project's name/path are
//   replaced by {{projectName}}/{{projectPath}}); consecutive turns are chained by edges; for each turn the tools used / files touched are
//   summarised into the node's `note` string (extra field, ignored by the runner); a turn followed by an auto-commit becomes a 'git-commit'
//   node; a final 'checkpoint' node is NOT added. Vars: one declared 'text' var per distinct {{...}} left in text. IDs n1..nN.
//   Runner rules: a single linear walk from the start node (conditions pick yes/no); 'prompt' sends via the project's agent adapter
//   (node.agent/mode override the project's for that turn only) and waits for 'result'; result.ok===false => node error and run stops;
//   'command' ALWAYS waits for a command-confirm response; checkpoint {approve:false} => run 'stopped'; 'artifact' missing => node 'warn' and continue;
//   one active run per project; run state is pushed on every transition and persisted to userData/runs/<projectId>.json (last run only).

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
  method: ['list', 'get', 'save', 'delete', 'record', 'import', 'export', 'run', 'respond', 'stop', 'runState'],
  login: ['start', 'input', 'resize', 'cancel', 'status', 'logout'],
  window: ['info', 'setTheme', 'action'],
  subscriptions: ['onAgentEvent', 'onHealth', 'onFiles', 'onDashboard', 'onInstall', 'onRemote', 'onMethod', 'onLogin', 'onWindow'],
});
