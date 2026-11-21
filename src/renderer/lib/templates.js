// Pure helpers for prompt templates (no DOM). Template shape: see src/shared/ipc.js (Phase 2).

const VAR_RE = /\{\{\s*([A-Za-z_][\w-]*)\s*\}\}/g;

/** Localised value of {en, es}: current language, else en, else any non-empty value, else ''. */
export function pickLang(obj, lang) {
  if (typeof obj === 'string') return obj;
  if (!obj || typeof obj !== 'object') return '';
  if (obj[lang]) return String(obj[lang]);
  if (obj.en) return String(obj.en);
  const any = Object.values(obj).find((v) => typeof v === 'string' && v);
  return any || '';
}

/** Unique {{key}} names in order of first appearance. */
export function extractVars(body) {
  const seen = [];
  for (const m of String(body ?? '').matchAll(VAR_RE)) if (!seen.includes(m[1])) seen.push(m[1]);
  return seen;
}

/** Initial form values: each var's default (or '', or first option for a select without default). */
export function defaultValues(vars) {
  const out = {};
  for (const v of vars || []) {
    if (v.default != null && v.default !== '') out[v.key] = String(v.default);
    else if (v.type === 'select' && Array.isArray(v.options) && v.options.length) out[v.key] = String(v.options[0]);
    else out[v.key] = '';
  }
  return out;
}

/**
 * Plain-text {{key}} substitution. Values are inserted verbatim (no escaping, no recursive expansion,
 * no "$&" replacement patterns). Missing/empty values fall back to the var default, then ''.
 */
export function render(body, values, vars) {
  const defaults = defaultValues(vars);
  const vals = values || {};
  return String(body ?? '').replace(VAR_RE, (_m, key) => {
    const v = vals[key];
    if (v != null && String(v) !== '') return String(v);
    return defaults[key] ?? '';
  });
}

/** { ok, errors: { key: 'required' } } - required vars must have a non-blank value. */
export function validate(vars, values) {
  const errors = {};
  for (const v of vars || []) {
    if (!v.required) continue;
    const val = values && values[v.key];
    if (val == null || String(val).trim() === '') errors[v.key] = 'required';
  }
  return { ok: Object.keys(errors).length === 0, errors };
}

/** Keep editor settings for vars still present in the body, add new ones as text vars, drop the rest. */
export function syncVars(body, existing) {
  const byKey = new Map((existing || []).map((v) => [v.key, v]));
  return extractVars(body).map((key) => byKey.get(key) || {
    key, label: { en: key, es: key }, type: 'text', default: '', required: false,
  });
}

/** Search by name/description (current language and en), tags and id. Empty query returns everything. */
export function filterTemplates(list, query, lang) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return list;
  return list.filter((tpl) => {
    const hay = [
      tpl.id, pickLang(tpl.name, lang), pickLang(tpl.name, 'en'),
      pickLang(tpl.description, lang), pickLang(tpl.description, 'en'), ...(tpl.tags || []),
    ].join('\n').toLowerCase();
    return q.split(/\s+/).every((w) => hay.includes(w));
  });
}

/** "My Template!" -> "my-template". */
export function slugify(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}

export function isValidId(id) {
  return /^[a-z0-9][a-z0-9_-]{0,47}$/.test(String(id || ''));
}

/** Parse a comma separated tag input into a clean unique list. */
export function parseTags(s) {
  const out = [];
  for (const raw of String(s || '').split(',')) {
    const tag = raw.trim().toLowerCase();
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

/** Normalise a draft from the editor into the Template shape sent to prompts.save. */
export function buildTemplate(draft) {
  const body = String(draft.body ?? '');
  const vars = syncVars(body, draft.vars).map((v) => {
    const out = { key: v.key, label: { en: v.label?.en || v.key, es: v.label?.es || v.label?.en || v.key }, type: v.type || 'text' };
    if (v.default) out.default = String(v.default);
    if (out.type === 'select') out.options = (v.options || []).map(String).filter(Boolean);
    if (v.required) out.required = true;
    return out;
  });
  return {
    id: draft.id, source: 'user',
    name: { en: draft.name?.en || '', es: draft.name?.es || draft.name?.en || '' },
    description: { en: draft.description?.en || '', es: draft.description?.es || draft.description?.en || '' },
    tags: draft.tags || [], body, vars,
  };
}

/** Next free id for a duplicate: "base-copy", "base-copy-2", ... */
export function duplicateId(id, existingIds) {
  const taken = new Set(existingIds);
  let n = 1;
  let cand = id + '-copy';
  while (taken.has(cand)) { n += 1; cand = id + '-copy-' + n; }
  return cand;
}
