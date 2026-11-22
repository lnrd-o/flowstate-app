import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { createDashboards, waitForPort, streamlitArgs, probeHttp, freePort, parsePipList, missingPackages, isEnvPermissionError, pythonNoteText, PIP_PACKAGES } from '../../src/main/dashboards.js';

const tmp = () => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fs-dash-')));
const venvPy = (root) => path.join(root, '.venv', 'Scripts', 'python.exe');
// These tests model the Windows Python layout (.venv\Scripts\python.exe, py -3) on a REAL temp folder, which only lines up on Windows.
const winOnly = process.platform === 'win32' ? {} : { skip: 'models the Windows Python layout on a real folder' };


const ALL = PIP_PACKAGES;
/** Fake process runner: python --version, `pip list` for the global (py) and venv interpreters. */
const mkRun = ({ globalPkgs = ALL, venvPkgs = ALL, calls } = {}) => async (cmd, args) => {
  calls?.push([cmd, ...args]);
  if (args.includes('--version')) return { code: 0, stdout: 'Python 3.12.1\n', stderr: '' };
  if (args.includes('list')) return { code: 0, stdout: JSON.stringify((cmd === 'py' ? globalPkgs : venvPkgs).map((name) => ({ name, version: '1.0' }))), stderr: '' };
  return { code: 0, stdout: '', stderr: '' };
};

function fakeChild() {
  const c = new EventEmitter();
  c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
  c.pid = 4242; c.exitCode = null;
  return c;
}

test('status discovers apps; global packages satisfy deps without a venv', async () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'artifacts'));
  fs.writeFileSync(path.join(root, 'dashboard.py'), 'import streamlit as st\n');
  fs.writeFileSync(path.join(root, 'plain.py'), 'print(1)\n');
  fs.writeFileSync(path.join(root, 'artifacts', 'app2.py'), 'from streamlit import x\n');
  fs.writeFileSync(path.join(root, 'artifacts', 'notes.txt'), 'streamlit');
  const proj = { id: 'p', path: root };
  const d = createDashboards({ getProject: (id) => (id === 'p' ? proj : null), run: mkRun(), platform: 'win32' });
  const s = await d.status('p');
  assert.deepEqual(s.python, { found: true, version: '3.12.1' });
  assert.equal(s.venv, false);
  assert.equal(s.deps, true);
  assert.equal(s.env.mode, 'auto'); assert.equal(s.env.active, 'global'); assert.deepEqual(s.env.missing, []);
  assert.deepEqual(s.apps, ['artifacts/app2.py', 'dashboard.py']);
  await assert.rejects(d.status('nope'), /Unknown project/);
  const none = createDashboards({ getProject: () => proj, run: async () => ({ code: -1, stdout: '', stderr: '' }), platform: 'win32' });
  assert.equal((await none.status('p')).python.found, false);
});

test('auto mode: missing global packages need a choice; a satisfied project venv is used; nothing is installed', winOnly, async () => {
  const root = tmp();
  const proj = { id: 'p', path: root };
  const spawned = [];
  const d = createDashboards({ getProject: () => proj, run: mkRun({ globalPkgs: ['pandas'], venvPkgs: ALL }), spawn: (...a) => { spawned.push(a); return fakeChild(); }, platform: 'win32' });
  let s = await d.status('p');
  assert.equal(s.deps, false); assert.equal(s.env.needsChoice, true); assert.deepEqual(s.env.missing, ['streamlit', 'plotly', 'openpyxl']);
  assert.deepEqual(await d.setup('p'), { ok: false, needsChoice: true, missing: ['streamlit', 'plotly', 'openpyxl'] });
  assert.equal(spawned.length, 0);
  fs.mkdirSync(path.join(root, '.venv', 'Scripts'), { recursive: true });
  fs.writeFileSync(venvPy(root), '');
  s = await d.status('p');
  assert.equal(s.env.active, 'venv'); assert.equal(s.deps, true);
});

test('pip list parsing and missing-package helpers', () => {
  const m = parsePipList('[{"name":"Streamlit","version":"1.3"},{"name":"openpyxl","version":"3"}]');
  assert.deepEqual(missingPackages(m), ['plotly', 'pandas']);
  assert.equal(parsePipList('not json'), null);
  assert.equal(isEnvPermissionError('error: externally-managed-environment'), true);
  assert.equal(isEnvPermissionError('ERROR: Could not find a version'), false);
});

