// FlowState IPC contract v0 (frozen for Phase 1). Main implements, preload exposes, renderer consumes.
// The renderer only ever talks to `window.flowstate` (see preload.js). All calls are invoke/handle (async)
// except `on*` subscriptions which are main -> renderer pushes.
//
// Types (JSDoc):
//   Agent    = 'claude' | 'agy'
//   Project  = { id, name, path, agent, mode, sessionId|null, lastOpened: ISO, autoCommit: boolean }
//   Mode     = 'default' | 'acceptEdits' | 'plan' | 'auto'   (claude: auto->bypassPermissions; agy: default/acceptEdits->accept-edits, plan->plan, auto->auto)
//   Settings = { language:'en'|'es', theme:'dark'|'light'|'gold', codeTheme, claudePath|null, agyPath|null,
//                lastProjectId|null, autoLaunch:boolean, walkthroughDone:boolean, developerMode:boolean (default true) }
//   agent.send({projectId, text, allow?}) - allow: optional array (max 5) of {tool, pattern} per-turn permission rules for claude
//                (tools Bash|PowerShell|Edit|MultiEdit|Write|NotebookEdit; pattern REQUIRED, exact: no '*', no parentheses); see src/main/permissions.js
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
  // versions (timeline, named versions, compare, restore, branch handler) - see src/main/versions.js
  versionsList: 'versions:list',             // (projectId, {limit?}) -> {isRepo, current, autoBranch, dirty, commits:[{sha,short,parents,time,subject,files,added,removed,branches,tags,head,auto,merge,agent?,methodology?,prompt?}], branches:[{name,current,ahead,behind,merged,auto,time,subject}], tags:[{name,sha,time,label,note,auto}]}
  versionsSave: 'versions:save',             // (projectId, {label, note?, ref?}) -> {ok, tag} | {ok:false, reason, message}   checkpoints dirty work, then tags HEAD as checkpoint/<slug>
  versionsCompare: 'versions:compare',       // (projectId, {from, to='WORKING', path?}) -> {ok, files:[{path,status,added,removed}], added, removed} | with path {ok, diff}
  versionsRestore: 'versions:restore',       // (projectId, {ref, path?}) -> {ok, safety:tagName} (always checkpoints first; restore safety to undo)
  threadsList: 'threads:list',               // (projectId) -> {active, threads:[{id,title,agent,model,turns,updatedAt,main,contextPath}], projectContextPath}   conversations of a project (svc/threads.js)
  threadsCreate: 'threads:create',           // (projectId, {title?, agent?}) -> {ok, id, ...list} | {ok:false, reason:'running'|'limit'}   creates and switches to it
  threadsSwitch: 'threads:switch',           // (projectId, threadId) -> {ok, ...list} | {ok:false, reason}   mirrors that conversation into the project (agent, model, session) and its history
  threadsRename: 'threads:rename',           // (projectId, threadId, title) -> {ok, ...list}
  threadsRemove: 'threads:remove',           // (projectId, threadId) -> {ok, ...list} | {ok:false, reason:'main'|'running'|'unknown'}
  versionsBranch: 'versions:branch',         // (projectId, {op:'create'|'switch'|'rename'|'delete'|'previewMerge'|'merge', name, from?, to?}) -> {ok,...} | {ok:false, reason, message, conflicts?}
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
  filesPreview: 'files:preview',             // (projectId, rel) -> typed preview {type:'text'|'markdown'|'html'|'json'|'image'|'pdf'|'csv'|'xlsx'|'pptx'|'docx'|'archive'|'generic', size, name, ext, ...payload}; caps + path guards as files:read
  filesWatch: 'files:watch',                 // (projectId) -> void   (switches the single active watcher to this project)
  // dashboards (Python venv per project, Streamlit on 127.0.0.1)
  dashboardStatus: 'dashboard:status',       // (projectId) -> {python:{found,version}, venv:boolean, deps:boolean, running:boolean, url:string|null, app:string|null, apps:string[]}
  dashboardSetup: 'dashboard:setup',         // (projectId, {choice?:'global'|'venv'}) -> {ok, env?, needsChoice?, missing?, suggestVenv?}   Python packages: GLOBAL when they satisfy; installs nothing in pythonEnv 'auto' without a choice; choice is remembered as project.pythonEnv; progress via evDashboard
  dashboardStart: 'dashboard:start',         // (projectId, appRel) -> {url}   `.venv\Scripts\python -m streamlit run <app> --server.address 127.0.0.1 --server.headless true --browser.gatherUsageStats false`
  dashboardStop: 'dashboard:stop',           // (projectId) -> void
  // prerequisites / auth
  prereqInstallOpencode: 'prereq:install-opencode', // () -> {ok, path, bytes} | {ok:false, error, manual?}   downloads the official opencode zip from opencode.ai into ~/.opencode/bin (src/main/opencode-install.js)
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
  // ---- Phase 7: usage, models, DeepSeek, menu, tasks, project store, UI state, images, boot ----
  // Models / effort. claude: static aliases (default, opus, sonnet, haiku, fable) + any model seen in session init; agy: LIVE from `agy models`.
  modelsList: 'models:list',                 // (agent) -> ModelList
  // Usage tracking (claude: rate_limit_event windows + per-turn cost/tokens; agy: per-turn tokens; deepseek: balance). Pushed on change.
  usageGet: 'usage:get',                     // () -> UsageSnapshot
  // DeepSeek (optional, off unless settings.deepseekEnabled). The API key is stored ENCRYPTED (Electron safeStorage) in userData and is
  // never returned to the renderer. Calls go from main: GET https://api.deepseek.com/user/balance and /models (Bearer).
  deepseekSetKey: 'deepseek:set-key',        // (key:string|null) -> {ok, error?}   null removes the key; error 'encryption-unavailable' when safeStorage cannot encrypt (then NOTHING is stored)
  deepseekStatus: 'deepseek:status',         // (force?:boolean) -> DeepseekStatus
  // Application menu (model in src/shared/menu.js)
  menuModel: 'menu:model',                   // () -> {items: MENU (with dynamic 'recent' filled), state:{developerMode, theme, platform, packaged}}
  menuInvoke: 'menu:invoke',                 // (id) -> void   executes a handler:'main' action (renderer-handled ids are ignored with {ok:false})
  // Tasks / agent manager
  tasksList: 'tasks:list',                   // () -> TasksSnapshot
  tasksStop: 'tasks:stop',                   // ({kind, id}) -> {ok, error?}   stop an agent turn / dashboard / remote session / methodology run / watcher
  // Project folder store (<project>/.flowstate/, see ProjectStore below)
  storeStatus: 'store:status',               // (projectId) -> StoreStatus
  storeSave: 'store:save',                   // (projectId) -> {ok, files:string[]}   flush everything now
  storeOpenFolder: 'store:open-folder',      // () -> {project, created:boolean, loaded:{projectJson:boolean,state:boolean,history:boolean}}|null   pick a folder; if it has .flowstate it is imported (settings, sessions, history), else registered fresh
  storeClear: 'store:clear',                 // (projectId, what:'history'|'all') -> void   'all' removes <project>/.flowstate (the registry entry stays)
  // UI state persistence (global in userData; per project inside <project>/.flowstate/state.json -> ui)
  uiGet: 'ui:get',                           // () -> object
  uiSet: 'ui:set',                           // (patch:object) -> void   shallow merge, <= 16 KB
  uiProjectGet: 'ui:project-get',            // (projectId) -> object
  uiProjectSet: 'ui:project-set',            // (projectId, patch:object) -> void   shallow merge, <= 16 KB (composer drafts, open file, tab ...)
  // Images / attachments (stored in <project>/.flowstate/attachments/)
  attachmentsSave: 'attachments:save',       // (projectId, {name, mime, dataBase64}) -> Attachment
  attachmentsRead: 'attachments:read',       // (projectId, rel) -> {dataUrl}   thumbnail/preview, only inside attachments/
  // Office cases: bring the user's own files into a project, and a sensible default place for new projects
  filesPick: 'files:pick',                   // ({kind?:'office'|'data'|'any', multi?:boolean}) -> string[]   native open dialog (absolute paths, [] when cancelled); 'office' = xlsx xls csv txt json md docx pdf html
  filesImport: 'files:import',               // (projectId, sourcePath) -> {rel, name, size}   COPIES the file into <project>/data/ (never moves/changes the original; name de-duplicated; <= 200 MB; regular files only; extension allow-list)
  projectsNewDir: 'projects:new-dir',        // (title:string) -> {path, folder}   CREATES a fresh folder for a new project inside the default projects folder: folder name from folderNameFromTitle(title, language) (src/shared/folder-name.js), de-duplicated with _2, _3 ...; the user only types the project NAME
  projectsDefaultDir: 'projects:default-dir',// () -> string   <Documents>/Projects (en) or <Documentos>/Proyectos (es) per current UI language (created if missing): where new projects go by default
  // Boot / lifecycle / about
  appInfo: 'app:info',                       // () -> {name, version, electron, chrome, node, platform, arch, userData, packaged}
  appReady: 'app:ready',                     // () -> void   renderer calls after first render: main hides the splash and shows the window
  appFlushed: 'app:flushed',                 // () -> void   renderer calls after it saved UI state in response to ev:before-quit
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
  workflowCompareSheet: 'workflow:compare-sheet', // (projectId, rel) -> {ok, path, from, to, sheets:[{name,status,changes:[{cell,r,c,before,after,kind}],beforeRows,afterRows,truncated}], created, deleted} | {ok:false, reason}
  workflowExportPdf: 'workflow:export-pdf',     // (projectId, {html, title}) -> {ok, rel}   prints sanitized HTML to <outputs>/<title>_<stamp>.pdf
  scheduleList: 'schedule:list',               // () -> ScheduledTask[]   (svc/schedule.js)
  scheduleSave: 'schedule:save',               // (task) -> ScheduledTask   create or update (id)
  scheduleRemove: 'schedule:remove',           // (id) -> {ok}
  scheduleRunNow: 'schedule:run-now',          // (id) -> {ok, error?}
  updateStatus: 'update:status',               // () -> {status:'idle'|'checking'|'current'|'downloading'|'ready'|'error', version, percent?, error, supported}
  updateCheck: 'update:check',                 // () -> same
  updateInstall: 'update:install',             // () -> boolean   quit and install a downloaded update
  evWorkflow: 'ev:workflow',                   // {kind:'open-project', projectId} | {kind:'quick-ask'}
  evSchedule: 'ev:schedule',                   // {tasks}
  evUpdate: 'ev:update',                       // update status (see updateStatus)
  evUsage: 'ev:usage',                       // UsageSnapshot (throttled to 1 per second)
  evTasks: 'ev:tasks',                       // TasksSnapshot (throttled to 2 per second)
  evMenu: 'ev:menu',                         // {id}   a handler:'renderer' menu action triggered from the NATIVE menu / accelerator
  evBeforeQuit: 'ev:before-quit',            // {}   renderer must persist UI state, then call app:flushed (main waits max 2 s)
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

