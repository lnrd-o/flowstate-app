import { spawn as nodeSpawn } from 'node:child_process';
import { createNdjsonParser } from '../../shared/events.js';
import { spawnEnv } from '../platform.js';
import { mergeEnv } from './routes.js';

/**
 * Kill a child and its whole process tree.
 *  win32: taskkill /T /F.
 *  posix: SIGTERM to the process GROUP (-pid; works because FlowState spawns its agent/dashboard/remote children with
 *  detached:true, which makes each one a group leader), falling back to the single pid if no such group exists
 *  (child not spawned detached). If the child is still alive after graceMs, SIGKILL the group (then the pid).
 */
export function killTree(child, {
  spawn = nodeSpawn, platform = process.platform, kill = process.kill.bind(process), graceMs = 2000,
  setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout,
} = {}) {
  if (!child || child.exitCode !== null || !child.pid) return;
  if (platform === 'win32') {
    try {
      const k = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false });
      k.on('error', () => { try { child.kill(); } catch { /* ignore */ } });
    } catch { try { child.kill(); } catch { /* ignore */ } }
    return;
  }
  const send = (sig) => {
    try { kill(-child.pid, sig); return; } catch { /* no such group */ }
    try { child.kill(sig); } catch { /* already gone */ }
  };
  send('SIGTERM');
  const timer = setTimeoutFn(() => {
    if (child.exitCode === null && child.signalCode == null) send('SIGKILL');
  }, graceMs);
  timer?.unref?.();
  child.once?.('exit', () => clearTimeoutFn(timer));
}

/** Options every long-lived child spawn should use: own process group on posix (so killTree can signal the group), augmented PATH. */
export function childSpawnOptions({ platform = process.platform } = {}) {
  return { shell: false, windowsHide: true, detached: platform !== 'win32', env: spawnEnv(platform) };
}

/**
 * Base adapter. Subclasses implement buildArgs(project, text) and may override stdinPayload / closeStdinOnResult /
 * augment. `launcher` = { command, baseArgs? } so tests can point at `node fake-agent.js`.
 */
export class AgentAdapter {
  constructor(name, normalizer) {
    this.name = name;
    this.normalize = normalizer;
    this.closeStdinOnResult = false;
  }

  buildArgs() { throw new Error('not implemented'); }
  stdinPayload() { return null; }
  /** Final prompt text (agy appends image path lines). */
  prepareText(text) { return text; }
  augment(ev) { return ev; }

  buildCommand(project, text, launcher) {
    return { command: launcher.command, args: [...(launcher.baseArgs ?? []), ...this.buildArgs(project, text)] };
  }

  /** Starts the child. Returns { child, done: Promise<{code, resultSeen, ok, stopped}>, stop() }. */
  run({ project, text, launcher, emit, onSession, images = [], spawn = nodeSpawn, kill = killTree, env }) {
    const { command, args } = this.buildCommand(project, this.prepareText(text, images), launcher);
    let stopped = false;
    let resultSeen = false;
    let ok = false;
    let finished = false;
    const stderrLines = [];

    const opts = childSpawnOptions();
    // PWD must match cwd: some CLIs (opencode) take their working folder from $PWD, which otherwise is FlowState's own folder.
    opts.env = { ...(opts.env ?? process.env), PWD: project.path };
    // env: per-turn extra variables (e.g. a route's API key) merged into THIS child's environment only.
    if (env) opts.env = mergeEnv(opts.env, env);
    const child = spawn(command, args, { cwd: project.path, ...opts, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin?.on?.('error', () => {});

    const handle = (obj) => {
      for (const raw of this.normalize(obj)) {
        const ev = this.augment(raw);
        if (ev.type === 'session' && ev.sessionId && onSession) onSession(ev.sessionId);
        if (ev.type === 'result') {
          resultSeen = true; ok = !!ev.ok;
          if (this.closeStdinOnResult) { try { child.stdin?.end(); } catch { /* ignore */ } }
        }
        emit(ev);
      }
    };
    const parseOut = createNdjsonParser(handle, (line) => emit({ type: 'error', kind: 'parse', message: `Unparseable output: ${line.slice(0, 200)}` }));
    let errBuf = '';

    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout?.on('data', parseOut);
    child.stderr?.on('data', (d) => {
      errBuf += d;
      let i;
      while ((i = errBuf.indexOf('\n')) >= 0) { const l = errBuf.slice(0, i).trim(); errBuf = errBuf.slice(i + 1); if (l) stderrLines.push(l); }
    });

    const payload = this.stdinPayload(text, images);
    try {
      if (payload) child.stdin.write(payload);
      else child.stdin.end();
    } catch { /* ignore */ }

    const done = new Promise((resolve) => {
      const finish = (code, spawnErr) => {
        if (finished) return;
        finished = true;
        if (errBuf.trim()) stderrLines.push(errBuf.trim());
        const stderr = stderrLines.join('\n').slice(-4000);
        if (spawnErr) {
          emit({ type: 'error', kind: 'process', message: `Could not start ${this.name}: ${spawnErr.message}`, stderr });
        } else if (stopped) {
          if (!resultSeen) emit({ type: 'result', ok: false, text: 'Stopped by user', stopped: true });
        } else if (code !== 0 && !resultSeen) {
          emit({ type: 'error', kind: 'process', message: `${this.name} exited with code ${code}${stderr ? `: ${stderr.split('\n').slice(-1)[0]}` : ''}`, code, stderr });
        }
        resolve({ code, resultSeen, ok, stopped });
      };
      child.on('error', (e) => finish(-1, e));
      child.on('close', (code) => finish(code));
    });

    return { child, done, stop() { stopped = true; kill(child); } };
  }
}