test('pip list failing falls back to import probes', async () => {
  const root = tmp();
  const run = async (cmd, args) => {
    if (args.includes('--version')) return { code: 0, stdout: 'Python 3.11.0', stderr: '' };
    if (args.includes('list')) return { code: 1, stdout: '', stderr: 'No module named pip' };
    return { code: 0, stdout: '["streamlit","plotly","pandas","openpyxl"]\n', stderr: '' };
  };
  const d = createDashboards({ getProject: () => ({ id: 'p', path: root }), run, platform: 'win32' });
  assert.equal((await d.status('p')).deps, true);
});

test('pythonNote: gated by the prompt, tells the agent interpreter and mode', async () => {
  const root = tmp();
  const d = createDashboards({ getProject: () => ({ id: 'p', path: root }), run: mkRun(), platform: 'win32' });
  assert.equal(await d.pythonNote('p', 'rename these photos'), null);
  const n = await d.pythonNote('p', 'Build a dashboard from my xlsx');
  assert.match(n, /global interpreter "py -3"/); assert.match(n, /Do not create a virtual environment/);
  assert.match(pythonNoteText({ found: true, active: 'venv', interpreter: 'C:\\p\\.venv\\Scripts\\python.exe' }), /project environment/);
  assert.match(pythonNoteText({ found: true, active: null, interpreter: 'py -3', missing: ['streamlit'] }), /missing globally: streamlit/);
  assert.match(pythonNoteText({ found: false }), /not installed/);
});

test('waitForPort works against a real fake server and times out otherwise', async () => {
  const srv = http.createServer((_q, r) => r.end('ok'));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  assert.equal(await probeHttp(port), true);
  assert.equal(await waitForPort(port, { timeoutMs: 2000, intervalMs: 20 }), true);
  await new Promise((r) => srv.close(r));
  assert.equal(await waitForPort(port, { timeoutMs: 150, intervalMs: 20 }), false);
  let n = 0;
  assert.equal(await waitForPort(1, { timeoutMs: 2000, intervalMs: 10, probe: async () => ++n > 3 }), true);
  assert.equal(await waitForPort(1, { timeoutMs: 2000, intervalMs: 10, probe: async () => false, aborted: () => true }), false);
  assert.ok((await freePort()) > 0);
});

test('streamlit args bind to 127.0.0.1 headless', () => {
  assert.deepEqual(streamlitArgs('dashboard.py', 8765), ['-m', 'streamlit', 'run', 'dashboard.py', '--server.address', '127.0.0.1',
    '--server.port', '8765', '--server.headless', 'true', '--browser.gatherUsageStats', 'false']);
});

test('start validates the app path, spawns venv python, waits, stop kills the tree', winOnly, async () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, '.venv', 'Scripts'), { recursive: true });
  fs.writeFileSync(venvPy(root), '');
  fs.writeFileSync(path.join(root, 'dash.py'), 'import streamlit\n');
  fs.writeFileSync(path.join(root, 'x.txt'), '');
  const spawned = []; const killed = []; const events = [];
  const child = fakeChild();
  const d = createDashboards({
    getProject: () => ({ id: 'p', path: root, pythonEnv: 'venv' }), run: mkRun(), platform: 'win32', push: (e) => events.push(e),
    spawn: (cmd, args, opts) => { spawned.push({ cmd, args, opts }); return child; },
    kill: (c) => killed.push(c), getPort: async () => 9123, wait: async () => true,
  });
  await assert.rejects(d.start('p', 'x.txt'), /\.py/);
  await assert.rejects(d.start('p', '../evil.py'));
  await assert.rejects(d.start('p', 'C:\\evil.py'));
  await assert.rejects(d.start('p', 'missing.py'), /not found/);
  const r = await d.start('p', 'dash.py');
  assert.deepEqual(r, { url: 'http://127.0.0.1:9123' });
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].cmd, venvPy(root));
  assert.equal(spawned[0].opts.shell, false);
  assert.equal(spawned[0].opts.cwd, root);
  assert.deepEqual(spawned[0].args, streamlitArgs('dash.py', 9123));
  assert.deepEqual(await d.start('p', 'dash.py'), r); // already running: same url, no second spawn
  assert.equal(spawned.length, 1);
  d.stop('p');
  assert.deepEqual(killed, [child]);
  assert.equal(events.at(-1).status.running, false);
});

test('start fails cleanly when the port never answers or the process dies', winOnly, async () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, '.venv', 'Scripts'), { recursive: true });
  fs.writeFileSync(venvPy(root), '');
  fs.writeFileSync(path.join(root, 'dash.py'), 'import streamlit\n');
  const killed = [];
  const child = fakeChild();
  const d = createDashboards({
    getProject: () => ({ id: 'p', path: root, pythonEnv: 'venv' }), run: mkRun(), platform: 'win32', spawn: () => child, kill: (c) => killed.push(c),
    getPort: async () => 9124, wait: async () => false,
  });
  await assert.rejects(d.start('p', 'dash.py'), /did not start/);
  assert.equal(killed.length, 1);
  assert.equal((await d.status('p').catch(() => ({ running: false }))).running, false);
});

