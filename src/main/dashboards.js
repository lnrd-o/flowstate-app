// Streamlit dashboards bound to 127.0.0.1. Python packages: GLOBAL by default; a per-project .venv only when needed/chosen (pythonEnv: auto|global|venv).
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { runCommand } from './run.js';
import { streamProcess } from './proc.js';
import { killTree, childSpawnOptions } from './agents/base.js';
import { pathFor } from './platform.js';
import { resolveInside } from './files.js';

export const PIP_PACKAGES = ['streamlit', 'plotly', 'pandas', 'openpyxl'];
export const PY_MODES = Object.freeze(['auto', 'global', 'venv']);

const normPkg = (n) => String(n).toLowerCase().replace(/[-_.]+/g, '-');

/** Parse `pip list --format json` output -> Map(normalizedName -> version) or null when it is not valid. */
export function parsePipList(stdout) {
  try {
    const a = JSON.parse(String(stdout));
    if (!Array.isArray(a)) return null;
    return new Map(a.filter((x) => x && typeof x.name === 'string').map((x) => [normPkg(x.name), String(x.version ?? '')]));
  } catch { return null; }
}

/** Required packages absent from a Map(name -> version). */
export const missingPackages = (installed, required = PIP_PACKAGES) => required.filter((p) => !installed?.has(normPkg(p)));

/** Pip failures that a project .venv would avoid (no write permission, PEP 668 managed environments). */
export const isEnvPermissionError = (text) => /permission denied|access is denied|externally-managed-environment|errno 13|not writeable|read-only file system/i.test(String(text));

/** Prompts that probably involve Python / data work (cheap gate before probing the interpreter). */
export const PY_HINT = /python|\.py\b|streamlit|plotly|pandas|openpyxl|dashboard|tablero|panel de control|excel|xlsx|csv|anal[iy]|gr[aá]fic|chart|script|pivot|data ?frame/i;

/** Short English note for the agent about which interpreter/mode to use. Pure. */
export function pythonNoteText(info) {
  if (!info?.found) return '[FlowState] Python is not installed on this computer. Do not try to install it; tell the user to install Python from the Dashboard tab.';
  const pk = PIP_PACKAGES.join(', ');
  if (info.active === 'venv') return `[FlowState] Python: run scripts with the project environment interpreter "${info.interpreter}" (project .venv; ${pk} are installed there). Do not install packages globally or create another environment.`;
  if (info.active === 'global') return `[FlowState] Python: use the global interpreter "${info.interpreter}" (${pk} are already installed globally). Do not create a virtual environment and do not pip install anything globally.`;
  const missing = (info.missing || []).join(', ');
  return `[FlowState] Python: interpreter "${info.interpreter}" is available but these packages are missing globally: ${missing}. Do not pip install them and do not create a virtual environment yourself; ask the user to pick "Install missing packages globally" or "Use a project environment" in the Dashboard tab, then continue.`;
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

/** True when anything answers an HTTP request on 127.0.0.1:port. */
export function probeHttp(port, timeout = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout }, (res) => { res.resume(); resolve(true); });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

/** Polls until probe(port) is true, aborted() is true, or the timeout passes. -> boolean */
export async function waitForPort(port, { timeoutMs = 60000, intervalMs = 300, probe = probeHttp, aborted = () => false } = {}) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (aborted()) return false;
    if (await probe(port)) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/** Path of the python executable inside a project's .venv for the given platform. */
export function venvPythonPath(root, platform = process.platform) {
  const P = pathFor(platform);
  return platform === 'win32' ? P.join(root, '.venv', 'Scripts', 'python.exe') : P.join(root, '.venv', 'bin', 'python');
}

/** Interpreters tried (in order) to create the venv. */
export function pythonCandidates(platform = process.platform) {
  return platform === 'win32' ? [['py', ['-3']], ['python', []]] : [['python3', []], ['python', []]];
}

