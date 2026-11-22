// UI state persistence. Global state: <userData>/ui-state.json. Per-project state lives in <project>/.flowstate/state.json -> ui (via svc/store).
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic, readJson } from '../settings.js';

export const MAX_PATCH = 16 * 1024;
export const MAX_TOTAL = 256 * 1024;

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const size = (v) => { try { return JSON.stringify(v).length; } catch { return Infinity; } };

/** Shallow merge; a null value deletes the key. Throws when the patch is not a plain object or exceeds the cap. */
export function mergePatch(base, patch, { maxPatch = MAX_PATCH, maxTotal = MAX_TOTAL } = {}) {
  if (!isPlain(patch)) throw new TypeError('patch must be an object');
  if (size(patch) > maxPatch) throw new RangeError('patch too large (max 16 KB)');
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if (v === null) delete out[k]; else out[k] = v;
  }
  if (size(out) > maxTotal) throw new RangeError('ui state too large');
  return out;
}

export function createUi({ dir, services = {}, fsx = fs, debounceMs = 500, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
  const file = path.join(dir, 'ui-state.json');
  const raw = readJson(file, {}, fsx);
  let state = isPlain(raw) ? raw : {};
  let timer = null;
  const flush = () => {
    if (timer) { clearTimeoutFn(timer); timer = null; }
    try { writeJsonAtomic(file, state, fsx); } catch { /* best effort */ }
  };
  const store = () => {
    const s = services.store;
    if (!s) throw new Error('service not available: store');
    return s;
  };
  return {
    file,
    get: () => ({ ...state }),
    set(patch) {
      state = mergePatch(state, patch);
      if (!timer) { timer = setTimeoutFn(flush, debounceMs); timer?.unref?.(); }
    },
    projectGet: (id) => store().getUi(id),
    projectSet(id, patch) {
      mergePatch(store().getUi(id), patch); // validates shape + size only
      store().setUi(id, patch); // the store merges and clears null keys itself
    },
    flush,
    dispose: flush,
  };
}

export function create(deps) {
  return createUi({ dir: deps.dir, services: deps.services });
}
