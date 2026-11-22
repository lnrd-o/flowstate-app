// Pure helpers for the methodologies UI (list filtering, node summaries, run steps/durations). No DOM.
import { pickText, NODE_TYPES } from '../../shared/methodology.js';
import { validate, defaultValues } from './templates.js';

export const NODE_META = Object.freeze({
  prompt: { icon: 'message', tone: 'accent' },
  command: { icon: 'terminal', tone: 'amber' },
  'git-commit': { icon: 'git', tone: 'green' },
  'ask-user': { icon: 'question', tone: 'blue' },
  checkpoint: { icon: 'flag', tone: 'amber' },
  artifact: { icon: 'file', tone: 'muted' },
  condition: { icon: 'branch', tone: 'accent' },
});
export { NODE_TYPES };

export const RUN_STATES = Object.freeze(['pending', 'running', 'waiting', 'done', 'error', 'skipped', 'warn']);

/** Search by name/description (current language and en), tags, id and source. Empty query returns everything. */
export function filterMethods(list, query, lang) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return list;
  return list.filter((m) => {
    const hay = [m.id, m.source, pickText(m.name, lang), pickText(m.name, 'en'), pickText(m.description, lang), pickText(m.description, 'en'), ...(m.tags || [])].join('\n').toLowerCase();
    return q.split(/\s+/).every((w) => hay.includes(w));
  });
}

/** One-line description of what a node does (raw text, {{vars}} left as is). */
export function nodeSummary(n) {
  switch (n.type) {
    case 'prompt': return n.text || '';
    case 'command': return [n.exe, ...(n.args || [])].filter(Boolean).join(' ');
    case 'git-commit': return n.message || '';
    case 'ask-user': return n.question || '';
    case 'checkpoint': return n.message || '';
    case 'artifact': return n.path || '';
    case 'condition': return n.var ? `${n.var} = ${n.equals}` : '';
    default: return '';
  }
}

/** "1.2 s", "3 min 05 s", "" for missing. */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return '<1 s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, '0')} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

/** Steps that have started, in execution order: [{ id, state, message, startedAt, endedAt, durationMs }]. */
export function runSteps(state) {
  if (!state || !state.nodes) return [];
  return Object.entries(state.nodes)
    .filter(([, n]) => n.state !== 'pending' && n.state !== 'skipped' || n.startedAt)
    .map(([id, n]) => ({ id, state: n.state, message: n.message || '', startedAt: n.startedAt || 0, endedAt: n.endedAt || null, durationMs: n.startedAt && n.endedAt ? n.endedAt - n.startedAt : null }))
    .sort((a, b) => a.startedAt - b.startedAt);
}

export const isActiveRun = (s) => !!s && (s.status === 'running' || s.status === 'waiting');

/** Counts per node state, e.g. { done: 3, warn: 1 }. */
export function countStates(state) {
  const out = {};
  for (const n of Object.values((state && state.nodes) || {})) out[n.state] = (out[n.state] || 0) + 1;
  return out;
}

/** Initial values for the run variables form. */
export const runDefaults = (vars) => defaultValues(vars);

/** { ok, errors:{key:'required'} } for the run variables form (path vars are plain text). */
export const validateRunVars = (vars, values) => validate(vars, values);

/** Copy of a methodology as a new user methodology. */
export function duplicateOf(m, id, suffix) {
  const c = JSON.parse(JSON.stringify(m));
  c.id = id; c.source = 'user';
  c.name = { en: `${m.name.en} ${suffix.en}`, ...(m.name.es !== undefined ? { es: `${m.name.es} ${suffix.es}` } : {}) };
  return c;
}
