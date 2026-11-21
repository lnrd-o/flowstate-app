// FlowState i18n. Pure functions are testable in Node via _setDictionaries(en, es).
// In the renderer: await setLanguage('es'); applyTranslations(document); onChange(() => rerender()).

const SUPPORTED = ['en', 'es'];
let dicts = { en: null, es: null };
let current = 'en';
const listeners = new Set();

function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? prefix + '.' + k : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = String(v);
  }
  return out;
}

export function _setDictionaries(en, es) {
  dicts = { en: flatten(en), es: flatten(es) };
}

export function getSupportedLanguages() { return SUPPORTED.slice(); }
export function getLanguage() { return current; }

/** Map an OS locale like "es-MX" to a supported language (default 'en'). */
export function detectLanguage(locale) {
  const l = String(locale || '').slice(0, 2).toLowerCase();
  return SUPPORTED.includes(l) ? l : 'en';
}

export function onChange(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

async function loadDict(lang) {
  if (dicts[lang]) return;
  if (typeof fetch !== 'function') return;
  const res = await fetch('./i18n/' + lang + '.json');
  if (!res.ok) throw new Error('i18n: cannot load ' + lang);
  dicts[lang] = flatten(await res.json());
}

export async function setLanguage(lang) {
  const next = SUPPORTED.includes(lang) ? lang : 'en';
  await loadDict('en');
  if (next !== 'en') await loadDict(next);
  for (const l of SUPPORTED) { try { await loadDict(l); } catch { /* optional: only needed for bilingual defaults */ } }
  current = next;
  if (typeof document !== 'undefined' && document.documentElement) document.documentElement.lang = next;
  for (const cb of [...listeners]) {
    try { cb(next); } catch { /* listener errors must not break language switch */ }
  }
  return next;
}

/** Translate key with {name} interpolation. Falls back to en, then to the key itself. */
export function t(key, vars) {
  const s = (dicts[current] && dicts[current][key]) ?? (dicts.en && dicts.en[key]) ?? key;
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, name) => (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m));
}

/** Translate into a specific language regardless of the current one (used to store bilingual defaults). */
export function tIn(lang, key) {
  return (dicts[lang] && dicts[lang][key]) ?? (dicts.en && dicts.en[key]) ?? key;
}

/** Fill data-i18n (text), data-i18n-placeholder, data-i18n-title, data-i18n-aria-label inside root. */
export function applyTranslations(root) {
  const scope = root || (typeof document !== 'undefined' ? document : null);
  if (!scope || !scope.querySelectorAll) return;
  const apply = (attr, fn) => {
    scope.querySelectorAll('[' + attr + ']').forEach((el) => fn(el, t(el.getAttribute(attr))));
  };
  apply('data-i18n', (el, s) => { el.textContent = s; });
  apply('data-i18n-placeholder', (el, s) => { el.setAttribute('placeholder', s); });
  apply('data-i18n-title', (el, s) => { el.setAttribute('title', s); });
  apply('data-i18n-aria-label', (el, s) => { el.setAttribute('aria-label', s); });
}
