// Per-project Python venv + Streamlit dashboards bound to 127.0.0.1.
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

export const PIP_PACKAGES = ['streamlit', 'plotly', 'pandas'];

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
  platform = process.platform, getPort = freePort, wait = waitForPort, startTimeoutMs = 60000,
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

  async function status(projectId) {
    const p = need(projectId);
    const py = await findPython();
    const vp = venvPython(p.path);
    const venv = exists(vp);
    let deps = false;
    if (venv) deps = (await run(vp, ['-c', 'import streamlit, plotly, pandas'], { timeout: 30000 })).code === 0;
    return {
      python: { found: !!py, version: py?.version ?? null }, venv, deps,
      ...stateOf(projectId), apps: discoverApps(p.path),
    };
  }

  async function setup(projectId) {
    const p = need(projectId);
    if (settingUp.has(projectId)) throw new Error('Setup already running for this project');
    settingUp.add(projectId);
    const log = (text) => emit(projectId, { kind: 'log', text });
    const fail = (text) => { emit(projectId, { kind: 'error', text }); return { ok: false }; };
    try {
      const vp = venvPython(p.path);
      if (!exists(vp)) {
        const py = await findPython();
        if (!py) return fail('Python was not found. Install Python first.');
        log('Creating virtual environment (.venv)...');
        const r = await streamProcess(py.cmd, [...py.pre, '-m', 'venv', path.join(p.path, '.venv')], { spawn, cwd: p.path, onLine: log });
        if (r.code !== 0 || !exists(vp)) {
          const hint = platform === 'linux' ? ' (on Debian/Ubuntu install the python3-venv package)' : '';
          return fail(r.error ?? `venv creation failed (exit ${r.code})${hint}`);
        }
      }
      log(`Installing ${PIP_PACKAGES.join(', ')}...`);
      const r = await streamProcess(vp, ['-m', 'pip', 'install', '--disable-pip-version-check', ...PIP_PACKAGES], { spawn, cwd: p.path, onLine: log });
      if (r.code !== 0) return fail(r.error ?? `pip install failed (exit ${r.code})`);
      emit(projectId, { kind: 'done' });
      return { ok: true };
    } finally { settingUp.delete(projectId); }
  }

  async function start(projectId, appRel) {
    const p = need(projectId);
    if (typeof appRel !== 'string' || !appRel.toLowerCase().endsWith('.py')) throw new TypeError('app must be a .py file');
    const { abs, rel } = resolveInside(p.path, appRel, fsx);
    if (!exists(abs)) throw new Error('App file not found');
    const vp = venvPython(p.path);
    if (!exists(vp)) throw new Error('Dashboard environment is not set up');
    if (starting.has(projectId)) throw new Error('Dashboard is already starting');
    const cur = procs.get(projectId);
    if (cur?.app === rel) return { url: cur.url };
    if (cur) stop(projectId);
    starting.add(projectId);
    try {
      const port = await getPort();
      const child = spawn(vp, streamlitArgs(rel, port), { cwd: p.path, ...childSpawnOptions({ platform }), stdio: ['ignore', 'pipe', 'pipe'] });
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
    status, setup, start, stop, discoverApps,
    /** Running dashboards (tasks service). */
    list: () => [...procs].map(([projectId, r]) => ({ projectId, url: r.url, app: r.app, startedAt: r.startedAt })),
    stopAll() { for (const id of [...procs.keys()]) stop(id); },
  };
}
