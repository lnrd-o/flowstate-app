// DeepSeek balance / models (optional, off unless settings.deepseekEnabled). The API key is stored ONLY encrypted with Electron
// safeStorage in <userData>/deepseek.key (base64 of the encrypted bytes). It is never logged, put in settings/history/IPC results.
// The origin is hard-coded (no user-supplied URL = no SSRF).
import fs from 'node:fs';
import path from 'node:path';
import { deepseekEnv, isDeepseekModel } from '../agents/routes.js';

export const ORIGIN = 'https://api.deepseek.com';
export const TIMEOUT_MS = 10000;
export const CACHE_MS = 60 * 1000;

/** GET /user/balance body -> Balance (first balance_infos entry) | null. */
export function mapBalance(body) {
  const b = body?.balance_infos?.[0];
  if (!b || typeof b !== 'object') return null;
  return {
    available: body.is_available === true, currency: String(b.currency ?? ''), total: String(b.total_balance ?? '0'),
    granted: String(b.granted_balance ?? '0'), toppedUp: String(b.topped_up_balance ?? '0'),
  };
}

/** GET /models body -> [{id, ownedBy}] */
export function mapModels(body) {
  const data = Array.isArray(body?.data) ? body.data : [];
  return data.filter((m) => m && typeof m.id === 'string').slice(0, 100).map((m) => ({ id: m.id, ownedBy: typeof m.owned_by === 'string' ? m.owned_by : undefined }));
}

export function errorCode(status) {
  if (status === 401 || status === 403) return 'invalid-key';
  return `http-${status}`;
}

export function createDeepseek({ dir, settings, safeStorage, fetchFn = (...a) => globalThis.fetch(...a), fsx = fs, now = Date.now, timeoutMs = TIMEOUT_MS } = {}) {
  const keyFile = path.join(dir, 'deepseek.key');
  let cache = null; // {at, value}
  let inflight = null;

  const hasKey = () => { try { return fsx.statSync(keyFile).size > 0; } catch { return false; } };
  function readKey() {
    try {
      const enc = Buffer.from(fsx.readFileSync(keyFile, 'utf8').trim(), 'base64');
      const k = safeStorage.decryptString(enc);
      return typeof k === 'string' && k ? k : null;
    } catch { return null; }
  }
  const enabled = () => !!settings?.get?.().deepseekEnabled;

  async function getJson(urlPath, key) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchFn(`${ORIGIN}${urlPath}`, { method: 'GET', headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, signal: ctl.signal, redirect: 'error' });
      if (!res.ok) return { error: errorCode(res.status) };
      return { body: await res.json() };
    } catch { return { error: 'offline' }; } finally { clearTimeout(timer); }
  }

  async function fetchStatus() {
    const key = readKey();
    if (!key) return { configured: hasKey(), enabled: true, error: 'invalid-key' };
    const [bal, mod] = await Promise.all([getJson('/user/balance', key), getJson('/models', key)]);
    const err = bal.error ?? mod.error;
    const out = { configured: true, enabled: true, updatedAt: now() };
    const balance = bal.body ? mapBalance(bal.body) : null;
    if (balance) out.balance = balance;
    if (mod.body) out.models = mapModels(mod.body);
    if (err && !balance && !out.models) out.error = err;
    else if (err) out.error = err; // partial: keep what we have, flag the failure
    return out;
  }

  return {
    /** True when an encrypted key file exists (never reveals it). */
    hasKey,
    /**
     * MAIN ONLY (never exposed over IPC): env for a Claude Code child that runs against DeepSeek's Anthropic endpoint.
     * -> {env} | {error:'no-key'|'invalid-model'}. The key is decrypted here and only returned to the agent manager, which merges it into the child env.
     */
    routeEnv(model) {
      if (!isDeepseekModel(model)) return { error: 'invalid-model' };
      const key = readKey();
      if (!key) return { error: 'no-key' };
      return { env: deepseekEnv(key, model) };
    },
    /** key:string|null. null removes it. Nothing is stored unless encryption is available. */
    setKey(key) {
      cache = null;
      if (key === null) {
        try { fsx.unlinkSync(keyFile); } catch { /* none */ }
        return { ok: true };
      }
      if (typeof key !== 'string' || key.length < 8 || key.length > 300 || /\s/.test(key)) return { ok: false, error: 'invalid-key' };
      let available = false;
      try { available = !!safeStorage?.isEncryptionAvailable?.(); } catch { available = false; }
      if (!available) return { ok: false, error: 'encryption-unavailable' };
      try {
        const enc = safeStorage.encryptString(key);
        fsx.mkdirSync(dir, { recursive: true });
        const tmp = `${keyFile}.${process.pid}.tmp`;
        fsx.writeFileSync(tmp, Buffer.from(enc).toString('base64'), 'utf8');
        fsx.renameSync(tmp, keyFile);
      } catch { return { ok: false, error: 'store-failed' }; }
      return { ok: true };
    },
    async status(force = false) {
      const on = enabled();
      const configured = hasKey();
      if (!on || !configured) return { configured, enabled: on };
      if (!force && cache && now() - cache.at < CACHE_MS) return cache.value;
      if (!inflight) {
        inflight = fetchStatus().then((v) => { cache = { at: now(), value: v }; return v; }).finally(() => { inflight = null; });
      }
      return inflight;
    },
  };
}

export function create(deps) {
  return createDeepseek({ dir: deps.dir, settings: deps.settings, safeStorage: deps.electron.safeStorage });
}
