// In-app sign-in manager. One session per agent.
//  claude: `claude auth login [flag] [--email e]` over pipes (prints URL + 'Paste code here' prompt; the CLI opens the browser itself).
//  agy:    `agy` with no args in a PTY (@lydell/node-pty, loaded lazily); the renderer shows it in xterm.js.
// Credentials are never read or stored here; tokens stay in the CLIs' own stores.
import { spawn as nodeSpawn } from 'node:child_process';
import os from 'node:os';
import { extractFirstUrl, stripAnsi, parseClaudeAuthStatus, isAgyLoggedInOutput, isOpencodeLoggedInOutput } from './auth-check.js';
import { runCommand } from './run.js';
import { killTree as defaultKillTree } from './agents/base.js';

export const KIND_FLAGS = Object.freeze({ claudeai: '--claudeai', console: '--console', sso: '--sso' });
export const LIMITS = Object.freeze({
  claudeInput: 4096, ptyInput: 8192, email: 254, minCols: 20, maxCols: 300, minRows: 5, maxRows: 100,
  pollMs: 2000, killDelayMs: 1000, timeoutMs: 15 * 60 * 1000, bufferChars: 4096,
});
const EMAIL_RE = /^[A-Za-z0-9][A-Za-z0-9._%+-]*@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

export const isValidEmail = (e) => typeof e === 'string' && e.length > 0 && e.length <= LIMITS.email && EMAIL_RE.test(e);
const clamp = (n, lo, hi, dflt) => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt);

/** Builds the argv for `claude auth login` from renderer-supplied options (only kind + email are ever used). */
export function buildClaudeLoginArgs(opts = {}) {
  const kind = opts.kind ?? 'claudeai';
  if (!Object.prototype.hasOwnProperty.call(KIND_FLAGS, kind)) throw new TypeError('invalid kind');
  const args = ['auth', 'login', KIND_FLAGS[kind]];
  if (opts.email !== undefined && opts.email !== null && opts.email !== '') {
    if (!isValidEmail(opts.email)) throw new TypeError('invalid email');
    args.push('--email', opts.email);
  }
  return args;
}

async function loadPtySpawn() {
  const mod = await import('@lydell/node-pty');
  const spawn = mod.spawn ?? mod.default?.spawn;
  if (typeof spawn !== 'function') throw new Error('node-pty spawn missing');
  return spawn;
}

