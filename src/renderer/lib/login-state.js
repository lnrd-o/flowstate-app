// Pure state for the in-app sign-in flow. LoginEvents (see src/shared/ipc.js Phase 4) reduce into a per-agent view state.
// phase: 'idle' (nothing running) | 'starting' (login.start sent) | 'waiting' (running, URL/prompt/terminal shown) | 'success' | 'error'

export const AGENTS = ['claude', 'agy', 'opencode'];
export const MAX_BUFFER = 200000;

export function createLoginView() {
  return { phase: 'idle', url: null, prompt: false, error: '', loggedIn: null, mode: null, codeSent: false };
}

const active = (v) => v.phase === 'starting' || v.phase === 'waiting';

/** login.start was requested (resets the previous attempt). */
export function startLogin(view) {
  return { ...createLoginView(), loggedIn: view.loggedIn, phase: 'starting' };
}

/** login.start resolved: ok:false -> error, ok:true -> waiting for events. */
export function startResult(view, res) {
  if (res && res.ok === false) return { ...view, phase: 'error', error: String(res.error || 'start-failed') };
  return { ...view, phase: view.phase === 'starting' ? 'waiting' : view.phase, mode: (res && res.mode) || view.mode };
}

/** The user cancelled (or closed the dialog): back to idle. */
export function cancelLogin(view) {
  return { ...createLoginView(), loggedIn: view.loggedIn };
}

/**
 * Reduce one LoginEvent for the view of ev.agent. Never throws; unknown kinds are ignored.
 * 'data' events do not change the view (the terminal consumes them) except to move starting -> waiting.
 */
export function reduceLoginEvent(view, ev) {
  if (!ev || typeof ev !== 'object') return view;
  switch (ev.kind) {
    case 'url':
      if (!ev.url || !active(view)) return view;
      return { ...view, url: String(ev.url), phase: 'waiting' };
    case 'prompt':
      return active(view) ? { ...view, prompt: true, phase: 'waiting' } : view;
    case 'data':
      return view.phase === 'starting' ? { ...view, phase: 'waiting' } : view;
    case 'status': {
      const loggedIn = ev.loggedIn === true ? true : ev.loggedIn === false ? false : view.loggedIn;
      if (ev.loggedIn === true && active(view)) return { ...view, loggedIn, phase: 'success', error: '' };
      return loggedIn === view.loggedIn ? view : { ...view, loggedIn };
    }
    case 'done': {
      if (ev.ok === true && ev.loggedIn !== false) return { ...view, loggedIn: true, phase: 'success', error: '' };
      if (view.phase === 'success') return view;
      if (!active(view) && view.phase !== 'error') return view;
      return { ...view, loggedIn: ev.loggedIn === true ? true : ev.loggedIn === false ? false : view.loggedIn, phase: 'error', error: view.error || 'not-signed-in' };
    }
    case 'error':
      return { ...view, phase: 'error', error: String(ev.text || 'error') };
    default:
      return view;
  }
}

/** Append a terminal chunk to a replay buffer, keeping the tail. */
export function appendBuffer(buf, chunk) {
  const next = String(buf || '') + String(chunk || '');
  return next.length > MAX_BUFFER ? next.slice(next.length - MAX_BUFFER) : next;
}

/**
 * Status chip descriptor for a signed-in value (true | false | null/undefined = unknown).
 * @returns {{tone:'green'|'amber'|'muted', key:string}}
 */
export function statusChip(loggedIn) {
  if (loggedIn === true) return { tone: 'green', key: 'login.signedIn' };
  if (loggedIn === false) return { tone: 'amber', key: 'login.signedOut' };
  return { tone: 'muted', key: 'login.unknown' };
}

/** Per-agent signed-in map { claude, agy } (true|false|null) as kept in the store. */
export function createSignedIn() { return { claude: null, agy: null, opencode: null }; }

/** Merge a LoginStatus ({claude:{loggedIn}, agy:{loggedIn}}) into the map. */
export function applyStatus(map, status) {
  if (!status || typeof status !== 'object') return map;
  const next = { ...map };
  for (const a of AGENTS) if (status[a] && typeof status[a].loggedIn === 'boolean') next[a] = status[a].loggedIn;
  return same(map, next) ? map : next;
}

/** Merge Health (claude.loggedIn / agy.loggedIn may be boolean|null|undefined). Unknown values keep the previous one. */
export function applyHealth(map, health) {
  if (!health) return map;
  const next = { ...map };
  for (const a of AGENTS) if (health[a] && typeof health[a].loggedIn === 'boolean') next[a] = health[a].loggedIn;
  return same(map, next) ? map : next;
}

/** Merge a status/done LoginEvent. */
export function applyLoginEvent(map, ev) {
  if (!ev || !AGENTS.includes(ev.agent)) return map;
  if ((ev.kind === 'status' || ev.kind === 'done') && typeof ev.loggedIn === 'boolean') {
    return map[ev.agent] === ev.loggedIn ? map : { ...map, [ev.agent]: ev.loggedIn };
  }
  return map;
}

function same(a, b) { return a.claude === b.claude && a.agy === b.agy && a.opencode === b.opencode; }

/** Error text -> i18n key under login.err.* (unknown -> generic). */
export function errorKey(error) {
  const e = String(error || '');
  if (e === 'terminal-unavailable') return 'login.err.terminalUnavailable';
  if (e === 'use-terminal') return 'login.err.useTerminal';
  if (e === 'not-signed-in') return 'login.err.notSignedIn';
  return null;
}
