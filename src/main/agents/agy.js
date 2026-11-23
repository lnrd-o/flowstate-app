import { spawn as nodeSpawn } from 'node:child_process';
import { AgentAdapter, childSpawnOptions, killTree } from './base.js';
import { NORMALIZERS, createNdjsonParser } from '../../shared/events.js';
import { modelArgs } from './model-spec.js';
import { mergeEnv } from './routes.js';

/** default/acceptEdits -> accept-edits, plan -> plan, auto (explicit "Auto-accept everything") -> auto. */
export function agyModeFor(mode) {
  if (mode === 'auto') return 'auto';
  return mode === 'plan' ? 'plan' : 'accept-edits';
}

/** One stdin line for agy's stream-json input (verified on agy: {"event":"user","message":{"content":"..."}}). */
export function agyInputLine(text) {
  return `${JSON.stringify({ event: 'user', message: { content: String(text) } })}\n`;
}

export const WARM_IDLE_MS = 15 * 60 * 1000;

/**
 * Antigravity adapter.
 *
 * Speed: every `agy -p` start pays ~40 s before the first answer (measured: ~6 s to init, ~30 s until the prompt is accepted).
 * A process started with `--input-format stream-json` stays alive and runs one turn per stdin line; follow-up turns in the
 * same process answered in about half the time. With `warm: true` (the app) the adapter keeps ONE such process per project folder
 * and reuses it while the conversation, model and mode stay the same; it is closed after 15 idle minutes, on Stop, or on quit.
 */
export class AgyAdapter extends AgentAdapter {
  constructor({ warm = false, idleMs = WARM_IDLE_MS } = {}) {
    super('agy', NORMALIZERS.agy);
    this.warm = warm;
    this.idleMs = idleMs;
    this.pool = new Map(); // project path -> warm entry
  }

