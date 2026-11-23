import fs from 'node:fs';
import path from 'node:path';
import { defaultAgentsEnabled, isAgentsEnabled, normalizeAgentsEnabled, hasEnabledSource } from '../shared/sources.js';

export function defaultSettings(locale = 'en') {
  return {
    language: String(locale).toLowerCase().startsWith('es') ? 'es' : 'en',
    // true = follow the system language (re-detected at every start); picking a language in Settings turns it off.
    languageAuto: true,
    theme: 'dark',
    codeTheme: 'github-dark',
    claudePath: null,
    agyPath: null,
    opencodePath: null,
    lastProjectId: null,
    autoLaunch: false,
    walkthroughDone: false,
    // Developer mode: show code, diffs, commands and exact details in approvals. Off = simple, plain-language view.
    developerMode: true,
    // Desktop notifications when a turn finishes / needs approval while FlowState is in the background.
    notifications: true,
    // Pay-as-you-go models (OpenCode Zen, DeepSeek) need an explicit OK before first use: accepted one by one, or all at once.
    acceptedModels: [],
    acceptAllPayg: false,
    // Download new versions from GitHub Releases in the background (installed builds only).
    autoUpdate: true,
    // Install a downloaded update by itself when nothing is running (15 s countdown with Cancel / Update now).
    autoInstallUpdates: true,
    // DeepSeek usage/models panel (the API key itself is NOT a setting: it lives encrypted via svc/deepseek.js)
    deepseekEnabled: false,
    // Per-source switches (claude / agy / opencode / deepseek). deepseekEnabled is kept in sync with agentsEnabled.deepseek.
    agentsEnabled: defaultAgentsEnabled(),
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
  languageAuto: (v) => typeof v === 'boolean',
  theme: (v) => v === 'dark' || v === 'light' || v === 'gold',
  codeTheme: (v) => typeof v === 'string' && v.length > 0 && v.length < 64,
  claudePath: (v) => v === null || (typeof v === 'string' && path.isAbsolute(v)),
  agyPath: (v) => v === null || (typeof v === 'string' && path.isAbsolute(v)),
  opencodePath: (v) => v === null || (typeof v === 'string' && path.isAbsolute(v)),
  lastProjectId: (v) => v === null || typeof v === 'string',
  autoLaunch: (v) => typeof v === 'boolean',
  walkthroughDone: (v) => typeof v === 'boolean',
  developerMode: (v) => typeof v === 'boolean',
  notifications: (v) => typeof v === 'boolean',
  acceptedModels: (v) => Array.isArray(v) && v.length <= 200 && v.every((x) => typeof x === 'string' && x.length > 0 && x.length <= 160),
  acceptAllPayg: (v) => typeof v === 'boolean',
  autoUpdate: (v) => typeof v === 'boolean',
  autoInstallUpdates: (v) => typeof v === 'boolean',
  deepseekEnabled: (v) => typeof v === 'boolean',
  agentsEnabled: (v) => isAgentsEnabled(v),
};

export function createSettings({ dir, locale = 'en', fsx = fs }) {
  const file = path.join(dir, 'settings.json');
  const defaults = defaultSettings(locale);
  let cache = { ...defaults };
  const stored = readJson(file, {}, fsx);
  for (const k of Object.keys(defaults)) if (k in stored && TYPES[k](stored[k])) cache[k] = stored[k];
  // Language: an existing file without languageAuto keeps the language its user had (auto off); otherwise follow the system language.
  if (!('languageAuto' in stored) && 'language' in stored && TYPES.language(stored.language)) cache.languageAuto = false;
  if (cache.languageAuto) cache.language = defaults.language;
  // Migration: files without agentsEnabled derive it from the old deepseekEnabled flag. Never leave every source off.
  cache.agentsEnabled = normalizeAgentsEnabled(stored.agentsEnabled, TYPES.deepseekEnabled(stored.deepseekEnabled) ? stored.deepseekEnabled : undefined);
  if (!hasEnabledSource(cache.agentsEnabled)) cache.agentsEnabled = defaultAgentsEnabled();
  cache.deepseekEnabled = cache.agentsEnabled.deepseek;

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
      // Language: choosing one explicitly turns automatic off; turning automatic on re-detects the system language.
      if ('languageAuto' in patch && patch.languageAuto === true) next.language = defaults.language;
      else if ('language' in patch && patch.language !== cache.language && !('languageAuto' in patch)) next.languageAuto = false;
      // agentsEnabled (partial allowed) and deepseekEnabled stay one setting; the last enabled source cannot be switched off.
      if ('agentsEnabled' in patch) next.agentsEnabled = normalizeAgentsEnabled({ ...cache.agentsEnabled, ...patch.agentsEnabled });
      else if ('deepseekEnabled' in patch) next.agentsEnabled = { ...cache.agentsEnabled, deepseek: patch.deepseekEnabled };
      if (!hasEnabledSource(next.agentsEnabled)) throw new TypeError('at least one source must stay enabled');
      next.deepseekEnabled = next.agentsEnabled.deepseek;
      cache = next;
      writeJsonAtomic(file, cache, fsx);
      return { ...cache };
    },
  };
}
