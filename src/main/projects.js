import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeJsonAtomic, readJson } from './settings.js';

const AGENTS = ['claude', 'agy'];
const MODES = ['default', 'acceptEdits', 'plan'];
const PATCHABLE = ['name', 'agent', 'mode', 'sessionId', 'lastOpened', 'autoCommit'];

export function createProjects({ dir, fsx = fs, uuid = () => crypto.randomUUID(), now = () => new Date().toISOString() }) {
  const file = path.join(dir, 'projects.json');
  const raw = readJson(file, [], fsx);
  let list = Array.isArray(raw) ? raw : [];
  const save = () => writeJsonAtomic(file, list, fsx);

  function check(patch) {
    if ('agent' in patch && !AGENTS.includes(patch.agent)) throw new TypeError('invalid agent');
    if ('mode' in patch && !MODES.includes(patch.mode)) throw new TypeError('invalid mode');
    if ('name' in patch && (typeof patch.name !== 'string' || !patch.name.trim())) throw new TypeError('invalid name');
    if ('autoCommit' in patch && typeof patch.autoCommit !== 'boolean') throw new TypeError('invalid autoCommit');
    if ('sessionId' in patch && patch.sessionId !== null && typeof patch.sessionId !== 'string') throw new TypeError('invalid sessionId');
  }

  return {
    file,
    list: () => list.map((p) => ({ ...p })),
    get: (id) => { const p = list.find((x) => x.id === id); return p ? { ...p } : null; },
    add({ name, path: p, agent = 'claude', mode = 'default', autoCommit = false } = {}) {
      if (typeof p !== 'string' || !path.isAbsolute(p)) throw new TypeError('path must be absolute');
      check({ agent, mode, autoCommit });
      fsx.mkdirSync(p, { recursive: true });
      // claude refuses Windows 8.3 short paths (LEONAR~1): always store the real long path.
      const real = (fsx.realpathSync.native ?? fsx.realpathSync)(p);
      const existing = list.find((x) => x.path.toLowerCase() === real.toLowerCase());
      if (existing) return { ...existing };
      const proj = {
        id: uuid(), name: (name && String(name).trim()) || path.basename(real) || real, path: real,
        agent, mode, sessionId: null, lastOpened: now(), autoCommit,
      };
      list.push(proj);
      save();
      return { ...proj };
    },
    update(id, patch = {}) {
      const i = list.findIndex((x) => x.id === id);
      if (i < 0) throw new Error('unknown project');
      const clean = {};
      for (const k of PATCHABLE) if (k in patch) clean[k] = patch[k];
      check(clean);
      list[i] = { ...list[i], ...clean };
      save();
      return { ...list[i] };
    },
    remove(id) {
      list = list.filter((x) => x.id !== id); // registry only; never touches files
      save();
    },
  };
}
