// ProjectStore: write-through of project settings + session state into <project>/.flowstate/ (see docs/project-store.md).
//   project.json  shareable settings   state.json  sessions / counters / ui / lastRun   history.jsonl (written by history.js)
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../settings.js';
import { isModel, isEffort } from '../agents/model-spec.js';
import { STORE_DIR, ensureStoreDir, readJsonSafe, fileSize, dirBytes, storeDirOf } from './store-fs.js';

const AGENTS = ['claude', 'agy'];
const MODES = ['default', 'acceptEdits', 'plan'];
const ci = process.platform === 'win32' || process.platform === 'darwin';
const samePath = (a, b) => (ci ? a.toLowerCase() === b.toLowerCase() : a === b);

export const defaultState = () => ({
  version: 1, sessions: { claude: null, agy: null }, lastOpened: null, lastTurn: null,
  counters: { turns: 0, filesChanged: 0 }, ui: {}, lastRun: null,
});

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' && v ? v : null);
const num = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);

/** Coerce whatever was read from state.json into the documented shape. */
export function normalizeState(raw) {
  const s = defaultState();
  if (!isObj(raw)) return s;
  if (isObj(raw.sessions)) for (const a of AGENTS) s.sessions[a] = str(raw.sessions[a]);
  s.lastOpened = str(raw.lastOpened);
  if (isObj(raw.lastTurn)) s.lastTurn = { ts: num(raw.lastTurn.ts), ok: !!raw.lastTurn.ok, agent: AGENTS.includes(raw.lastTurn.agent) ? raw.lastTurn.agent : null };
  if (isObj(raw.counters)) s.counters = { turns: num(raw.counters.turns), filesChanged: num(raw.counters.filesChanged) };
  if (isObj(raw.ui)) s.ui = raw.ui;
  if (isObj(raw.lastRun)) s.lastRun = raw.lastRun;
  return s;
}

/** Validate project.json -> the subset of fields that may be merged into a project (invalid fields dropped). */
export function parseProjectJson(raw) {
  if (!isObj(raw)) return null;
  const out = {};
  if (typeof raw.name === 'string' && raw.name.trim()) out.name = raw.name.trim().slice(0, 200);
  if (AGENTS.includes(raw.agent)) out.agent = raw.agent;
  if (MODES.includes(raw.mode)) out.mode = raw.mode;
  if (raw.model !== undefined && isModel(raw.model)) out.model = raw.model;
  if (raw.effort !== undefined && isEffort(raw.effort)) out.effort = raw.effort;
  if (typeof raw.autoCommit === 'boolean') out.autoCommit = raw.autoCommit;
  if (raw.developerMode === null || typeof raw.developerMode === 'boolean') out.developerMode = raw.developerMode;
  return out;
}

export function buildProjectJson(project, createdAt, now = new Date().toISOString()) {
  return {
    version: 1, name: project.name, agent: project.agent, mode: project.mode, model: project.model ?? null, effort: project.effort ?? null,
    autoCommit: !!project.autoCommit, developerMode: typeof project.developerMode === 'boolean' ? project.developerMode : null,
    createdAt: createdAt || now, updatedAt: now,
  };
}

