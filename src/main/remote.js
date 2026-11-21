// Remote control per project.
//  claude: managed long-lived child `claude remote-control --name <project> --permission-mode <mode>` in the project cwd.
//  agy:    `agy remote-control start --session --name <project>` registers a LOGIN-SCOPED daemon (machine-wide, one
//          instance name); stop = `agy remote-control stop`; status = `agy remote-control status`.
// Fallback (claude only): if the CLI needs a real terminal, open a visible console window running it. A console
// window cannot be stopped from FlowState (stop() returns an explanatory error), the user closes the window.
import { spawn as nodeSpawn } from 'node:child_process';
import { runCommand } from './run.js';
import { killTree } from './agents/base.js';

const MODES = { default: 'default', acceptEdits: 'acceptEdits', plan: 'plan' };
const MAX_INFO_LINES = 40;

const cleanName = (n) => {
  const s = String(n ?? '').replace(/[\x00-\x1f\x7f"]/g, ' ').trim().slice(0, 80) || 'FlowState';
  return s.startsWith('-') ? `fs${s}` : s;
};

export function claudeRemoteArgs(project) {
  return ['remote-control', '--name', cleanName(project.name), '--permission-mode', MODES[project.mode] ?? 'default'];
}
export function agyRemoteArgs(project) {
  return ['remote-control', 'start', '--session', '--name', cleanName(project.name)];
}
export const AGY_STOP_ARGS = ['remote-control', 'stop'];
export const AGY_STATUS_ARGS = ['remote-control', 'status'];

/** Maps early-exit output of `claude remote-control` to a stable error code. */
export function classifyFailure(text) {
  if (/not trusted|trust dialog/i.test(text)) return 'workspace-not-trusted';
  if (/\b(tty|terminal|raw mode|stdin is not)\b/i.test(text)) return 'needs-terminal';
  return 'failed';
}

export function parseAgyStatus(text) {
  const t = String(text);
  if (/not (registered|running|started)|stopped|inactive/i.test(t)) return false;
  return /\b(running|active|started|registered)\b/i.test(t);
}

export function createRemote({
  getProject, findExe, spawn = nodeSpawn, kill = killTree, run = runCommand, push = () => {}, settleMs = 2500,
} = {}) {
  const claudeRuns = new Map(); // projectId -> {child, lines, consoleOnly}
  const agyOwners = new Set();  // projects whose start() registered the daemon
  const need = (id) => {
    const p = typeof id === 'string' ? getProject(id) : null;
    if (!p) throw new Error('Unknown project');
    return p;
  };
  const infoOf = (r) => r.lines.join('\n');
  const emit = (projectId, running, info) => push({ projectId, running, ...(info ? { info } : {}) });

  async function openConsole(exe, args, title) {
    await new Promise((resolve, reject) => {
      const c = spawn('cmd.exe', ['/c', 'start', title, exe, ...args], { detached: true, windowsHide: false, stdio: 'ignore', shell: false });
      c.once('error', reject);
      c.once('spawn', () => { c.unref?.(); resolve(); });
    });
  }

  async function startClaude(p) {
    if (claudeRuns.has(p.id)) return { running: true, info: infoOf(claudeRuns.get(p.id)) };
    const exe = await findExe('claude');
    if (!exe) throw new Error('claude executable not found');
    const args = claudeRemoteArgs(p);
    const child = spawn(exe, args, { cwd: p.path, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const rec = { child, lines: [], consoleOnly: false };
    claudeRuns.set(p.id, rec);
    let exited = null;
    let buf = '';
    const take = (d) => {
      buf += String(d);
      let i;
      let changed = false;
      while ((i = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (l.trim() && rec.lines.length < MAX_INFO_LINES) { rec.lines.push(l); changed = true; }
      }
      if (changed) emit(p.id, true, infoOf(rec));
    };
    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    child.stdin?.on?.('error', () => {});
    const earlyExit = new Promise((resolve) => {
      child.once('error', (e) => { exited = { code: -1, text: e.message }; resolve(); });
      child.once('close', (code) => {
        if (buf.trim() && rec.lines.length < MAX_INFO_LINES) rec.lines.push(buf.trim());
        exited = { code, text: infoOf(rec) };
        if (claudeRuns.get(p.id) === rec) claudeRuns.delete(p.id);
        emit(p.id, false, infoOf(rec));
        resolve();
      });
    });
    await Promise.race([earlyExit, new Promise((r) => setTimeout(r, settleMs))]);
    if (!exited) return { running: true, info: infoOf(rec) };
    const code = classifyFailure(exited.text);
    if (code === 'needs-terminal') {
      await openConsole(exe, args, 'FlowState remote control');
      return { running: false, info: 'Opened in a separate console window (close that window to stop).', error: 'needs-terminal', console: true };
    }
    return { running: false, error: code, info: exited.text };
  }

  async function startAgy(p) {
    const exe = await findExe('agy');
    if (!exe) throw new Error('agy executable not found');
    const r = await run(exe, agyRemoteArgs(p), { timeout: 30000 });
    if (r.code !== 0) return { running: false, error: 'failed', info: `${r.stdout}${r.stderr}`.trim().slice(0, 2000) };
    agyOwners.add(p.id);
    const info = `${r.stdout}${r.stderr}`.trim().slice(0, 2000);
    emit(p.id, true, info);
    return { running: true, info };
  }

  return {
    async status(projectId) {
      const p = need(projectId);
      const exe = await findExe(p.agent);
      if (p.agent === 'agy') {
        if (!exe) return { running: false, supported: false };
        const r = await run(exe, AGY_STATUS_ARGS, { timeout: 10000 });
        const text = `${r.stdout}${r.stderr}`.trim();
        return { running: r.code === 0 && parseAgyStatus(text), info: text.slice(0, 2000), supported: true };
      }
      const rec = claudeRuns.get(projectId);
      return { running: !!rec, ...(rec ? { info: infoOf(rec) } : {}), supported: !!exe };
    },
    async start(projectId) {
      const p = need(projectId);
      return p.agent === 'agy' ? startAgy(p) : startClaude(p);
    },
    async stop(projectId) {
      const p = need(projectId);
      if (p.agent === 'agy') {
        const exe = await findExe('agy');
        if (exe) await run(exe, AGY_STOP_ARGS, { timeout: 30000 });
        agyOwners.delete(projectId);
        emit(projectId, false);
        return { running: false };
      }
      const rec = claudeRuns.get(projectId);
      if (rec) { claudeRuns.delete(projectId); kill(rec.child); }
      emit(projectId, false);
      return { running: false };
    },
    /** Project removed: stop whatever we started for it (never touches an agy daemon we did not start). */
    async stopForRemoved(project) {
      const rec = claudeRuns.get(project.id);
      if (rec) { claudeRuns.delete(project.id); kill(rec.child); }
      if (agyOwners.delete(project.id)) {
        const exe = await findExe('agy');
        if (exe) await run(exe, AGY_STOP_ARGS, { timeout: 30000 });
      }
    },
    /** App quit: kill managed claude children. The agy login-scoped daemon is intentionally left running. */
    stopAll() { for (const [id, rec] of [...claudeRuns]) { claudeRuns.delete(id); kill(rec.child); } },
  };
}
