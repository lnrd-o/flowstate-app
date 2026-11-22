// Tiny observable store. State is replaced immutably; listeners get (state, prev).
import { createChatState } from './events.js';
import { createSignedIn } from './login-state.js';

export function createStore(initial) {
  let state = initial;
  const listeners = new Set();
  const store = {
    get: () => state,
    set(patch) {
      const prev = state;
      state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
      for (const fn of [...listeners]) {
        try { fn(state, prev); } catch (e) { console.error('store listener failed', e); }
      }
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** Update one project's chat state with a pure function (state) => state. */
    updateChat(projectId, fn) {
      const cur = state.chats[projectId] || createChatState();
      const next = fn(cur);
      if (next === cur && state.chats[projectId]) return;
      store.set({ chats: { ...state.chats, [projectId]: next } });
    },
  };
  return store;
}

export function createInitialState() {
  return {
    settings: {
      language: 'en', theme: 'dark', codeTheme: 'vs-dark', claudePath: null, agyPath: null,
      lastProjectId: null, autoLaunch: false, walkthroughDone: true, developerMode: true, deepseekEnabled: false,
    },
    projects: [],
    activeProjectId: null,
    view: 'project', // 'project' | 'prompts' | 'methodologies'
    chats: {},
    health: null,
    git: {},
    search: '',
    artifactsTab: 'preview',
    templates: [],
    selectedTemplate: null,
    dashboard: {}, // projectId -> dashboard.status result
    remote: {}, // projectId -> { running, info, supported, busy }
    methods: [], // method.list summaries
    editing: null, // { draft, isNew, token } while the methodology editor is open
    runs: {}, // projectId -> RunState (active or last run)
    methodCache: {}, // methodologyId -> Methodology (for the run panel graph)
    signedIn: createSignedIn(), // { claude, agy } true|false|null (unknown), merged from health, login.status and login events
    win: { platform: 'win32', overlay: true, controlsInset: { left: 80, right: 140 }, fullscreen: false, maximized: false },
    sidebarCollapsed: false,
    artifactsCollapsed: false,
    artifactsWidth: null,
    sidebarWidth: null,
    usage: null, // UsageSnapshot (usage.get / onUsage)
    models: {}, // agent -> ModelList
    modelsLoading: {}, // agent -> boolean
    deepseek: null, // DeepseekStatus
    tasks: null, // TasksSnapshot (tasks.list / onTasks)
    storeStatus: {}, // projectId -> StoreStatus
    menuModel: null, // menu.model()
    appInfo: null, // app.info()
    openFile: null, // project-relative path shown in the Files tab (persisted per project)
    limitDismissed: {}, // projectId -> limit.at that the user dismissed from the banner
  };
}

export function activeProject(state) {
  return state.projects.find((p) => p.id === state.activeProjectId) || null;
}

/**
 * Effective Developer mode for one project: the project's own override (true/false) wins, null/undefined follows the global setting
 * (which is on unless explicitly turned off). Pure.
 */
export function effectiveDeveloperMode(project, settings) {
  if (project && typeof project.developerMode === 'boolean') return project.developerMode;
  return !settings || settings.developerMode !== false;
}

/** Developer mode (technical detail: code, diffs, commands) for the active project, falling back to the global setting. */
export function isDev(state) {
  if (!state || !state.settings) return true;
  return effectiveDeveloperMode(activeProject(state), state.settings);
}

/** The GLOBAL developer-mode setting only (Settings dialog, walkthrough): ignores any project override. */
export function isGlobalDev(state) {
  return !state || !state.settings || state.settings.developerMode !== false;
}

export function activeChat(state) {
  return state.chats[state.activeProjectId] || null;
}

export function filterProjects(projects, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return projects;
  return projects.filter((p) => (p.name || '').toLowerCase().includes(q) || (p.path || '').toLowerCase().includes(q));
}
