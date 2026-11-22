// Pure helpers for usage windows, countdowns and limit cards. Text goes through i18n t() (tests set the dictionaries).
import { t } from './i18n.js';

export const WINDOW_KINDS = Object.freeze(['five_hour', 'seven_day']);
export const WARN_AT = 0.8;
/** A limit without a reset time stays "active" this long after it happened. */
export const UNKNOWN_RESET_MS = 30 * 60 * 1000;

const clamp01 = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/** 0..1 -> integer percent 0..100. */
export function percent(u) { return Math.round(clamp01(u) * 100); }
export function percentText(u) { return percent(u) + '%'; }

/** Tone of a usage window: 'red' (rejected or full), 'amber' (>= 80% or warning), else 'ok'. */
export function windowTone(w) {
  if (!w) return 'ok';
  if (w.status === 'rejected' || clamp01(w.utilization) >= 1) return 'red';
  if (w.status === 'allowed_warning' || clamp01(w.utilization) >= WARN_AT) return 'amber';
  return 'ok';
}

/** "2 h 14 min", "45 min", "1 d 3 h" (units localised). ms <= 0 -> "1 min" never "0". */
export function durationText(ms) {
  const total = Math.max(1, Math.ceil((Number(ms) || 0) / 60000));
  const d = Math.floor(total / 1440);
  const hr = Math.floor((total % 1440) / 60);
  const m = total % 60;
  const u = { d: t('usage.unit.d'), h: t('usage.unit.h'), m: t('usage.unit.m') };
  if (d > 0) return d + ' ' + u.d + (hr ? ' ' + hr + ' ' + u.h : '');
  if (hr > 0) return hr + ' ' + u.h + (m ? ' ' + m + ' ' + u.m : '');
  return m + ' ' + u.m;
}

/** "in 2 h 14 min" (or "any moment now" once the time has passed). */
export function countdownText(resetsAt, now = Date.now()) {
  if (!Number.isFinite(resetsAt)) return '';
  const left = resetsAt - now;
  if (left <= 0) return t('usage.nowReset');
  return t('usage.in', { time: durationText(left) });
}

/** Local clock for a reset time: "3:30 PM" today, with the weekday when it is not today. */
export function resetClock(resetsAt, now = Date.now(), lang = 'en') {
  if (!Number.isFinite(resetsAt)) return '';
  const d = new Date(resetsAt);
  const same = new Date(now).toDateString() === d.toDateString();
  const opts = same ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'short', hour: 'numeric', minute: '2-digit' };
  try { return new Intl.DateTimeFormat(lang === 'es' ? 'es' : 'en-US', opts).format(d); } catch { return d.toISOString(); }
}

/** "Resets in 2 h 14 min - 3:30 PM". */
export function resetLine(resetsAt, now = Date.now(), lang = 'en') {
  if (!Number.isFinite(resetsAt)) return t('usage.resetUnknown');
  if (resetsAt <= now) return t('usage.resetDone');
  return t('usage.resetsIn', { time: durationText(resetsAt - now), clock: resetClock(resetsAt, now, lang) });
}

export function windowLabel(kind) { return t('usage.window.' + (WINDOW_KINDS.includes(kind) ? kind : 'five_hour')); }
export function windowShort(kind) { return t('usage.short.' + (WINDOW_KINDS.includes(kind) ? kind : 'five_hour')); }

/** The Claude window with the highest pressure: { kind, window } (rejected first, then the highest utilization) or null. */
export function worstWindow(windows) {
  let best = null;
  for (const kind of WINDOW_KINDS) {
    const w = windows && windows[kind];
    if (!w || !Number.isFinite(w.utilization)) continue;
    const rank = (w.status === 'rejected' ? 2 : 0) + clamp01(w.utilization);
    if (!best || rank > best.rank) best = { kind, window: w, rank };
  }
  return best ? { kind: best.kind, window: best.window } : null;
}

/** Title-bar chip model: { label:'5h 15%', tone:'ok'|'amber'|'red', kind, window } or null when nothing is known. */
export function chipModel(usage) {
  const c = usage && usage.claude;
  const w = worstWindow(c && c.windows);
  if (!w) return null;
  return { label: windowShort(w.kind) + ' ' + percentText(w.window.utilization), tone: windowTone(w.window), kind: w.kind, window: w.window };
}

/** Is a limit record still in force? Rejected limits last until resetsAt (or 30 min when unknown); warnings are never "active". */
export function isLimitActive(limit, now = Date.now()) {
  if (!limit || limit.status !== 'rejected') return false;
  if (Number.isFinite(limit.resetsAt)) return now < limit.resetsAt;
  return Number.isFinite(limit.at) ? now - limit.at < UNKNOWN_RESET_MS : true;
}

export function otherAgent(agent) { return agent === 'agy' ? 'claude' : 'agy'; }

/**
 * Model of a limit card / banner. limit: LimitInfo-like or a 'limit' chat message.
 * -> { kind, severity:'rejected'|'warning', titleKey, title, message|null, resetsAt|null, agent, switchTo, percent|null, warnText }
 */
export function limitCardModel(limit, agent, now = Date.now()) {
  const l = limit || {};
  const kind = ['five_hour', 'seven_day', 'quota'].includes(l.kind) ? l.kind : 'quota';
  const severity = l.status === 'warning' ? 'warning' : 'rejected';
  const ag = l.agent || agent || 'claude';
  const pct = Number.isFinite(l.utilization) ? percent(l.utilization) : null;
  const winName = t('usage.limit.windowName.' + kind);
  return {
    kind, severity, agent: ag, switchTo: otherAgent(ag),
    titleKey: 'usage.limit.title.' + kind,
    title: t('usage.limit.title.' + kind),
    message: typeof l.message === 'string' && l.message.trim() ? l.message : null,
    resetsAt: Number.isFinite(l.resetsAt) ? l.resetsAt : null,
    active: severity === 'rejected' ? isLimitActive({ ...l, status: 'rejected' }, now) : false,
    percent: pct,
    warnText: pct != null ? t('usage.limit.warn', { percent: pct + '%', window: winName }) : t('usage.limit.warnNoPct', { window: winName }),
  };
}

/** Banner for the active project: its agent hit a limit that is still in force (usage snapshot), else null. */
export function limitBanner(project, usage, now = Date.now()) {
  if (!project || !usage) return null;
  const side = usage[project.agent];
  const lim = side && side.lastLimit;
  if (!isLimitActive(lim, now)) return null;
  return limitCardModel({ ...lim, agent: project.agent }, project.agent, now);
}

/** Tokens like 12345 -> "12.3k". */
export function compactNumber(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(v >= 1e4 ? 0 : 1) + 'k';
  return String(Math.round(v));
}

export function costText(usd) {
  const v = Number(usd) || 0;
  return '$' + (v >= 1 ? v.toFixed(2) : v.toFixed(v >= 0.01 ? 3 : 4));
}
