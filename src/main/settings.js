import fs from 'node:fs';
import path from 'node:path';

export function defaultSettings(locale = 'en') {
  return {
    language: String(locale).toLowerCase().startsWith('es') ? 'es' : 'en',
    theme: 'dark',
    codeTheme: 'github-dark',
    claudePath: null,
    agyPath: null,
    lastProjectId: null,
    autoLaunch: false,
    walkthroughDone: false,
  };
}

/** Atomic JSON write (tmp + rename). */
export function writeJsonAtomic(file, data, fsx = fs) {
  fsx.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fsx.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fsx.renameSync(tmp, file);
}

export function readJson(file, fallback, fsx = fs) {
  try { return JSON.parse(fsx.readFileSync(file, 'utf8')); } catch { return fallback; }
}

const TYPES = {
  language: (v) => v === 'en' || v === 'es',
  theme: (v) => v === 'dark' || v === 'light',
  codeTheme: (v) => typeof v === 'string' && v.length > 0 && v.length < 64,
  claudePath: (v) => v === null || (typeof v === 'string' && path.isAbsolute(v)),
  agyPath: (v) => v === null || (typeof v === 'string' && path.isAbsolute(v)),
  lastProjectId: (v) => v === null || typeof v === 'string',
  autoLaunch: (v) => typeof v === 'boolean',
  walkthroughDone: (v) => typeof v === 'boolean',
};

export function createSettings({ dir, locale = 'en', fsx = fs }) {
  const file = path.join(dir, 'settings.json');
  const defaults = defaultSettings(locale);
  let cache = { ...defaults };
  const stored = readJson(file, {}, fsx);
  for (const k of Object.keys(defaults)) if (k in stored && TYPES[k](stored[k])) cache[k] = stored[k];

  return {
    file,
    get: () => ({ ...cache }),
    set(patch) {
      if (!patch || typeof patch !== 'object') throw new TypeError('settings patch must be an object');
      const next = { ...cache };
      for (const [k, v] of Object.entries(patch)) {
        if (!(k in defaults)) throw new Error(`unknown setting: ${k}`);
        if (!TYPES[k](v)) throw new TypeError(`invalid value for setting ${k}`);
        next[k] = v;
      }
      cache = next;
      writeJsonAtomic(file, cache, fsx);
      return { ...cache };
    },
  };
}