// Phase 7 types (JSDoc):
//   Project (extended) = { ..., model: string|null, effort: null|'low'|'medium'|'high'|'xhigh'|'max' }   patchable via projects.update; adapters pass --model / --effort when set
//   ModelList  = { agent, source:'live'|'static', models:[{id, name, description?, current?:boolean}], efforts:['low','medium','high','xhigh','max'], defaultModel?:string, error?:string }
//                claude static aliases: default (recommended), opus, sonnet, haiku, fable (+ the exact model id seen in the last session init, marked current);
//                agy live: `agy models` lines "<id>\t<name>" (needs sign-in; error text otherwise)
//   UsageSnapshot = { at:number,
//     claude: { windows:{ five_hour:Window|null, seven_day:Window|null }, today:{costUsd, inputTokens, outputTokens, turns}, lastLimit:LimitInfo|null, updatedAt:number|null },
//     agy:    { today:{inputTokens, outputTokens, thinkingTokens, turns}, lastLimit:LimitInfo|null, updatedAt:number|null },
//     deepseek: { configured:boolean, balance?:Balance, updatedAt?:number } }
//     Window = { utilization:number 0..1, resetsAt:number ms, status:'allowed'|'allowed_warning'|'rejected' }
//     LimitInfo = { at, kind:'five_hour'|'seven_day'|'quota'|'unknown', status:'warning'|'rejected', resetsAt?:number, utilization?:number, message?:string, projectId?:string }
//     'today' resets at local midnight; persisted to userData/usage.json (daily buckets, 30 days kept). `lastLimit` keeps the CLI/model's own message VERBATIM.
//   DeepseekStatus = { configured:boolean, enabled:boolean, balance?:Balance, models?:[{id, ownedBy?}], error?:string, updatedAt?:number }
//     Balance = { available:boolean, currency:string, total:string, granted:string, toppedUp:string }   (strings as returned by GET /user/balance; first balance_infos entry)
//   TasksSnapshot = { at:number,
//     agents:   [{ projectId, projectName, agent:'claude'|'agy', state:'running'|'committing', startedAt, elapsedMs, pid?:number }],
//     services: [{ kind:'dashboard'|'remote'|'methodology'|'login'|'install'|'watcher'|'daemon', id:string, projectId?:string, label:string, state:'running'|'waiting'|'starting', url?:string, startedAt?:number, stoppable:boolean }],
//     todos:    { [projectId]: [{content, status:'pending'|'in_progress'|'completed'}] },        // latest agent task list per project (claude TodoWrite events)
//     subagents:[{ projectId, id, name, description?, state:'running'|'done'|'error', startedAt }] }  // claude Task / agy invoke_subagent, closed by the matching tool-result
//     tasks:stop kinds: 'agent' (id=projectId), 'dashboard' (projectId), 'remote' (projectId), 'methodology' (runId), 'login' (agent), 'watcher' (projectId)
//   StoreStatus = { dir:string (absolute, informational), exists:boolean, hasProject:boolean, hasState:boolean, historyBytes:number, attachmentsBytes:number, gitignored:boolean, lastSavedAt:number|null }
//   Attachment  = { id, rel:'.flowstate/attachments/<file>', name, mime, size, width?:number, height?:number }   mime image/png|jpeg|gif|webp, <= 8 MB
//   agent.send({projectId, text, allow?, images?}) - images: optional array (max 5) of {rel} previously returned by attachments:save.
//        claude: sent as base64 image content blocks BEFORE the text block in the stream-json user message; agy: the prompt gets one line per image
//        '[Image attached: <absolute path>]' appended (agy reads files itself). History 'user' records gain `images:[rel...]`.
//
//   ProjectStore - on-disk format of <project>/.flowstate/ (auto-loaded when the folder is added/opened; written through on every change, debounced 500 ms, flushed on quit):
//     project.json   {version:1, name, agent, mode, model, effort, autoCommit, developerMode:boolean|null (null = follow the global setting), createdAt, updatedAt}   shareable: commit it
//     state.json     {version:1, sessions:{claude:string|null, agy:string|null}, lastOpened, lastTurn:{ts, ok, agent}|null, counters:{turns, filesChanged}, ui:{...per-project UI state: draft, artifactsTab, openFile, scroll}, lastRun:RunState|null}
//     history.jsonl  one JSON HistoryRecord per line (same as userData history, relocated here; capped like before)
//     attachments/   pasted/dropped images
//     methodologies/ project-local methodology .json files (listed together with user/bundled ones, source 'project')
//     .gitignore     created on first save with: state.json, history.jsonl, attachments/  (so project.json + methodologies/ can be committed, nothing private leaks)
//   Auto-load rule: projects.add / store:open-folder on a folder that has .flowstate/project.json merges project.json (name/agent/mode/model/effort/autoCommit) and state.json
//   sessions + history; the registry in userData stays only as the index of known project folders (id, path). Corrupt files are renamed *.corrupt-<ts> and ignored, never crash.
//
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
  projects: ['list', 'add', 'update', 'remove', 'pickFolder', 'defaultDir', 'newDir'],
  agent: ['send', 'stop', 'status'],
  health: ['check'],
  git: ['status', 'undoTurn'],
  versions: ['list', 'save', 'compare', 'restore', 'branch'],
  workflow: ['compareSheet', 'exportPdf'],
  schedule: ['list', 'save', 'remove', 'runNow'],
  update: ['status', 'check', 'install'],
  threads: ['list', 'create', 'switch', 'rename', 'remove'],
  prompts: ['list', 'save', 'delete', 'export'],
  files: ['list', 'read', 'preview', 'reveal', 'open', 'watch', 'pick', 'import'],
  dashboard: ['status', 'setup', 'start', 'stop'],
  prereq: ['install', 'installOpencode'],
  auth: ['login'],
  remote: ['status', 'start', 'stop'],
  history: ['get', 'clear'],
  method: ['list', 'get', 'save', 'delete', 'record', 'import', 'export', 'run', 'respond', 'stop', 'runState'],
  login: ['start', 'input', 'resize', 'cancel', 'status', 'logout'],
  window: ['info', 'setTheme', 'action'],
  models: ['list'],
  usage: ['get'],
  deepseek: ['setKey', 'status'],
  menu: ['model', 'invoke'],
  tasks: ['list', 'stop'],
  store: ['status', 'save', 'openFolder', 'clear'],
  ui: ['get', 'set', 'projectGet', 'projectSet'],
  attachments: ['save', 'read'],
  app: ['info', 'ready', 'flushed'],
  subscriptions: ['onAgentEvent', 'onHealth', 'onFiles', 'onDashboard', 'onInstall', 'onRemote', 'onMethod', 'onLogin', 'onWindow',
    'onUsage', 'onTasks', 'onMenu', 'onBeforeQuit', 'onWorkflow', 'onSchedule', 'onUpdate'],
});
