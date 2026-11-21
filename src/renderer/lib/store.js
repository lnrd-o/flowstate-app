// Tiny observable store. State is replaced immutably; listeners get (state, prev).
import { createChatState } from './events.js';

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
      lastProjectId: null, autoLaunch: false, walkthroughDone: true,
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
    sidebarCollapsed: false,
    artifactsCollapsed: false,
  };
}

export function activeProject(state) {
  return state.projects.find((p) => p.id === state.activeProjectId) || null;
}

export function activeChat(state) {
  return state.chats[state.activeProjectId] || null;
}

export function filterProjects(projects, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return projects;
  return projects.filter((p) => (p.name || '').toLowerCase().includes(q) || (p.path || '').toLowerCase().includes(q));
}