export function createLoginManager({
  resolveCli, spawn = nodeSpawn, ptySpawn = null, run = runCommand, emit = () => {}, checkStatus: checkOverride = null,
  setIntervalFn = (...a) => setInterval(...a), clearIntervalFn = (...a) => clearInterval(...a),
  setTimeoutFn = (...a) => setTimeout(...a), clearTimeoutFn = (...a) => clearTimeout(...a),
  killTree = defaultKillTree, homedir = () => os.homedir(), env = process.env, timeoutMs = LIMITS.timeoutMs,
} = {}) {
  const sessions = new Map(); // agent -> session
  const known = { claude: null, agy: null, opencode: null }; // last conclusive status per agent
  const tokens = { claude: 0, agy: 0, opencode: 0 };
  const send = (s, evt) => { if (sessions.get(s.agent) === s && !s.cancelled) { try { emit({ agent: s.agent, ...evt }); } catch { /* ignore */ } } };

  async function checkAgent(agent) {
    if (checkOverride) return checkOverride(agent);
    const cli = await resolveCli(agent);
    if (!cli) return { loggedIn: false };
    if (agent === 'claude') {
      const r = await run(cli, ['auth', 'status'], { timeout: 10000 });
      const st = parseClaudeAuthStatus(r.stdout);
      known.claude = st.loggedIn;
      return st;
    }
    if (agent === 'opencode') {
      const ro = await run(cli, ['auth', 'list'], { timeout: 10000 });
      const vo = isOpencodeLoggedInOutput(`${ro.stdout}
${ro.stderr}`);
      if (vo !== null) known.opencode = vo;
      return { loggedIn: vo };
    }
    const r = await run(cli, ['models'], { timeout: 15000 });
    const v = isAgyLoggedInOutput(`${r.stdout}\n${r.stderr}`);
    if (v !== null) known.agy = v;
    return { loggedIn: v };
  }

  function teardown(s, { kill }) {
    s.cancelled = s.cancelled || kill === 'cancel';
    if (s.poll) { clearIntervalFn(s.poll); s.poll = null; }
    if (s.timer) { clearTimeoutFn(s.timer); s.timer = null; }
    if (s.killTimer) { clearTimeoutFn(s.killTimer); s.killTimer = null; }
    if (kill) {
      try { if (s.mode === 'pty') s.proc.kill(); else killTree(s.proc); } catch { /* ignore */ }
    }
    if (sessions.get(s.agent) === s) sessions.delete(s.agent);
  }

  function cancel(agent) {
    const s = sessions.get(agent);
    if (s) teardown(s, { kill: 'cancel' });
  }

  async function startClaude(agent, opts, token) {
    const args = buildClaudeLoginArgs(opts);
    const cli = await resolveCli(agent);
    if (token !== tokens[agent]) return { ok: false, mode: 'pipe', error: 'superseded' };
    if (!cli) { emit({ agent, kind: 'error', text: 'not-found' }); return { ok: false, mode: 'pipe', error: 'not-found' }; }
    let child;
    try {
      child = spawn(cli, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });
    } catch (e) {
      emit({ agent, kind: 'error', text: String(e?.message ?? e) });
      return { ok: false, mode: 'pipe', error: 'spawn-failed' };
    }
    const s = { startedAt: Date.now(), agent, mode: 'pipe', proc: child, cancelled: false, urls: new Set(), prompted: false };
    sessions.set(agent, s);
    s.timer = setTimeoutFn(() => { send(s, { kind: 'error', text: 'timeout' }); teardown(s, { kill: 'timeout' }); }, timeoutMs);
    const onText = (buf) => (chunk) => {
      buf.s += stripAnsi(String(chunk));
      const lines = buf.s.split(/\r?\n/);
      buf.s = lines.pop();
      for (const line of lines) scanLine(s, line, true);
      if (buf.s.length > 8192) buf.s = buf.s.slice(-4096);
      scanLine(s, buf.s, false); // the prompt has no trailing newline
    };
    child.stdout?.on('data', onText({ s: '' }));
    child.stderr?.on('data', onText({ s: '' }));
    child.stdin?.on?.('error', () => {});
    child.on('error', (e) => { send(s, { kind: 'error', text: String(e?.message ?? e) }); teardown(s, { kill: null }); });
    child.on('close', async () => {
      if (sessions.get(agent) !== s || s.cancelled) return;
      teardown(s, { kill: null });
      let st = { loggedIn: false };
      try { st = await checkAgent('claude'); } catch { /* keep false */ }
      if (tokens[agent] === token) emit({ agent, kind: 'done', ok: !!st.loggedIn, loggedIn: !!st.loggedIn });
    });
    return { ok: true, mode: 'pipe' };
  }

  function scanLine(s, line, complete) {
    if (!s.prompted && /paste code/i.test(line)) { s.prompted = true; send(s, { kind: 'prompt', text: line.trim() }); }
    if (!complete) return;
    const url = extractFirstUrl(line);
    if (url && !s.urls.has(url)) { s.urls.add(url); send(s, { kind: 'url', url }); }
  }

  async function startAgy(agent, opts, token) {
    const cli = await resolveCli(agent);
    if (token !== tokens[agent]) return { ok: false, mode: 'pty', error: 'superseded' };
    if (!cli) { emit({ agent, kind: 'error', text: 'not-found' }); return { ok: false, mode: 'pty', error: 'not-found' }; }
    let spawnPty = ptySpawn;
    if (!spawnPty) {
      try { spawnPty = await loadPtySpawn(); } catch {
        emit({ agent, kind: 'error', text: 'terminal-unavailable' });
        return { ok: false, mode: 'pty', error: 'terminal-unavailable' };
      }
      if (token !== tokens[agent]) return { ok: false, mode: 'pty', error: 'superseded' };
    }
    const cols = clamp(opts.cols, LIMITS.minCols, LIMITS.maxCols, 100);
    const rows = clamp(opts.rows, LIMITS.minRows, LIMITS.maxRows, 30);
    let pty;
    try {
      pty = spawnPty(cli, agent === 'opencode' ? ['auth', 'login'] : [], { name: 'xterm-256color', cols, rows, cwd: homedir(), env: { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } });
    } catch (e) {
      emit({ agent, kind: 'error', text: 'terminal-unavailable' });
      return { ok: false, mode: 'pty', error: String(e?.message ?? e) };
    }
    const s = { startedAt: Date.now(), agent, mode: 'pty', proc: pty, cancelled: false, urls: new Set(), tail: '', lastLoggedIn: undefined, inflight: false, finished: false };
    sessions.set(agent, s);
    s.timer = setTimeoutFn(() => { send(s, { kind: 'error', text: 'timeout' }); teardown(s, { kill: 'timeout' }); }, timeoutMs);

    pty.onData((data) => {
      if (s.finished && s.cancelled) return;
      send(s, { kind: 'data', data });
      s.tail = (s.tail + stripAnsi(data)).slice(-LIMITS.bufferChars);
      // only trust a URL once whitespace follows it, so a token split across chunks is never emitted truncated
      const url = /https:\/\/\S+\s/.test(s.tail) ? extractFirstUrl(s.tail) : null;
      if (url && !s.urls.has(url)) { s.urls.add(url); send(s, { kind: 'url', url }); }
    });
    pty.onExit(async () => {
      if (sessions.get(agent) !== s || s.cancelled || s.finished) return;
      teardown(s, { kill: null });
      let lg = s.lastLoggedIn;
      try { const st = await checkAgent(agent); if (st.loggedIn !== null) lg = st.loggedIn; } catch { /* keep */ }
      if (tokens[agent] === token && !s.cancelled) emit({ agent, kind: 'done', ok: !!lg, loggedIn: !!lg });
    });
    s.poll = setIntervalFn(async () => {
      if (s.inflight || s.finished || s.cancelled || sessions.get(agent) !== s) return;
      s.inflight = true;
      try {
        const st = await checkAgent(agent);
        if (st.loggedIn === null || st.loggedIn === undefined || s.finished || s.cancelled || sessions.get(agent) !== s) return;
        if (st.loggedIn !== s.lastLoggedIn) {
          s.lastLoggedIn = st.loggedIn;
          send(s, { kind: 'status', loggedIn: st.loggedIn });
          if (st.loggedIn) {
            s.finished = true;
            if (s.poll) { clearIntervalFn(s.poll); s.poll = null; }
            send(s, { kind: 'done', ok: true, loggedIn: true });
            s.killTimer = setTimeoutFn(() => { s.killTimer = null; teardown(s, { kill: 'finished' }); }, LIMITS.killDelayMs);
          }
        }
      } catch { /* try again next tick */ } finally { s.inflight = false; }
    }, LIMITS.pollMs);
    return { ok: true, mode: 'pty' };
  }

  async function start(agent, opts = {}) {
    if (agent !== 'claude' && agent !== 'agy' && agent !== 'opencode') throw new TypeError('invalid agent');
    cancel(agent);
    const token = ++tokens[agent];
    return agent === 'claude' ? startClaude(agent, opts ?? {}, token) : startAgy(agent, opts ?? {}, token);
  }

  function input(agent, data) {
    const s = sessions.get(agent);
    if (!s || s.cancelled || typeof data !== 'string') return;
    try {
      if (s.mode === 'pipe') {
        const code = data.replace(/[\r\n]/g, '').slice(0, LIMITS.claudeInput);
        if (code) s.proc.stdin.write(`${code}\n`);
      } else if (!s.finished) {
        s.proc.write(data.slice(0, LIMITS.ptyInput));
      }
    } catch { /* process gone */ }
  }

  function resize(agent, cols, rows) {
    const s = sessions.get(agent);
    if (!s || s.mode !== 'pty' || s.finished) return;
    try { s.proc.resize(clamp(cols, LIMITS.minCols, LIMITS.maxCols, 100), clamp(rows, LIMITS.minRows, LIMITS.maxRows, 30)); } catch { /* ignore */ }
  }

  async function status() {
    const [c, a, o] = await Promise.all([checkAgent('claude').catch(() => ({ loggedIn: false })), checkAgent('agy').catch(() => ({ loggedIn: null })), checkAgent('opencode').catch(() => ({ loggedIn: null }))]);
    return { claude: { ...c, loggedIn: !!c.loggedIn }, agy: { loggedIn: a.loggedIn ?? known.agy ?? false }, opencode: { loggedIn: o.loggedIn ?? known.opencode ?? false } };
  }

  async function logout(agent) {
    if (agent === 'agy' || agent === 'opencode') return { ok: false, error: 'use-terminal' };
    if (agent !== 'claude') throw new TypeError('invalid agent');
    const cli = await resolveCli('claude');
    if (!cli) return { ok: false, error: 'not-found' };
    cancel('claude');
    await run(cli, ['auth', 'logout'], { timeout: 15000 });
    const st = await checkAgent('claude').catch(() => ({ loggedIn: true }));
    return st.loggedIn ? { ok: false, error: 'still-logged-in' } : { ok: true };
  }

  function cancelAll() { for (const a of [...sessions.keys()]) cancel(a); }

  return { start, input, resize, cancel, cancelAll, status, logout, isOpen: (a) => sessions.has(a),
    /** Open sign-in sessions (tasks service). */
    sessions: () => [...sessions.values()].map((s) => ({ agent: s.agent, mode: s.mode, startedAt: s.startedAt })) };
}
