// Usage tracking: claude rate-limit windows + per-turn cost/tokens, agy per-turn tokens, limit messages, DeepSeek balance.
// Daily buckets (local date) persisted to <userData>/usage.json, 30 days kept. `claude -p "/usage"` (local, no model call) refreshes
// the plan windows at most every 5 minutes (see docs/spikes.md).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { writeJsonAtomic, readJson } from '../settings.js';
import { spawnEnv } from '../platform.js';
import { CH } from '../../shared/ipc.js';

export const KEEP_DAYS = 30;
export const REFRESH_MS = 5 * 60 * 1000;
export const PUSH_MS = 1000;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const n0 = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
const pad = (n) => String(n).padStart(2, '0');

/** Local-date bucket key YYYY-MM-DD. */
export const dayKey = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

const emptyClaude = () => ({ costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 0 });
const emptyAgy = () => ({ inputTokens: 0, outputTokens: 0, thinkingTokens: 0, turns: 0 });
const emptyTokens = () => ({ inputTokens: 0, outputTokens: 0, turns: 0 }); // deepseek route / opencode (cost is not tracked: not Anthropic pricing)

/** Tolerant token extraction. claude: input = input + cache creation + cache read; thinking under output_tokens_details. agy: *_tokens. */
export function tokensOf(usage) {
  const u = usage && typeof usage === 'object' ? usage : {};
  return {
    input: n0(u.input_tokens) + n0(u.cache_creation_input_tokens) + n0(u.cache_read_input_tokens) + n0(u.cache_read_tokens),
    output: n0(u.output_tokens),
    thinking: n0(u.thinking_tokens) || n0(u.output_tokens_details?.thinking_tokens),
  };
}

/** Milliseconds a time zone is ahead of UTC at instant `ts`. */
export function tzOffsetMs(ts, timeZone) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  });
  const p = Object.fromEntries(f.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ts / 1000) * 1000;
}

/** Wall-clock time in a zone -> epoch ms (DST-safe via a second pass). timeZone undefined = local zone of the machine. */
export function wallToEpoch(y, mo, d, h, mi, timeZone) {
  const guess = Date.UTC(y, mo, d, h, mi, 0);
  if (!timeZone) return new Date(y, mo, d, h, mi, 0).getTime();
  let t = guess - tzOffsetMs(guess, timeZone);
  t = guess - tzOffsetMs(t, timeZone);
  return t;
}

/** "Nov 22, 2:10am (America/Mexico_City)" | "6am" | "3:30pm (UTC)" -> epoch ms (next occurrence after `now`), or null. */
export function parseResetsAt(text, now = Date.now()) {
  const m = /(?:(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,|\s)\s*)?)(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?:\s*\(([^)]+)\))?/i.exec(String(text ?? ''));
  if (!m) return null;
  let h = Number(m[3]) % 12;
  if (m[5].toLowerCase() === 'pm') h += 12;
  const mi = Number(m[4] ?? 0);
  let tz = m[6]?.trim();
  if (tz) { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { tz = undefined; } }
  const nowYear = new Date(now).getUTCFullYear();
  if (m[1]) {
    const mo = MONTHS.indexOf(m[1].toLowerCase());
    if (mo < 0) return null;
    let t = wallToEpoch(nowYear, mo, Number(m[2]), h, mi, tz);
    if (t < now - 36 * 3600 * 1000) t = wallToEpoch(nowYear + 1, mo, Number(m[2]), h, mi, tz); // year rollover
    return t;
  }
  // time only: today if still ahead, otherwise tomorrow (in the target zone)
  const base = new Date(now + (tz ? tzOffsetMs(now, tz) : -new Date(now).getTimezoneOffset() * 60000));
  let t = wallToEpoch(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), h, mi, tz);
  if (t <= now) t = wallToEpoch(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + 1, h, mi, tz);
  return t;
}

const statusFor = (u) => (u >= 1 ? 'rejected' : u >= 0.8 ? 'allowed_warning' : 'allowed');

/**
 * Parse the text printed by `claude -p "/usage"`:
 *   Current session: 28% used [middle dot] resets Nov 22, 2:10am (America/Mexico_City)
 *   Current week (all models): 17% used [middle dot] resets Nov 25, 6am (America/Mexico_City)
 * -> {five_hour?:Window, seven_day?:Window}
 */
export function parseUsageText(text, now = Date.now()) {
  const out = {};
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^\s*Current (session|week \(all models\)):\s*(\d{1,3}(?:\.\d+)?)%\s*used(?:\s*[^\w\s]\s*resets\s+(.+?))?\s*$/i.exec(line);
    if (!m) continue;
    const utilization = Math.min(1, Number(m[2]) / 100);
    const resetsAt = m[3] ? parseResetsAt(m[3], now) : null;
    if (resetsAt == null) continue; // a window without a reset time cannot be shown reliably
    out[/session/i.test(m[1]) ? 'five_hour' : 'seven_day'] = { utilization, resetsAt, status: statusFor(utilization) };
  }
  return out;
}

