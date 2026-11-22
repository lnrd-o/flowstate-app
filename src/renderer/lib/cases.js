// Pure helpers for the "What do you need help with?" new-project wizard (cases = bundled office methodologies). No DOM.
import { pickText } from '../../shared/methodology.js';
import { folderNameFromTitle } from '../../shared/folder-name.js';

/** Category filter chips shown above the case grid (meta.category values; 'all' = no filter). */
export const CASE_FILTERS = Object.freeze(['all', 'excel', 'web', 'data', 'dashboard', 'research', 'document', 'automation']);

/** The four big quick-pick buttons, in the user's own words. `categories` = which case categories they stand for. */
export const QUICK_PICKS = Object.freeze([
  { id: 'excel', icon: 'table', categories: ['excel'] },
  { id: 'web', icon: 'globe', categories: ['web'] },
  { id: 'data', icon: 'chart', categories: ['data', 'dashboard'] },
  { id: 'research', icon: 'search', categories: ['research'] },
]);

/** meta.icon (contract names) -> inline icon key in lib/dom.js. */
const ICON_MAP = { table: 'table', 'file-text': 'fileText', globe: 'globe', chart: 'chart', search: 'search', edit: 'edit', zap: 'zap', folder: 'folder' };
export function caseIcon(name) { return ICON_MAP[name] || 'sparkles'; }

export const isCase = (m) => !!(m && m.meta && m.meta.kind === 'case');
export const categoryOf = (m) => (m && m.meta && m.meta.category) || 'other';

/** Only the case methodologies of a method.list result. */
export function casesOf(list) { return (Array.isArray(list) ? list : []).filter(isCase); }

/** category: a category id, an array of ids or ''/'all' for everything. query: words matched against name, description and tags. */
export function filterCases(list, { category = 'all', query = '', lang = 'en' } = {}) {
  const cats = Array.isArray(category) ? category : (category && category !== 'all' ? [category] : []);
  const words = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  return casesOf(list).filter((m) => {
    if (cats.length && !cats.includes(categoryOf(m))) return false;
    if (!words.length) return true;
    const hay = [m.id, pickText(m.name, lang), pickText(m.name, 'en'), pickText(m.description, lang), pickText(m.description, 'en'), categoryOf(m), ...(m.tags || [])].join('\n').toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/**
 * What a quick-pick button does: exactly one matching case -> { kind:'case', id }; several -> { kind:'grid', categories }
 * (the grid opens filtered); none -> { kind:'grid', categories: [] } (everything).
 */
export function resolveQuickPick(list, pick) {
  const hits = filterCases(list, { category: pick.categories });
  if (hits.length === 1) return { kind: 'case', id: hits[0].id };
  return { kind: 'grid', categories: hits.length ? pick.categories.slice() : [] };
}

const pad = (n) => String(n).padStart(2, '0');
/** yyyy-mm-dd in local time. */
export function isoDay(date = new Date()) { return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`; }

/** 'Sales analysis - 2026-11-22'. */
export function defaultProjectName(caseName, date = new Date()) {
  return `${String(caseName || '').trim() || 'Project'} - ${isoDay(date)}`;
}

/** Join a location and a folder name with the separator the location already uses. */
export function joinPath(dir, name) {
  const d = String(dir || '').replace(/[\\/]+$/, '');
  if (!d) return name;
  const sep = d.includes('\\') || /^[A-Za-z]:$/.test(d) ? '\\' : '/';
  return d + sep + name;
}

/** Read-only preview under the name input: <default folder>/<folder name from the title> (main may add _2 if it exists). */
export function folderPreview(dir, name, lang = 'en') { return joinPath(dir, folderNameFromTitle(name, lang)); }

/** Last segment of a Windows or POSIX path. */
export function baseName(p) { return String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ''; }

/** Wizard step ids: the questions step only exists when the chosen case has variables. */
export function wizardSteps(hasQuestions) {
  return hasQuestions ? ['help', 'questions', 'name', 'agent', 'ready'] : ['help', 'name', 'agent', 'ready'];
}

export const fileVars = (vars) => (vars || []).filter((v) => v && v.type === 'file');

/** Agent to preselect: the signed-in one (Claude first); Claude when unknown. */
export function preferredAgent(signedIn) {
  if (signedIn && signedIn.claude === true) return 'claude';
  if (signedIn && signedIn.agy === true) return 'agy';
  return 'claude';
}

/** Files the run will copy: [{ key, path, name }] for every 'file' var that holds a picked absolute path. */
export function filesToImport(vars, values) {
  return fileVars(vars).map((v) => ({ key: v.key, path: String((values && values[v.key]) || ''), name: baseName(values && values[v.key]) })).filter((f) => f.path);
}

/**
 * Copy every picked file into the project (api.files.import) and return a new values object where each file var holds the
 * project-relative path. Originals are never touched. Throws the first import error; `done` (optional) is a cache of
 * key -> rel from an earlier attempt so a retry does not copy again.
 */
export async function importFileVars(api, projectId, vars, values, done = {}) {
  const out = { ...values };
  for (const f of filesToImport(vars, values)) {
    if (done[f.key] && done[f.key].src === f.path) { out[f.key] = done[f.key].rel; continue; }
    const r = await api.files.import(projectId, f.path);
    if (!r || typeof r.rel !== 'string') throw new Error('import failed');
    done[f.key] = { src: f.path, rel: r.rel };
    out[f.key] = r.rel;
  }
  return out;
}