export function createStore({
  projects, history, runner = null, git = null, dialog = null, getWindow = () => null, fsx = fs,
  now = () => Date.now(), debounceMs = 500, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout,
} = {}) {
  const recs = new Map(); // projectId -> {state, timer, dirty:Set, lastSavedAt, createdAt, lastSid, lastAgent}
  let lastLoaded = null; // {path, projectJson, state, history, stateData} from the most recent loader() call

  const projectOf = (id) => {
    const p = projects.get(id);
    if (!p) throw new Error('Unknown project');
    return p;
  };
  const dirOf = (p) => storeDirOf(p.path);

  function rec(id, preset) {
    let r = recs.get(id);
    if (r) return r;
    const p = projects.get(id);
    let state = preset ?? null;
    let createdAt = null;
    if (p && !state) {
      state = normalizeState(readJsonSafe(path.join(dirOf(p), 'state.json'), { fsx }).data);
    }
    if (p) createdAt = readJsonSafe(path.join(dirOf(p), 'project.json'), { fsx, now }).data?.createdAt ?? null;
    r = { state: state ?? defaultState(), timer: null, dirty: new Set(), lastSavedAt: null, createdAt, lastSid: p?.sessionId ?? null, lastAgent: p?.agent ?? null };
    recs.set(id, r);
    return r;
  }

  function syncSessions(r, p) {
    // sessionId belongs to the project's CURRENT agent; an agent switch alone must not copy the old session to the new agent.
    if (p.sessionId !== r.lastSid) { r.state.sessions[p.agent] = p.sessionId ?? null; r.lastSid = p.sessionId ?? null; }
    r.lastAgent = p.agent;
    r.state.lastOpened = p.lastOpened ?? r.state.lastOpened;
  }

  function writeNow(id) {
    const r = recs.get(id);
    const p = projects.get(id);
    if (!r || !p) return [];
    if (!fsx.existsSync(p.path)) { r.dirty.clear(); return []; } // never resurrect a deleted project folder
    if (r.timer) { clearTimeoutFn(r.timer); r.timer = null; }
    const what = new Set(r.dirty);
    r.dirty.clear();
    const written = [];
    try {
      const dir = ensureStoreDir(p.path, fsx);
      if (what.has('project')) {
        const t = new Date(now()).toISOString();
        r.createdAt = r.createdAt || t;
        writeJsonAtomic(path.join(dir, 'project.json'), buildProjectJson(p, r.createdAt, t), fsx);
        written.push('project.json');
      }
      if (what.has('state')) {
        syncSessions(r, p);
        let lastRun = null;
        try { lastRun = runner?.state?.(id) ?? null; } catch { lastRun = null; }
        if (lastRun) r.state.lastRun = lastRun;
        writeJsonAtomic(path.join(dir, 'state.json'), { ...r.state, version: 1 }, fsx);
        written.push('state.json');
      }
      if (written.length) r.lastSavedAt = now();
    } catch { /* read-only / vanished folder: the store is best effort; the registry in userData still has the project */ }
    return written;
  }

  function schedule(id, ...what) {
    const r = rec(id);
    for (const w of what) r.dirty.add(w);
    if (r.timer) return;
    r.timer = setTimeoutFn(() => { r.timer = null; writeNow(id); }, debounceMs);
    r.timer?.unref?.();
  }

  // --- registry hook -------------------------------------------------------------------------------------------------------
  projects.onChange?.((kind, p) => {
    if (kind === 'remove') {
      const r = recs.get(p.id);
      if (r?.timer) clearTimeoutFn(r.timer);
      recs.delete(p.id);
      return;
    }
    if (kind === 'add') {
      const preset = lastLoaded && samePath(lastLoaded.path, p.path) ? lastLoaded.stateData : null;
      const r = rec(p.id, preset ?? undefined);
      r.lastSid = p.sessionId ?? null;
      if (preset?.sessions?.[p.agent] == null && p.sessionId) r.state.sessions[p.agent] = p.sessionId;
    }
    schedule(p.id, 'project', 'state');
  });

  /** projects.add loader: a folder that already has .flowstate/project.json (and state.json) is merged. */
  projects.setLoader?.((realPath) => {
    const dir = storeDirOf(realPath);
    const pj = readJsonSafe(path.join(dir, 'project.json'), { fsx, now });
    const st = readJsonSafe(path.join(dir, 'state.json'), { fsx, now });
    const project = pj.data ? parseProjectJson(pj.data) : null;
    const stateData = st.data ? normalizeState(st.data) : null;
    const hist = fileSize(path.join(dir, 'history.jsonl'), fsx) > 0;
    lastLoaded = { path: realPath, projectJson: !!project, state: !!stateData, history: hist, stateData };
    if (!project && !stateData) return null;
    return { project, sessions: stateData?.sessions ?? null };
  });

  const sizes = (p) => {
    const dir = dirOf(p);
    return { dir, hist: fileSize(path.join(dir, 'history.jsonl'), fsx), attach: dirBytes(path.join(dir, 'attachments'), fsx) };
  };

  const api = {
    onAgentEvent(projectId, ev, meta) {
      if (!ev || !projects.get(projectId)) return;
      if (ev.type === 'result') {
        const r = rec(projectId);
        r.state.counters.turns += 1;
        r.state.lastTurn = { ts: now(), ok: !!ev.ok, agent: meta?.agent ?? projects.get(projectId).agent };
        schedule(projectId, 'state');
      } else if (ev.type === 'file-change') {
        rec(projectId).state.counters.filesChanged += 1;
        schedule(projectId, 'state');
      }
    },

    getUi: (id) => ({ ...rec(projectOf(id).id).state.ui }),
    setUi(id, patch) {
      const p = projectOf(id);
      const r = rec(p.id);
      r.state.ui = { ...r.state.ui, ...patch };
      for (const k of Object.keys(r.state.ui)) if (r.state.ui[k] === null) delete r.state.ui[k]; // null clears a key
      schedule(p.id, 'state');
    },

    status(id) {
      const p = projectOf(id);
      const { dir, hist, attach } = sizes(p);
      const r = recs.get(id);
      let gi = false;
      try { gi = /(^|\n)state\.json(\r?\n|$)/.test(fsx.readFileSync(path.join(dir, '.gitignore'), 'utf8')); } catch { gi = false; }
      return {
        dir, exists: fsx.existsSync(dir), hasProject: fsx.existsSync(path.join(dir, 'project.json')),
        hasState: fsx.existsSync(path.join(dir, 'state.json')), historyBytes: hist, attachmentsBytes: attach, gitignored: gi,
        lastSavedAt: r?.lastSavedAt ?? null,
      };
    },

    /** Flush everything for the project now. */
    save(id) {
      const p = projectOf(id);
      const r = rec(p.id);
      r.dirty.add('project'); r.dirty.add('state');
      try { history?.flush?.(p.id); } catch { /* best effort */ }
      const files = writeNow(p.id);
      if (fsx.existsSync(path.join(dirOf(p), 'history.jsonl'))) files.push('history.jsonl');
      return { ok: files.length > 0, files };
    },
    /** Quit path: only projects with pending changes (a cleared store is not recreated just by quitting). */
    flushDirty() { for (const id of [...recs.keys()]) if (recs.get(id).dirty.size) writeNow(id); },
    /** onlyExisting: skip projects that have no .flowstate folder yet and nothing pending (quit path). */
    saveAll({ onlyExisting = false } = {}) {
      for (const p of projects.list()) {
        if (onlyExisting && !fsx.existsSync(dirOf(p)) && !recs.get(p.id)?.dirty.size) continue;
        try { api.save(p.id); } catch { /* keep going */ }
      }
    },

    /** Register (or re-open) a folder: imports .flowstate when present. */
    async openPath(folder) {
      const existing = projects.findByPath(folder);
      lastLoaded = null;
      const project = projects.add({ path: folder });
      const fresh = !existing;
      const ll = fresh && lastLoaded && samePath(lastLoaded.path, project.path) ? lastLoaded : null;
      if (project.autoCommit && ll && git) { try { await git.init(project.path); } catch { /* best effort */ } }
      return {
        project, created: fresh && !project.loadedFromFolder,
        loaded: { projectJson: !!ll?.projectJson, state: !!ll?.state, history: !!ll?.history },
      };
    },
    async openFolder() {
      if (!dialog) return null;
      const r = await dialog.showOpenDialog(getWindow() ?? undefined, { properties: ['openDirectory', 'createDirectory'] });
      if (r.canceled || !r.filePaths?.length) return null;
      return api.openPath(r.filePaths[0]);
    },

    clear(id, what) {
      const p = projectOf(id);
      if (what === 'history') { history?.clear?.(p.id); return; }
      if (what !== 'all') throw new TypeError('invalid scope');
      const dir = dirOf(p);
      let st;
      try { st = fsx.lstatSync(dir); } catch { return; } // nothing to remove
      if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${STORE_DIR} is not a plain folder; refusing to delete it`);
      const real = (fsx.realpathSync.native ?? fsx.realpathSync);
      if (!samePath(real(dir), path.join(real(p.path), STORE_DIR))) throw new Error(`${STORE_DIR} resolves outside the project; refusing to delete it`);
      const r = recs.get(p.id);
      if (r?.timer) { clearTimeoutFn(r.timer); r.timer = null; }
      if (r) { r.dirty.clear(); r.state = defaultState(); r.lastSavedAt = null; r.createdAt = null; }
      try { history?.clear?.(p.id); } catch { /* ignore */ }
      fsx.rmSync(dir, { recursive: true, force: true }); // does not follow links inside
    },

    dispose() { api.flushDirty(); },
  };
  return api;
}

export function create(deps) {
  return createStore({
    projects: deps.projects, history: deps.history, runner: deps.runner, git: deps.git,
    dialog: deps.electron?.dialog, getWindow: deps.getWindow,
  });
}