export function streamlitArgs(app, port) {
  return ['-m', 'streamlit', 'run', app, '--server.address', '127.0.0.1', '--server.port', String(port),
    '--server.headless', 'true', '--browser.gatherUsageStats', 'false'];
}

export function createDashboards({
  getProject, push = () => {}, run = runCommand, spawn = nodeSpawn, kill = killTree, fsx = fs,
  platform = process.platform, getPort = freePort, wait = waitForPort, startTimeoutMs = 60000, updateProject = null, inspectTtlMs = 20000,
} = {}) {
  const procs = new Map();   // projectId -> {child, url, app, port}
  const starting = new Set();
  const settingUp = new Set();

  const need = (id) => {
    const p = typeof id === 'string' ? getProject(id) : null;
    if (!p) throw new Error('Unknown project');
    return p;
  };
  const venvPython = (root) => venvPythonPath(root, platform);
  const exists = (f) => { try { return fsx.existsSync(f); } catch { return false; } };
  const emit = (projectId, o) => push({ projectId, ...o });
  const stateOf = (projectId) => { const r = procs.get(projectId); return { running: !!r, url: r?.url ?? null, app: r?.app ?? null }; };

  async function findPython() {
    for (const [cmd, pre] of pythonCandidates(platform)) {
      const r = await run(cmd, [...pre, '--version'], { timeout: 8000 });
      const v = `${r.stdout}${r.stderr}`.trim().split(/\r?\n/)[0];
      if (r.code === 0 && /^Python \d/.test(v)) return { cmd, pre, version: v.replace(/^Python\s+/, '') };
    }
    return null;
  }

  function discoverApps(root) {
    const out = [];
    for (const sub of ['', 'artifacts']) {
      let names = [];
      try { names = fsx.readdirSync(path.join(root, sub), { withFileTypes: true }); } catch { continue; }
      for (const d of names) {
        if (!d.isFile() || !d.name.toLowerCase().endsWith('.py')) continue;
        try {
          const abs = path.join(root, sub, d.name);
          const fd = fsx.openSync(abs, 'r');
          let head;
          try { const b = Buffer.alloc(256 * 1024); head = b.subarray(0, fsx.readSync(fd, b, 0, b.length, 0)).toString('utf8'); } finally { fsx.closeSync(fd); }
          if (/streamlit/i.test(head)) out.push(sub ? `${sub}/${d.name}` : d.name);
        } catch { /* unreadable */ }
      }
    }
    return out.sort();
  }

  /** Installed-package map for an interpreter: `pip list --format json`, falling back to import probes. -> Map */
  async function listPackages(cmd, pre = []) {
    const r = await run(cmd, [...pre, '-m', 'pip', 'list', '--format', 'json', '--disable-pip-version-check'], { timeout: 40000 });
    const m = r.code === 0 ? parsePipList(r.stdout) : null;
    if (m) return m;
    const code = `import importlib.util as u, json; print(json.dumps([n for n in ${JSON.stringify(PIP_PACKAGES)} if u.find_spec(n)]))`;
    const probe = await run(cmd, [...pre, '-c', code], { timeout: 30000 });
    let found = null;
    try { found = JSON.parse(String(probe.stdout).trim().split(/\r?\n/).pop()); } catch { /* none */ }
    return new Map((Array.isArray(found) ? found : []).map((n) => [normPkg(n), '']));
  }

  const modeOf = (p) => (PY_MODES.includes(p.pythonEnv) ? p.pythonEnv : 'auto');
  const cache = new Map(); // projectId -> {at, key, value}

  /** Which environment would run dashboards / scripts for this project, and what is missing where. */
  async function inspect(p, { fresh = false } = {}) {
    const mode = modeOf(p);
    const key = `${mode}|${p.path}`;
    const hit = cache.get(p.id);
    if (!fresh && hit && hit.key === key && Date.now() - hit.at < inspectTtlMs) return hit.value;
    const py = await findPython();
    const vp = venvPython(p.path);
    const venv = exists(vp);
    const globalMissing = py ? missingPackages(await listPackages(py.cmd, py.pre)) : PIP_PACKAGES.slice();
    const venvMissing = venv ? missingPackages(await listPackages(vp, [])) : PIP_PACKAGES.slice();
    let active = null;
    if (mode === 'global') active = py ? 'global' : null;
    else if (mode === 'venv') active = venv ? 'venv' : null;
    else if (py && !globalMissing.length) active = 'global';
    else if (venv && !venvMissing.length) active = 'venv';
    const ready = active === 'global' ? !globalMissing.length : active === 'venv' ? !venvMissing.length : false;
    const value = {
      py, venv, mode, active, ready, globalMissing, venvMissing,
      missing: active === 'venv' || (!active && mode === 'venv') ? venvMissing : globalMissing,
      needsChoice: !ready && mode === 'auto',
      interpreter: active === 'venv' ? vp : py ? [py.cmd, ...py.pre].join(' ') : null,
    };
    cache.set(p.id, { at: Date.now(), key, value });
    return value;
  }

  async function status(projectId) {
    const p = need(projectId);
    const i = await inspect(p, { fresh: true });
    return {
      python: { found: !!i.py, version: i.py?.version ?? null }, venv: i.venv, deps: i.ready,
      env: { mode: i.mode, active: i.active, missing: i.missing, globalMissing: i.globalMissing, venvMissing: i.venvMissing, needsChoice: i.needsChoice, interpreter: i.interpreter },
      ...stateOf(projectId), apps: discoverApps(p.path),
    };
  }

  /** Short note telling the agent which interpreter/mode to use (null when the prompt is unrelated to Python/data work). */
  async function pythonNote(projectId, text = '') {
    if (!PY_HINT.test(String(text))) return null;
    const p = need(projectId);
    const i = await inspect(p);
    return pythonNoteText({ found: !!i.py, active: i.active, interpreter: i.interpreter, missing: i.globalMissing });
  }

  /**
   * Prepare the Python packages. choice: 'global' | 'venv' (the user's explicit one-click decision; remembered in pythonEnv).
   * Without a choice the project's pythonEnv decides; in 'auto' mode nothing is ever installed -> {ok:false, needsChoice:true, missing}.
   */
  async function setup(projectId, { choice } = {}) {
    const p = need(projectId);
    if (choice !== undefined && choice !== 'global' && choice !== 'venv') throw new TypeError('invalid choice');
    if (settingUp.has(projectId)) throw new Error('Setup already running for this project');
    settingUp.add(projectId);
    const log = (text) => emit(projectId, { kind: 'log', text });
    const fail = (text, extra = {}) => { emit(projectId, { kind: 'error', text }); return { ok: false, ...extra }; };
    try {
      const mode = modeOf(p);
      const target = choice ?? (mode === 'auto' ? null : mode);
      const i = await inspect(p, { fresh: true });
      if (!target) {
        if (i.ready) { emit(projectId, { kind: 'done' }); return { ok: true, env: i.active }; }
        return { ok: false, needsChoice: true, missing: i.globalMissing };
      }
      const py = i.py;
      if (target === 'global') {
        if (!py) return fail('Python was not found. Install Python first.');
        if (!i.globalMissing.length) log('Global Python already has the required packages.');
        else {
          log(`Installing missing packages globally: ${i.globalMissing.join(', ')}...`);
          const lines = [];
          const r = await streamProcess(py.cmd, [...py.pre, '-m', 'pip', 'install', '--disable-pip-version-check', ...i.globalMissing], { spawn, cwd: p.path, onLine: (l) => { lines.push(l); log(l); } });
          if (r.code !== 0) {
            const suggestVenv = isEnvPermissionError(`${r.error ?? ''}\n${lines.join('\n')}`);
            if (suggestVenv) log('Global packages cannot be installed here (no permission or managed Python). Use a project environment instead.');
            return fail(r.error ?? `pip install failed (exit ${r.code})`, { suggestVenv });
          }
        }
      } else {
        const vp = venvPython(p.path);
        if (!exists(vp)) {
          if (!py) return fail('Python was not found. Install Python first.');
          log('Creating the project environment (.venv)...');
          const r = await streamProcess(py.cmd, [...py.pre, '-m', 'venv', path.join(p.path, '.venv')], { spawn, cwd: p.path, onLine: log });
          if (r.code !== 0 || !exists(vp)) {
            const hint = platform === 'linux' ? ' (on Debian/Ubuntu install the python3-venv package)' : '';
            return fail(r.error ?? `venv creation failed (exit ${r.code})${hint}`);
          }
        }
        log(`Installing ${PIP_PACKAGES.join(', ')} in the project environment...`);
        const r = await streamProcess(vp, ['-m', 'pip', 'install', '--disable-pip-version-check', ...PIP_PACKAGES], { spawn, cwd: p.path, onLine: log });
        if (r.code !== 0) return fail(r.error ?? `pip install failed (exit ${r.code})`);
      }
      if (choice && p.pythonEnv !== choice) { try { updateProject?.(projectId, { pythonEnv: choice }); } catch { /* remembering is best effort */ } }
      cache.delete(projectId);
      emit(projectId, { kind: 'done' });
      return { ok: true, env: target };
    } finally { settingUp.delete(projectId); }
  }

  async function start(projectId, appRel) {
    const p = need(projectId);
    if (typeof appRel !== 'string' || !appRel.toLowerCase().endsWith('.py')) throw new TypeError('app must be a .py file');
    const { abs, rel } = resolveInside(p.path, appRel, fsx);
    if (!exists(abs)) throw new Error('App file not found');
    const env = await inspect(p, { fresh: true });
    if (!env.active || !env.ready) throw new Error('Dashboard environment is not set up');
    const [cmd, pre] = env.active === 'venv' ? [venvPython(p.path), []] : [env.py.cmd, env.py.pre];
    if (starting.has(projectId)) throw new Error('Dashboard is already starting');
    const cur = procs.get(projectId);
    if (cur?.app === rel) return { url: cur.url };
    if (cur) stop(projectId);
    starting.add(projectId);
    try {
      const port = await getPort();
      const child = spawn(cmd, [...pre, ...streamlitArgs(rel, port)], { cwd: p.path, ...childSpawnOptions({ platform }), stdio: ['ignore', 'pipe', 'pipe'] });
      let dead = false;
      const tail = [];
      const onData = (d) => { for (const l of String(d).split(/\r?\n/)) if (l.trim()) { tail.push(l); if (tail.length > 20) tail.shift(); } };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      const rec = { child, port, app: rel, url: `http://127.0.0.1:${port}`, startedAt: Date.now() };
      child.on('error', () => { dead = true; });
      child.on('close', () => {
        dead = true;
        if (procs.get(projectId) === rec) { procs.delete(projectId); emit(projectId, { kind: 'status', status: stateOf(projectId) }); }
      });
      procs.set(projectId, rec);
      const ok = await wait(port, { timeoutMs: startTimeoutMs, aborted: () => dead });
      if (!ok) {
        if (procs.get(projectId) === rec) procs.delete(projectId);
        kill(child);
        throw new Error(dead ? `Dashboard exited: ${tail.slice(-2).join(' ')}`.trim() : 'Dashboard did not start in time');
      }
      emit(projectId, { kind: 'status', status: stateOf(projectId) });
      return { url: rec.url };
    } finally { starting.delete(projectId); }
  }

  function stop(projectId) {
    const rec = procs.get(projectId);
    if (!rec) return;
    procs.delete(projectId);
    kill(rec.child);
    emit(projectId, { kind: 'status', status: stateOf(projectId) });
  }

  return {
    status, setup, start, stop, discoverApps, pythonNote,
    /** Running dashboards (tasks service). */
    list: () => [...procs].map(([projectId, r]) => ({ projectId, url: r.url, app: r.app, startedAt: r.startedAt })),
    stopAll() { for (const id of [...procs.keys()]) stop(id); },
  };
}
