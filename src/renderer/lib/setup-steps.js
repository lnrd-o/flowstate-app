// Pure helpers for the first-run setup wizard (step list, progress, validation, tool rows). No DOM.

/** Language first, then everything else, all in the chosen language. */
export const SETUP_STEPS = Object.freeze(['language', 'welcome', 'mode', 'look', 'helpers', 'tools', 'extras', 'storage', 'done']);

export const THEMES = Object.freeze(['dark', 'light', 'gold']);
export const LANGS = Object.freeze(['en', 'es']);

/** Tools the setup checks, with the i18n key of the plain-words reason shown next to each. */
export const TOOLS = Object.freeze([
  { id: 'git', reason: 'setup.tools.git' },
  { id: 'node', reason: 'setup.tools.node' },
  { id: 'python', reason: 'setup.tools.python' },
]);

/** { current, total, pct } for "Step x of y"; index is 0-based and clamped. */
export function stepProgress(index, total = SETUP_STEPS.length) {
  const cur = Math.min(Math.max(0, index | 0), Math.max(0, total - 1));
  return { current: cur + 1, total, pct: total > 1 ? Math.round((cur / (total - 1)) * 100) : 100 };
}

export const nextIndex = (i, total = SETUP_STEPS.length) => Math.min(i + 1, total - 1);
export const prevIndex = (i) => Math.max(i - 1, 0);

/** Only the language step can block Next (a supported language must be chosen); nothing else is mandatory. */
export function stepError(id, ctx = {}) {
  if (id === 'language' && !LANGS.includes(ctx.language)) return 'language';
  return null;
}

/** Tool rows from a health snapshot: [{ id, reason, ok, version }]. Unknown health -> everything unknown (ok:null). */
export function toolRows(health) {
  return TOOLS.map((tl) => {
    const h = health && health[tl.id];
    return { id: tl.id, reason: tl.reason, ok: h ? !!h.found : null, version: h && h.version ? h.version : '' };
  });
}

/** Agent rows { id, signed } for the AI-helpers step; at least one signed in = 'ready', none = 'later' (never blocks). */
export function helperRows(signedIn) {
  return ['claude', 'agy', 'opencode'].map((id) => ({ id, signed: signedIn ? signedIn[id] : null }));
}
export function helpersState(signedIn) {
  return helperRows(signedIn).some((r) => r.signed === true) ? 'ready' : 'later';
}

/** Index to show first: language is step 0 always (also when re-opened from Settings). */
export const startIndex = () => 0;
