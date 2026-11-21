// Methodology runner: one sequential walk per project, explicit state machine, state pushed on every transition and persisted
// (last run only) to <userData>/runs/<projectId>.json. See 'Runner rules' in src/shared/ipc.js.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { validateMethodology, startNodes, nextNodeId, evalCondition, substitute, ID_RE, LIMITS } from '../shared/methodology.js';
import { writeJsonAtomic, readJson } from './settings.js';
import { resolveInside } from './files.js';

export const CMD_TIMEOUT_MS = 120000;
export const CMD_MAX_OUTPUT = 1024 * 1024;
export const VAR_LIMITS = Object.freeze({ text: 2000, textarea: LIMITS.text, path: 1024, select: 500 });
const PROJECT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SHELL_META_RE = /[;&|<>`\r\n]/;
const DENY_EXE = new Set(['powershell', 'pwsh', 'cmd', 'wscript', 'cscript', 'mshta', 'reg', 'regsvr32', 'rundll32', 'certutil', 'bitsadmin', 'curl', 'wget']);
const DENY_EXT = new Set(['.bat', '.cmd', '.ps1', '.vbs', '.vbe', '.wsf', '.hta', '.lnk', '.msc']);

/** Throws (with a user-facing message) when the exe is not allowed. Pure. */
export function checkExe(exe) {
  if (typeof exe !== 'string' || !exe.trim()) throw new Error('Command executable is empty');
  if (SHELL_META_RE.test(exe)) throw new Error('Command executable contains shell metacharacters; refused');
  const isAbs = path.win32.isAbsolute(exe) || path.posix.isAbsolute(exe);
  if (!isAbs && /[\\/]/.test(exe)) throw new Error('Command executable must be a bare name or an absolute path');
  const base = exe.split(/[\\/]/).pop().toLowerCase();
  const stem = base.replace(/\.(exe|com)$/, '');
  if (DENY_EXE.has(stem) || stem.startsWith('invoke-') || DENY_EXT.has(path.extname(base))) {
    throw new Error(`Blocked: '${stem}' is not allowed in methodologies (they may come from colleagues or imports and could run arbitrary code)`);
  }
  return exe;
}

/** Validate run vars against the methodology declaration. Returns the cleaned vars (with builtins injected). */
export function validateVars(m, input, project) {
  if (input === undefined || input === null) input = {};
  if (typeof input !== 'object' || Array.isArray(input)) throw new TypeError('vars must be an object');
  if (Object.keys(input).length > LIMITS.vars) throw new TypeError('too many vars');
  const out = {};
  for (const v of m.vars ?? []) {
    let val = Object.hasOwn(input, v.key) ? input[v.key] : v.default;
    if (val === undefined || val === null || val === '') {
      if (v.required) throw new Error(`Missing required variable: ${v.key}`);
      if (val === undefined || val === null) continue;
    }
    if (typeof val !== 'string') throw new TypeError(`Variable ${v.key} must be a string`);
    if (val.length > (VAR_LIMITS[v.type] ?? VAR_LIMITS.text)) throw new TypeError(`Variable ${v.key} is too long`);
    if (val.includes('\0')) throw new TypeError(`Variable ${v.key} contains invalid characters`);
    if (v.type === 'select' && val !== '' && !v.options.includes(val)) throw new Error(`Variable ${v.key} must be one of: ${v.options.join(', ')}`);
    out[v.key] = val;
  }
  out.projectName = project.name;
  out.projectPath = project.path;
  return out;
}

function defaultExec(exe, args, { cwd, timeout, maxBuffer, signal }) {
  return new Promise((resolve) => {
    try {
      execFile(exe, args, { cwd, timeout, maxBuffer, signal, shell: false, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), error: err ? (err.killed ? 'timeout or killed' : (err.message ?? '').split('\n')[0]) : null });
      });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: '', error: String(e?.message ?? e) });
    }
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clone = (o) => JSON.parse(JSON.stringify(o));

/**
 * deps: dir (userData), getProject(id), getMethodology(id), agents {send,stop,status}, git {autoCommit}, emit(projectId, RunState),
 * exec (injectable execFile wrapper), fsx, now() ISO, uuid().
 * The host must forward every agent event to runner.onAgentEvent(projectId, event).
 */
export function createRunner({ dir, getProject, getMethodology, agents, git, emit = () => {}, exec = defaultExec, fsx = fs,
  now = () => new Date().toISOString(), uuid = () => crypto.randomUUID(), idleWaitMs = 15000 }) {
  const runsDir = path.join(dir, 'runs');
  const active = new Map(); // projectId -> run
  const fileOf = (projectId) => {
    if (!PROJECT_ID_RE.test(projectId)) throw new TypeError('invalid project id');
    return path.join(runsDir, `${projectId}.json`);
  };

  // A restart ends every run: persisted 'running'/'waiting' runs become 'stopped'.
  try {
    for (const n of fsx.readdirSync(runsDir)) {
      const f = path.join(runsDir, n);
      const s = readJson(f, null, fsx);
      if (s && (s.status === 'running' || s.status === 'waiting')) {
        s.status = 'stopped'; s.endedAt = now(); s.error = 'Interrupted by app restart'; delete s.waiting;
        for (const ns of Object.values(s.nodes ?? {})) if (ns.state === 'running' || ns.state === 'waiting') ns.state = 'skipped';
        try { writeJsonAtomic(f, s, fsx); } catch { /* best effort */ }
      }
    }
  } catch { /* no runs dir yet */ }

  function publish(run) {
    const snap = clone(run.state);
    if (!run.forgotten) try { writeJsonAtomic(fileOf(run.state.projectId), snap, fsx); } catch { /* persistence is best effort */ }
    try { emit(run.state.projectId, snap); } catch { /* ignore */ }
  }
  const setNode = (run, id, patch) => { run.state.nodes[id] = { ...run.state.nodes[id], ...patch }; };
  const finish = (run, status, error) => {
    const s = run.state;
    s.status = status; s.endedAt = now(); s.current = null; delete s.waiting;
    if (error) s.error = error;
    for (const [id, ns] of Object.entries(s.nodes)) {
      if (ns.state === 'running' || ns.state === 'waiting') s.nodes[id] = { ...ns, state: status === 'error' ? 'error' : 'skipped', endedAt: s.endedAt };
      else if (ns.state === 'pending' && status === 'done') s.nodes[id] = { ...ns, state: 'skipped' };
    }
    active.delete(s.projectId);
    publish(run);
  };

  /** Park the run until respond()/stop(). Resolves with the response, or null when stopped. */
  function waitFor(run, nodeId, kind, text, command) {
    run.state.status = 'waiting';
    run.state.waiting = { nodeId, kind, text, ...(command ? { command } : {}) };
    setNode(run, nodeId, { state: 'waiting' });
    publish(run);
    return new Promise((resolve) => { run.waiter = { nodeId, kind, resolve }; }).then((r) => {
      run.waiter = null;
      if (run.cancelled) return null;
      run.state.status = 'running'; delete run.state.waiting;
      setNode(run, nodeId, { state: 'running' });
      return r;
    });
  }

  async function waitIdle(projectId) {
    const end = Date.now() + idleWaitMs;
    while (agents.status(projectId)?.running && Date.now() < end) await sleep(25);
  }

  async function execNode(run, node, project) {
    const vars = run.state.vars;
    const sub = (t) => substitute(t, vars);
    const mark = (state, message) => setNode(run, node.id, { state, ...(message ? { message } : {}), endedAt: now() });
    switch (node.type) {
      case 'prompt': {
        const text = sub(node.text);
        if (!text.trim()) { mark('error', 'Empty prompt'); throw new Error('Prompt is empty'); }
        const req = { projectId: project.id, text };
        if (node.agent === 'claude' || node.agent === 'agy') req.agent = node.agent;
        if (node.mode === 'default' || node.mode === 'acceptEdits' || node.mode === 'plan') req.mode = node.mode;
        const turn = new Promise((resolve) => { run.turn = resolve; });
        try { await agents.send(req); } catch (e) { run.turn = null; mark('error', e.message); throw e; }
        const r = await turn;
        run.turn = null;
        await waitIdle(project.id);
        if (run.cancelled) return undefined;
        if (!r.ok) { const msg = r.text || 'Agent turn failed'; mark('error', msg.slice(0, 300)); throw new Error(msg); }
        mark('done', typeof r.text === 'string' ? r.text.slice(0, 200) : undefined);
        return undefined;
      }
      case 'command': {
        const exe = sub(node.exe);
        const args = node.args.map(sub);
        try { checkExe(exe); } catch (e) { mark('error', e.message); throw e; }
        const ok = await waitFor(run, node.id, 'command-confirm', [exe, ...args].join(' '), { exe, args });
        if (!ok) return undefined;
        if (ok.approve !== true) { run.rejected = true; mark('error', 'Rejected by user'); return undefined; }
        run.abort = new AbortController();
        const r = await exec(exe, args, { cwd: project.path, timeout: CMD_TIMEOUT_MS, maxBuffer: CMD_MAX_OUTPUT, signal: run.abort.signal });
        run.abort = null;
        if (run.cancelled) return undefined;
        if (r.code !== 0) {
          const tail = (r.stderr || r.error || r.stdout || '').trim().split('\n').slice(-1)[0].slice(0, 200);
          mark('error', `Exit code ${r.code}${tail ? `: ${tail}` : ''}`);
          throw new Error(`Command failed (exit ${r.code})`);
        }
        mark('done', (r.stdout || '').trim().split('\n').slice(-1)[0]?.slice(0, 200) || undefined);
        return undefined;
      }
      case 'git-commit': {
        let r;
        try { r = await git.autoCommit(project.path, sub(node.message)); } catch (e) { mark('error', e.message); throw e; }
        if (r.committed) mark('done', 'committed');
        else if (r.reason === 'clean') mark('done', 'nothing to commit');
        else if (r.reason === 'not-repo') mark('warn', 'not a git repository');
        else { mark('error', r.message || r.reason); throw new Error(`Commit failed: ${r.reason}`); }
        return undefined;
      }
      case 'ask-user': {
        const a = await waitFor(run, node.id, 'ask-user', sub(node.question));
        if (!a) return undefined;
        run.state.vars[node.saveAs] = a.answer;
        mark('done');
        return undefined;
      }
      case 'checkpoint': {
        const a = await waitFor(run, node.id, 'checkpoint', sub(node.message));
        if (!a) return undefined;
        if (a.approve !== true) { run.rejected = true; mark('error', 'Rejected by user'); return undefined; }
        mark('done');
        return undefined;
      }
      case 'artifact': {
        let abs;
        try { ({ abs } = resolveInside(project.path, sub(node.path), fsx)); } catch (e) { mark('error', e.message); throw e; }
        if (fsx.existsSync(abs)) mark('done'); else mark('warn', 'missing');
        return undefined;
      }
      case 'condition': {
        const b = evalCondition(node, run.state.vars);
        mark('done', b);
        return b;
      }
      default:
        mark('error', 'Unknown node type');
        throw new Error('Unknown node type');
    }
  }

  async function walk(run, m, project) {
    try {
      let id = startNodes(m)[0].id;
      const seen = new Set();
      while (id && !run.cancelled) {
        if (seen.has(id)) throw new Error('Cycle detected');
        seen.add(id);
        const node = m.nodes.find((n) => n.id === id);
        run.state.current = id;
        setNode(run, id, { state: 'running', startedAt: now() });
        publish(run);
        const branch = await execNode(run, node, project);
        if (run.cancelled || run.rejected) break;
        publish(run);
        id = nextNodeId(m, id, branch);
      }
      if (run.cancelled || run.rejected) finish(run, 'stopped');
      else finish(run, 'done');
    } catch (e) {
      finish(run, run.cancelled ? 'stopped' : 'error', String(e?.message ?? e).slice(0, 500));
    }
  }

  const runner = {
    onAgentEvent(projectId, ev) {
      const run = active.get(projectId);
      if (!run?.turn || !ev) return;
      if (ev.type === 'result') { const t = run.turn; run.turn = null; t({ ok: !!ev.ok, text: ev.text, stopped: !!ev.stopped }); }
      else if (ev.type === 'error' && ev.kind !== 'parse') { const t = run.turn; run.turn = null; t({ ok: false, text: ev.message }); }
    },

    /** -> {runId}. Throws on unknown project/methodology, invalid vars, or when the project already has an active run. */
    run(projectId, methodologyId, vars) {
      const project = getProject(projectId);
      if (!project) throw new Error('Unknown project');
      if (typeof methodologyId !== 'string' || !ID_RE.test(methodologyId)) throw new TypeError('invalid methodology id');
      if (active.has(projectId)) throw new Error('A run is already active for this project');
      const m = getMethodology(methodologyId);
      const errs = validateMethodology(m);
      if (errs.length) throw new Error(`Invalid methodology: ${errs.join('; ')}`);
      const clean = validateVars(m, vars, project);
      const state = {
        runId: uuid(), projectId, methodologyId, status: 'running', vars: clean, current: null, startedAt: now(),
        nodes: Object.fromEntries(m.nodes.map((n) => [n.id, { state: 'pending' }])),
      };
      const run = { state, waiter: null, turn: null, abort: null, cancelled: false, rejected: false };
      active.set(projectId, run);
      publish(run);
      Promise.resolve().then(() => walk(run, m, project));
      return { runId: state.runId };
    },

    respond(runId, nodeId, response) {
      const run = [...active.values()].find((r) => r.state.runId === runId);
      if (!run) throw new Error('No such active run');
      const w = run.waiter;
      if (!w || w.nodeId !== nodeId) throw new Error('The run is not waiting on that node');
      if (!response || typeof response !== 'object') throw new TypeError('response required');
      if (w.kind === 'ask-user') {
        if (typeof response.answer !== 'string' || response.answer.length > LIMITS.text) throw new TypeError('answer must be a string');
        w.resolve({ answer: response.answer });
      } else {
        if (typeof response.approve !== 'boolean') throw new TypeError('approve must be a boolean');
        w.resolve({ approve: response.approve });
      }
    },

    stop(runId) {
      const run = [...active.values()].find((r) => r.state.runId === runId);
      if (!run) return;
      run.cancelled = true;
      run.waiter?.resolve(null);
      run.abort?.abort();
      if (run.turn) { const t = run.turn; run.turn = null; try { agents.stop(run.state.projectId); } catch { /* ignore */ } t({ ok: false, stopped: true }); }
    },

    /** Active run state, else the persisted last run, else null. */
    state(projectId) {
      const run = active.get(projectId);
      if (run) return clone(run.state);
      return readJson(fileOf(projectId), null, fsx);
    },

    /** Project removed: stop its run and forget the persisted state. */
    forgetProject(projectId) {
      const run = active.get(projectId);
      if (run) { run.forgotten = true; runner.stop(run.state.runId); }
      try { fsx.unlinkSync(fileOf(projectId)); } catch { /* none */ }
    },

    stopAll() { for (const r of [...active.values()]) runner.stop(r.state.runId); },
  };
  return runner;
}
