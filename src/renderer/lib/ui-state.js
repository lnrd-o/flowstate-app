// Pure helpers for UI state persistence (debounce, merge, restore plan). No DOM, no API.

/** Debounce with flush/cancel. fn gets the LAST arguments. */
export function debounce(fn, ms, timers = { set: (f, d) => setTimeout(f, d), clear: (id) => clearTimeout(id) }) {
  let id = null;
  let lastArgs = null;
  const run = () => { id = null; const a = lastArgs; lastArgs = null; if (a) fn(...a); };
  const d = (...args) => {
    lastArgs = args;
    if (id != null) timers.clear(id);
    id = timers.set(run, ms);
  };
  d.flush = () => { if (id != null) { timers.clear(id); run(); } };
  d.cancel = () => { if (id != null) timers.clear(id); id = null; lastArgs = null; };
  d.pending = () => id != null;
  return d;
}

export const UI_MAX_BYTES = 16 * 1024;

/** Shallow merge of a patch into the previous object (undefined values delete the key). */
export function mergeUi(prev, patch) {
  const out = { ...(prev && typeof prev === 'object' ? prev : {}) };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v === undefined) delete out[k]; else out[k] = v;
  }
  return out;
}

/** Keep a merged object under the 16 KB limit of ui:set (a huge draft is shortened, then dropped). */
export function fitUi(obj) {
  const out = { ...obj };
  if (JSON.stringify(out).length <= UI_MAX_BYTES) return out;
  if (typeof out.draft === 'string') out.draft = out.draft.slice(0, 4000);
  if (JSON.stringify(out).length <= UI_MAX_BYTES) return out;
  delete out.draft;
  return JSON.stringify(out).length <= UI_MAX_BYTES ? out : {};
}

const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
const VIEWS = ['project', 'prompts', 'methodologies', 'tasks'];
const TABS = ['preview', 'files', 'context', 'terminal', 'activity', 'dashboard', 'versions', 'git'];

/**
 * What to apply at boot, validated. global = ui.get(), project = ui.projectGet(id).
 * -> { sidebarCollapsed?, artifactsCollapsed?, sidebarWidth?, artifactsWidth?, view?, artifactsTab?, openFile?, draft?, scroll? } (only valid keys present)
 */
export function restorePlan(global, project) {
  const g = global && typeof global === 'object' ? global : {};
  const p = project && typeof project === 'object' ? project : {};
  const out = {};
  if (typeof g.sidebarCollapsed === 'boolean') out.sidebarCollapsed = g.sidebarCollapsed;
  if (typeof g.artifactsCollapsed === 'boolean') out.artifactsCollapsed = g.artifactsCollapsed;
  if (isNum(g.sidebarWidth) && g.sidebarWidth >= 200 && g.sidebarWidth <= 600) out.sidebarWidth = Math.round(g.sidebarWidth);
  if (isNum(g.artifactsWidth) && g.artifactsWidth >= 200 && g.artifactsWidth <= 2000) out.artifactsWidth = Math.round(g.artifactsWidth);
  if (VIEWS.includes(g.view)) out.view = g.view;
  const tab = p.artifactsTab || g.artifactsTab;
  if (TABS.includes(tab)) out.artifactsTab = tab;
  if (typeof p.openFile === 'string' && p.openFile && p.openFile.length < 1024 && !/(^|[\\/])\.\.([\\/]|$)/.test(p.openFile)) out.openFile = p.openFile;
  if (typeof p.draft === 'string' && p.draft) out.draft = p.draft;
  if (isNum(p.scroll) && p.scroll >= 0) out.scroll = Math.round(p.scroll);
  return out;
}

/** The part of the store that belongs to the GLOBAL ui object. */
export function globalSlice(s) {
  return {
    sidebarCollapsed: !!s.sidebarCollapsed,
    artifactsCollapsed: !!s.artifactsCollapsed,
    view: s.view,
    ...(isNum(s.artifactsWidth) ? { artifactsWidth: s.artifactsWidth } : {}),
    ...(isNum(s.sidebarWidth) ? { sidebarWidth: s.sidebarWidth } : {}),
  };
}
