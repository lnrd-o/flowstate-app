// Integrated terminal: one interactive shell per project, started in the project folder (PowerShell on Windows, $SHELL elsewhere).
// It is the user's own console, started only when they open the Terminal tab. Output is kept (last 200 KB) so the tab can re-attach.
import { CH } from '../../shared/ipc.js';
import { spawnEnv } from '../platform.js';

export const MAX_BUFFER = 200 * 1024;
export const LIMITS = Object.freeze({ minCols: 20, maxCols: 400, minRows: 5, maxRows: 200, input: 16 * 1024 });
const clamp = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : d; };

/** Shell program + args for a platform. */
export function shellFor(platform = process.platform, env = process.env) {
  if (platform === 'win32') return { file: 'powershell.exe', args: ['-NoLogo'] };
  const sh = typeof env.SHELL === 'string' && env.SHELL.startsWith('/') ? env.SHELL : '/bin/bash';
  return { file: sh, args: [] };
}

async function loadPtySpawn() {
  const mod = await import('@lydell/node-pty');
  const spawn = mod.spawn ?? mod.default?.spawn;
  if (typeof spawn !== 'function') throw new Error('node-pty spawn missing');
  return spawn;
}

export function create({ projects, push = () => {}, ptySpawn = null, platform = process.platform }) {
  const sessions = new Map(); // projectId -> { pty, buf, alive }
  const need = (id) => { const p = projects.get(id); if (!p) throw new Error('Unknown project'); return p; };

  const kill = (s) => { try { s.pty.kill(); } catch { /* already gone */ } };

  return {
    /** Start (or re-attach to) the project's shell. -> {ok, shell, buffer, alive} | {ok:false, error} */
    async start(id, { cols, rows } = {}) {
      const p = need(id);
      const have = sessions.get(id);
      if (have && have.alive) {
        try { have.pty.resize(clamp(cols, LIMITS.minCols, LIMITS.maxCols, 100), clamp(rows, LIMITS.minRows, LIMITS.maxRows, 30)); } catch { /* ignore */ }
        return { ok: true, shell: have.shell, buffer: have.buf, alive: true };
      }
      let spawn = ptySpawn;
      try { spawn = spawn ?? await loadPtySpawn(); } catch (e) { return { ok: false, error: 'terminal-unavailable', message: String(e?.message ?? e) }; }
      const sh = shellFor(platform);
      let pty;
      try {
        pty = spawn(sh.file, sh.args, {
          name: 'xterm-256color', cols: clamp(cols, LIMITS.minCols, LIMITS.maxCols, 100), rows: clamp(rows, LIMITS.minRows, LIMITS.maxRows, 30),
          cwd: p.path, env: { ...(spawnEnv(platform) ?? process.env), TERM: 'xterm-256color', COLORTERM: 'truecolor', PWD: p.path },
        });
      } catch (e) { return { ok: false, error: 'start-failed', message: String(e?.message ?? e) }; }
      const s = { pty, buf: '', alive: true, shell: sh.file };
      sessions.set(id, s);
      pty.onData((data) => {
        s.buf = (s.buf + data).slice(-MAX_BUFFER);
        push(CH.evTerm, { projectId: id, kind: 'data', data });
      });
      pty.onExit(({ exitCode } = {}) => {
        s.alive = false;
        if (sessions.get(id) === s) sessions.delete(id);
        push(CH.evTerm, { projectId: id, kind: 'exit', code: exitCode ?? null });
      });
      return { ok: true, shell: sh.file, buffer: '', alive: true };
    },
    input(id, data) {
      const s = sessions.get(id);
      if (!s || !s.alive || typeof data !== 'string') return false;
      try { s.pty.write(data.slice(0, LIMITS.input)); return true; } catch { return false; }
    },
    resize(id, cols, rows) {
      const s = sessions.get(id);
      if (!s || !s.alive) return false;
      try { s.pty.resize(clamp(cols, LIMITS.minCols, LIMITS.maxCols, 100), clamp(rows, LIMITS.minRows, LIMITS.maxRows, 30)); return true; } catch { return false; }
    },
    stop(id) { const s = sessions.get(id); if (s) { sessions.delete(id); kill(s); } return { ok: true }; },
    /** A project removed from the registry: close its shell. */
    onAgentEvent() {},
    dispose() { for (const s of sessions.values()) kill(s); sessions.clear(); },
  };
}