test('setup with choice=venv streams logs, creates the venv, pip installs, remembers the choice, one at a time', winOnly, async () => {
  const root = tmp();
  const events = []; const cmds = []; const updates = [];
  const spawn = (cmd, args) => {
    cmds.push([cmd, ...args]);
    const c = fakeChild();
    setTimeout(() => {
      if (args.includes('venv')) { fs.mkdirSync(path.join(root, '.venv', 'Scripts'), { recursive: true }); fs.writeFileSync(venvPy(root), ''); }
      c.stdout.emit('data', 'line one\nline two\n');
      c.emit('close', 0);
    }, 10);
    return c;
  };
  const d = createDashboards({
    getProject: () => ({ id: 'p', path: root }), run: mkRun({ globalPkgs: [], venvPkgs: ALL }), spawn, platform: 'win32', push: (e) => events.push(e),
    updateProject: (id, patch) => updates.push([id, patch]),
  });
  const first = d.setup('p', { choice: 'venv' });
  await assert.rejects(d.setup('p', { choice: 'venv' }), /already running/);
  assert.deepEqual(await first, { ok: true, env: 'venv' });
  assert.equal(cmds.length, 2);
  assert.deepEqual(cmds[0].slice(0, 4), ['py', '-3', '-m', 'venv']);
  assert.equal(cmds[1][0], venvPy(root));
  assert.deepEqual(cmds[1].slice(1), ['-m', 'pip', 'install', '--disable-pip-version-check', ...ALL]);
  assert.ok(events.some((e) => e.kind === 'log' && e.text === 'line one'));
  assert.equal(events.at(-1).kind, 'done');
  assert.deepEqual(updates, [['p', { pythonEnv: 'venv' }]]);
  await assert.rejects(d.setup('p', { choice: 'nope' }), /invalid choice/);
});

test('setup with choice=global installs only the missing packages globally and remembers it', async () => {
  const root = tmp();
  const cmds = []; const updates = [];
  const spawn = (cmd, args) => { cmds.push([cmd, ...args]); const c = fakeChild(); setTimeout(() => c.emit('close', 0), 5); return c; };
  const d = createDashboards({ getProject: () => ({ id: 'p', path: root }), run: mkRun({ globalPkgs: ['pandas', 'plotly'] }), spawn, platform: 'win32', updateProject: (id, p) => updates.push(p) });
  assert.deepEqual(await d.setup('p', { choice: 'global' }), { ok: true, env: 'global' });
  assert.deepEqual(cmds, [['py', '-3', '-m', 'pip', 'install', '--disable-pip-version-check', 'streamlit', 'openpyxl']]);
  assert.equal(fs.existsSync(path.join(root, '.venv')), false);
  assert.deepEqual(updates, [{ pythonEnv: 'global' }]);
});

test('global install denied -> failure suggests a project environment and does not remember global', async () => {
  const root = tmp();
  const events = []; const updates = [];
  const spawn = () => { const c = fakeChild(); setTimeout(() => { c.stderr.emit('data', 'ERROR: [Errno 13] Permission denied: site-packages\n'); c.emit('close', 1); }, 5); return c; };
  const d = createDashboards({ getProject: () => ({ id: 'p', path: root }), run: mkRun({ globalPkgs: [] }), spawn, platform: 'win32', push: (e) => events.push(e), updateProject: (id, p) => updates.push(p) });
  const r = await d.setup('p', { choice: 'global' });
  assert.equal(r.ok, false); assert.equal(r.suggestVenv, true);
  assert.ok(events.some((e) => e.kind === 'log' && /project environment/.test(e.text)));
  assert.deepEqual(updates, []);
});

test('explicit pythonEnv=global installs without a choice (remembered consent); status honours it', async () => {
  const root = tmp();
  const cmds = [];
  const spawn = (cmd, args) => { cmds.push(args); const c = fakeChild(); setTimeout(() => c.emit('close', 0), 5); return c; };
  const d = createDashboards({ getProject: () => ({ id: 'p', path: root, pythonEnv: 'global' }), run: mkRun({ globalPkgs: ['pandas'] }), spawn, platform: 'win32' });
  assert.equal((await d.status('p')).env.needsChoice, false);
  assert.equal((await d.setup('p')).ok, true);
  assert.equal(cmds.length, 1);
});
