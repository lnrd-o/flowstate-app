import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeJsonAtomic, readJson } from './settings.js';
import { validProtections } from '../shared/protections.js';
import { isModel, isEffort } from './agents/model-spec.js';

const AGENTS = ['claude', 'agy', 'opencode'];
const MODES = ['default', 'acceptEdits', 'plan', 'auto'];
const PATCHABLE = ['name', 'agent', 'mode', 'sessionId', 'lastOpened', 'autoCommit', 'model', 'effort', 'developerMode', 'sessionRoute', 'pythonEnv', 'protections', 'activeThread'];
const FOLDER_FIELDS = ['name', 'agent', 'mode', 'model', 'effort', 'autoCommit', 'developerMode', 'pythonEnv', 'protections']; // merged from <project>/.flowstate/project.json

const samePath = (a, b) => (process.platform === 'win32' || process.platform === 'darwin' ? a.toLowerCase() === b.toLowerCase() : a === b);

/**
 * Project registry (the index of known project folders). Extra Phase 7 hooks:
 *  - onChange(cb): cb(kind:'add'|'update'|'remove', project) after every mutation (the project store writes through on it)
 *  - setLoader(fn): fn(realPath) -> {project?:partial, sessions?:{claude,agy}} | null, consulted by add() for a NEW folder
 *    (auto-load of <project>/.flowstate); the returned project then carries `loadedFromFolder: true` (never persisted).
 */
export function createProjects({ dir, fsx = fs, uuid = () => crypto.randomUUID(), now = () => new Date().toISOString() }) {
  const file = path.join(dir, 'projects.json');
  const raw = readJson(file, [], fsx);
  let list = (Array.isArray(raw) ? raw : []).map((p) => ({
    ...p,
    model: isModel(p?.model) ? (p.model ?? null) : null,
    effort: isEffort(p?.effort) ? (p.effort ?? null) : null,
    developerMode: typeof p?.developerMode === 'boolean' ? p.developerMode : null,
  }));
  const save = () => writeJsonAtomic(file, list, fsx);
  const listeners = new Set();
  let loader = null;
  const fire = (kind, project) => { for (const cb of [...listeners]) { try { cb(kind, { ...project }); } catch { /* a listener must never break the registry */ } } };

  function check(patch) {
    if ('agent' in patch && !AGENTS.includes(patch.agent)) throw new TypeError('invalid agent');
    if ('mode' in patch && !MODES.includes(patch.mode)) throw new TypeError('invalid mode');
    if ('name' in patch && (typeof patch.name !== 'string' || !patch.name.trim())) throw new TypeError('invalid name');
    if ('autoCommit' in patch && typeof patch.autoCommit !== 'boolean') throw new TypeError('invalid autoCommit');
    if ('sessionId' in patch && patch.sessionId !== null && typeof patch.sessionId !== 'string') throw new TypeError('invalid sessionId');
    if ('model' in patch && !isModel(patch.model)) throw new TypeError('invalid model');
    if ('effort' in patch && !isEffort(patch.effort)) throw new TypeError('invalid effort');
    if ('sessionRoute' in patch && patch.sessionRoute !== null && !['anthropic', 'deepseek', 'agy', 'opencode'].includes(patch.sessionRoute)) throw new TypeError('invalid sessionRoute');
    if ('developerMode' in patch && patch.developerMode !== null && typeof patch.developerMode !== 'boolean') throw new TypeError('invalid developerMode');
    if ('protections' in patch && !validProtections(patch.protections)) throw new TypeError('invalid protections');
    if ('activeThread' in patch && patch.activeThread !== null && !/^[a-f0-9]{8}$/.test(String(patch.activeThread))) throw new TypeError('invalid activeThread');
    if ('pythonEnv' in patch && !['auto', 'global', 'venv'].includes(patch.pythonEnv)) throw new TypeError('invalid pythonEnv');
  }

  return {
    file,
    list: () => list.map((p) => ({ ...p })),
    get: (id) => { const p = list.find((x) => x.id === id); return p ? { ...p } : null; },
    findByPath(p) {
      let real = p;
      try { real = (fsx.realpathSync.native ?? fsx.realpathSync)(p); } catch { /* not there */ }
      const x = list.find((e) => samePath(e.path, real));
      return x ? { ...x } : null;
    },
    onChange(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    setLoader(fn) { loader = typeof fn === 'function' ? fn : null; },
    add({ name, path: p, agent = 'claude', mode = 'default', autoCommit = false, model = null, effort = null, developerMode = null } = {}) {
      if (typeof p !== 'string' || !path.isAbsolute(p)) throw new TypeError('path must be absolute');
      check({ agent, mode, autoCommit, model, effort, developerMode });
      fsx.mkdirSync(p, { recursive: true });
      // claude refuses Windows 8.3 short paths (LEONAR~1): always store the real long path.
      const real = (fsx.realpathSync.native ?? fsx.realpathSync)(p);
      const existing = list.find((x) => samePath(x.path, real));
      if (existing) return { ...existing };
      const proj = {
        id: uuid(), name: (name && String(name).trim()) || path.basename(real) || real, path: real,
        agent, mode, sessionId: null, lastOpened: now(), autoCommit, model, effort, developerMode,
      };
      let loaded = false;
      if (loader) {
        let found = null;
        try { found = loader(real); } catch { found = null; }
        if (found?.project) {
          for (const k of FOLDER_FIELDS) {
            if (!(k in found.project)) continue;
            try { check({ [k]: found.project[k] }); proj[k] = found.project[k]; loaded = true; } catch { /* invalid value in the file: ignore it */ }
          }
        }
        const sid = found?.sessions?.[proj.agent];
        if (typeof sid === 'string' && sid) { proj.sessionId = sid; loaded = true; }
        if (found?.project || found?.sessions) loaded = true;
      }
      list.push(proj);
      save();
      fire('add', proj);
      return loaded ? { ...proj, loadedFromFolder: true } : { ...proj };
    },
    update(id, patch = {}) {
      const i = list.findIndex((x) => x.id === id);
      if (i < 0) throw new Error('unknown project');
      const clean = {};
      for (const k of PATCHABLE) if (k in patch) clean[k] = patch[k];
      check(clean);
      list[i] = { ...list[i], ...clean };
      save();
      fire('update', list[i]);
      return { ...list[i] };
    },
    remove(id) {
      const gone = list.find((x) => x.id === id);
      list = list.filter((x) => x.id !== id); // registry only; never touches files
      save();
      if (gone) fire('remove', gone);
    },
  };
}