/** Plain spawn with stdin closed (claude waits 3 s for piped stdin otherwise). Never rejects. */
export function runText(cmd, args, { cwd, timeout = 30000, spawn = nodeSpawn } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    let child;
    const finish = (code) => { if (!done) { done = true; clearTimeout(timer); resolve({ code, stdout: out }); } };
    const timer = setTimeout(() => { try { child?.kill(); } catch { /* ignore */ } finish(-1); }, timeout);
    timer.unref?.();
    try {
      child = spawn(cmd, args, { cwd, env: spawnEnv(), windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
      child.stdout?.setEncoding?.('utf8');
      child.stdout?.on('data', (d) => { if (out.length < 200000) out += d; });
      child.on('error', () => finish(-1));
      child.on('close', (c) => finish(c ?? -1));
    } catch { finish(-1); }
  });
}

export function createUsage({
  dir, settings = null, health = null, services = {}, push = () => {}, getProject = () => null, fsx = fs,
  now = Date.now, runUsage = runText, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, cwd = os.tmpdir(), persistMs = 2000,
} = {}) {
  const file = path.join(dir, 'usage.json');
  const raw = readJson(file, {}, fsx);
  const state = {
    days: raw && typeof raw.days === 'object' && raw.days ? raw.days : {},
    claude: { windows: { five_hour: null, seven_day: null, ...(raw?.claude?.windows ?? {}) }, lastLimit: raw?.claude?.lastLimit ?? null, updatedAt: raw?.claude?.updatedAt ?? null },
    agy: { lastLimit: raw?.agy?.lastLimit ?? null, updatedAt: raw?.agy?.updatedAt ?? null },
  };
  let deepseek = { configured: false };
  let persistTimer = null;
  let pushTimer = null;
  let lastPushAt = 0;
  let lastSig = '';
  let lastRefreshAt = 0;
  let refreshing = null;

  const prune = () => {
    const keys = Object.keys(state.days).sort();
    for (const k of keys.slice(0, Math.max(0, keys.length - KEEP_DAYS))) delete state.days[k];
  };
  const persistNow = () => {
    if (persistTimer) { clearTimeoutFn(persistTimer); persistTimer = null; }
    prune();
    try { writeJsonAtomic(file, { version: 1, ...state }, fsx); } catch { /* best effort */ }
  };
  const schedulePersist = () => {
    if (persistTimer) return;
    persistTimer = setTimeoutFn(persistNow, persistMs);
    persistTimer?.unref?.();
  };
  const bucket = () => {
    const k = dayKey(now());
    const b = (state.days[k] ??= {});
    b.claude = { ...emptyClaude(), ...(b.claude ?? {}) };
    b.agy = { ...emptyAgy(), ...(b.agy ?? {}) };
    b.deepseek = { ...emptyTokens(), ...(b.deepseek ?? {}) };
    b.opencode = { ...emptyTokens(), ...(b.opencode ?? {}) };
    return b;
  };

  /** Windows whose reset time is in the past are stale -> null. */
  const freshWindows = () => {
    const t = now();
    const w = state.claude.windows;
    const f = (x) => (x && Number.isFinite(x.resetsAt) && x.resetsAt > t ? { ...x } : null);
    return { five_hour: f(w.five_hour), seven_day: f(w.seven_day) };
  };

  function snapshot() {
    const b = bucket();
    const t = now();
    const out = {
      at: t,
      claude: { windows: freshWindows(), today: { ...b.claude }, lastLimit: state.claude.lastLimit, updatedAt: state.claude.updatedAt },
      agy: { today: { ...b.agy }, lastLimit: state.agy.lastLimit, updatedAt: state.agy.updatedAt },
      opencode: { today: { ...b.opencode } },
      deepseek: { today: { ...b.deepseek }, configured: !!deepseek.configured, ...(deepseek.balance ? { balance: deepseek.balance } : {}), ...(deepseek.updatedAt ? { updatedAt: deepseek.updatedAt } : {}) },
    };
    return out;
  }

  const sigOf = (s) => JSON.stringify({ ...s, at: 0 });
  function notify() {
    schedulePersist();
    const sig = sigOf(snapshot());
    if (sig === lastSig) return;
    const wait = lastPushAt + PUSH_MS - now();
    const fire = () => {
      pushTimer = null;
      const s = snapshot();
      lastSig = sigOf(s);
      lastPushAt = now();
      try { push(s); } catch { /* ignore */ }
    };
    if (wait <= 0) fire();
    else if (!pushTimer) { pushTimer = setTimeoutFn(fire, wait); pushTimer?.unref?.(); }
  }

  async function refreshDeepseek(force = false) {
    try {
      const st = await services.deepseek?.status?.(force);
      if (st) deepseek = { configured: !!st.configured, balance: st.balance, updatedAt: st.updatedAt };
    } catch { /* ignore */ }
  }

  /** Merge limit/rate-limit/result events. meta.agent = the agent that produced the turn (per-turn override by the runner). */
  function onAgentEvent(projectId, ev, meta) {
    if (!ev || typeof ev !== 'object') return;
    const agent = meta?.agent ?? ev.agent ?? getProject(projectId)?.agent ?? 'claude';
    if (ev.type === 'rate-limit' && ev.windows && typeof ev.windows === 'object') {
      let changed = false;
      for (const k of ['five_hour', 'seven_day']) {
        const w = ev.windows[k];
        if (w && Number.isFinite(w.utilization) && Number.isFinite(w.resetsAt)) {
          // resetsAt arrives in epoch SECONDS in the raw event and is normalised to ms by the contract; accept both.
          const resetsAt = w.resetsAt < 1e12 ? w.resetsAt * 1000 : w.resetsAt;
          state.claude.windows[k] = { utilization: w.utilization, resetsAt, status: w.status ?? statusFor(w.utilization) };
          changed = true;
        }
      }
      if (changed) { state.claude.updatedAt = now(); notify(); }
    } else if (ev.type === 'limit') {
      const info = {
        at: now(), kind: ev.kind ?? 'unknown', status: ev.status === 'rejected' ? 'rejected' : 'warning',
        ...(Number.isFinite(ev.resetsAt) ? { resetsAt: ev.resetsAt } : {}),
        ...(Number.isFinite(ev.utilization) ? { utilization: ev.utilization } : {}),
        ...(typeof ev.message === 'string' ? { message: ev.message } : {}), // verbatim
        projectId,
      };
      const la = ev.agent ?? agent;
      const target = la === 'agy' ? state.agy : la === 'opencode' ? (state.opencode ??= { lastLimit: null, updatedAt: null }) : state.claude;
      target.lastLimit = info;
      target.updatedAt = info.at;
      notify();
    } else if (ev.type === 'result') {
      const b = bucket();
      const t = tokensOf(ev.usage);
      if (meta?.route === 'deepseek' || agent === 'opencode') {
        const tb = meta?.route === 'deepseek' ? b.deepseek : b.opencode;
        tb.inputTokens += t.input; tb.outputTokens += t.output; tb.turns += 1;
        if (meta?.route === 'deepseek') refreshDeepseek(true).then(notify).catch(() => {}); // balance after the turn
      } else if (agent === 'agy') {
        b.agy.inputTokens += t.input; b.agy.outputTokens += t.output; b.agy.thinkingTokens += t.thinking; b.agy.turns += 1;
        state.agy.updatedAt = now();
      } else {
        b.claude.costUsd = Math.round((b.claude.costUsd + n0(ev.costUsd)) * 1e6) / 1e6;
        b.claude.inputTokens += t.input; b.claude.outputTokens += t.output; b.claude.turns += 1;
        state.claude.updatedAt = now();
      }
      notify();
    }
  }

  /** `claude -p "/usage"` -> merge windows. At most every 5 minutes unless force. -> {ok, windows?} */
  async function refresh(force = false) {
    if (refreshing) return refreshing;
    if (!force && now() - lastRefreshAt < REFRESH_MS) return { ok: false, error: 'throttled' };
    refreshing = (async () => {
      lastRefreshAt = now();
      try {
        const exe = await health?.findClaude?.();
        if (!exe) return { ok: false, error: 'not-found' };
        const r = await runUsage(exe, ['-p', '/usage', '--output-format', 'text'], { cwd, timeout: 30000 });
        const w = parseUsageText(r.stdout, now());
        if (!w.five_hour && !w.seven_day) return { ok: false, error: 'unparseable' };
        for (const k of Object.keys(w)) state.claude.windows[k] = w[k];
        state.claude.updatedAt = now();
        notify();
        return { ok: true, windows: w };
      } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
    })().finally(() => { refreshing = null; });
    return refreshing;
  }

  return {
    onAgentEvent,
    snapshot,
    async get() {
      refresh(false).catch(() => {}); // background; the push channel delivers the merge
      await refreshDeepseek(false);
      return snapshot();
    },
    refresh,
    flush: persistNow,
    dispose() { if (pushTimer) clearTimeoutFn(pushTimer); persistNow(); },
  };
}

export function create(deps) {
  return createUsage({
    dir: deps.dir, settings: deps.settings, health: deps.health, services: deps.services, getProject: deps.getProject,
    push: (s) => deps.push(CH.evUsage, s),
  });
}