  /** agy conversation ids are UUIDs. */
  validSession(id) { return typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id); }

  buildArgs(project, text) {
    return [
      '--output-format', 'stream-json',
      ...(project.sessionId ? ['--conversation', project.sessionId] : []),
      ...modelArgs(project),
      '--mode', agyModeFor(project.mode),
      `-p=${text}`, // the value MUST be attached with '='
    ];
  }

  /** Args of a long-lived process (no -p: prompts arrive on stdin). */
  buildWarmArgs(project) {
    return [
      '--output-format', 'stream-json', '--input-format', 'stream-json',
      ...(project.sessionId ? ['--conversation', project.sessionId] : []),
      ...modelArgs(project),
      '--mode', agyModeFor(project.mode),
    ];
  }

  /** agy reads image files itself: one '[Image attached: <absolute path>]' line per image appended to the prompt. */
  prepareText(text, images = []) {
    const lines = images.filter((i) => i?.abs).map((i) => `[Image attached: ${i.abs}]`);
    return lines.length ? `${text}\n\n${lines.join('\n')}` : text;
  }

  // Verified on agy 1.5.14: init always reports permission_mode 'always-proceed' in print mode, but we always
  // pass --mode and `--mode plan` really blocked a file write (it wrote a plan instead). So that label is not
  // a trustworthy signal and no warning is raised. See docs/spikes.md.
  augment(ev) {
    return ev;
  }

  run(opts) {
    const { launcher } = opts;
    // Test launchers (node fake-agent.js ...) and non-warm instances use the classic one-process-per-turn path.
    if (!this.warm || (launcher?.baseArgs && launcher.baseArgs.length)) return super.run(opts);
    return this.runWarm(opts);
  }

  runWarm({ project, text, launcher, emit, onSession, images = [], spawn = nodeSpawn, kill = killTree, env }) {
    const key = project.path;
    const sig = JSON.stringify([launcher.command, project.mode ? agyModeFor(project.mode) : '', project.model ?? null, project.effort ?? null, env ?? null]);
    let w = this.pool.get(key);
    const reusable = w && !w.busy && !w.closed && w.sig === sig && !!project.sessionId && w.conversationId === project.sessionId;
    if (w && !reusable) { this.closeEntry(w, kill); w = null; }
    if (!w) w = this.spawnEntry({ project, launcher, spawn, kill, env, sig });

    clearTimeout(w.idleTimer);
    w.busy = true;
    let resolveDone;
    const done = new Promise((r) => { resolveDone = r; });
    w.turn = { emit, onSession, resolve: resolveDone, resultSeen: false, ok: false, stopped: false };
    try { w.child.stdin.write(agyInputLine(this.prepareText(text, images))); } catch { /* close handler reports it */ }
    const entry = w;
    return {
      child: w.child,
      done,
      stop: () => { if (entry.turn) entry.turn.stopped = true; this.closeEntry(entry, kill); },
    };
  }

  spawnEntry({ project, launcher, spawn, kill, env, sig }) {
    const opts = childSpawnOptions();
    opts.env = { ...(opts.env ?? process.env), PWD: project.path }; // keep $PWD = cwd (see base.js)
    if (env) opts.env = mergeEnv(opts.env, env);
    const args = [...(launcher.baseArgs ?? []), ...this.buildWarmArgs(project)];
    const child = spawn(launcher.command, args, { cwd: project.path, ...opts, stdio: ['pipe', 'pipe', 'pipe'] });
    const w = { key: project.path, sig, child, busy: false, closed: false, turn: null, conversationId: project.sessionId ?? null, idleTimer: null, stderr: [], kill };
    child.stdin?.on?.('error', () => {});

    const handle = (obj) => {
      for (const raw of this.normalize(obj)) {
        const ev = this.augment(raw);
        const t = w.turn;
        if (ev.type === 'session' && ev.sessionId) {
          w.conversationId = ev.sessionId;
          if (t?.onSession) t.onSession(ev.sessionId);
        }
        if (!t) continue; // output between turns (should not happen): nobody to show it to
        t.emit(ev);
        if (ev.type === 'result') {
          t.resultSeen = true; t.ok = !!ev.ok;
          this.endTurn(w, { code: 0, resultSeen: true, ok: t.ok, stopped: false });
        }
      }
    };
    const parse = createNdjsonParser(handle, (line) => w.turn?.emit({ type: 'error', kind: 'parse', message: `Unparseable output: ${line.slice(0, 200)}` }));
    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout?.on('data', parse);
    child.stderr?.on('data', (d) => { w.stderr.push(String(d)); if (w.stderr.length > 50) w.stderr.shift(); });
    const finish = (code, spawnErr) => {
      if (w.closed && !w.turn) { this.forget(w); return; }
      w.closed = true;
      this.forget(w);
      const t = w.turn;
      if (!t) return;
      const stderr = w.stderr.join('').trim().slice(-4000);
      if (spawnErr) t.emit({ type: 'error', kind: 'process', message: `Could not start agy: ${spawnErr.message}`, stderr });
      else if (t.stopped) t.emit({ type: 'result', ok: false, text: 'Stopped by user', stopped: true });
      else if (!t.resultSeen) t.emit({ type: 'error', kind: 'process', message: `agy exited with code ${code}${stderr ? `: ${stderr.split('\n').slice(-1)[0]}` : ''}`, code, stderr });
      this.endTurn(w, { code: spawnErr ? -1 : code, resultSeen: t.resultSeen, ok: t.ok, stopped: t.stopped });
    };
    child.on('error', (e) => finish(-1, e));
    child.on('close', (code) => finish(code));
    this.pool.set(w.key, w);
    return w;
  }

  endTurn(w, result) {
    const t = w.turn;
    w.turn = null;
    w.busy = false;
    if (t) t.resolve(result);
    if (!w.closed) {
      clearTimeout(w.idleTimer);
      w.idleTimer = setTimeout(() => this.closeEntry(w, w.kill), this.idleMs);
      w.idleTimer.unref?.();
    }
  }

  forget(w) {
    clearTimeout(w.idleTimer);
    if (this.pool.get(w.key) === w) this.pool.delete(w.key);
  }

  closeEntry(w, kill = killTree) {
    if (!w) return;
    this.forget(w);
    w.closed = true;
    try { w.child.stdin?.end(); } catch { /* ignore */ }
    try { kill(w.child); } catch { /* ignore */ }
  }

  /** Close every warm process (app quit). */
  dispose() { for (const w of [...this.pool.values()]) this.closeEntry(w, w.kill); }
}
