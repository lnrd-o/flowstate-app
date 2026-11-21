import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { createDashboards, waitForPort, streamlitArgs, probeHttp, freePort } from '../../src/main/dashboards.js';

const tmp = () => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fs-dash-')));
const venvPy = (root) => path.join(root, '.venv', 'Scripts', 'python.exe');

function fakeChild() {
  const c = new EventEmitter();
  c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
  c.pid = 4242; c.exitCode = null;
  return c;
}

test('status discovers streamlit apps and reports deps', async () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'artifacts'));
  fs.writeFileSync(path.join(root, 'dashboard.py'), 'import streamlit as st\n');
  fs.writeFileSync(path.join(root, 'plain.py'), 'print(1)\n');
  fs.writeFileSync(path.join(root, 'artifacts', 'app2.py'), 'from streamlit import x\n');
  fs.writeFileSync(path.join(root, 'artifacts', 'notes.txt'), 'streamlit');
  const calls = [];
  const run = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'py') return { code: 0, stdout: 'Python 3.12.1\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const d = createDashboards({ getProject: (id) => (id === 'p' ? { id: 'p', path: root } : null), run, platform: 'win32' });
  let s = await d.status('p');
  assert.deepEqual(s, { python: { found: true, version: '3.12.1' }, venv: false, deps: false, running: false, url: null, app: null, apps: ['artifacts/app2.py', 'dashboard.py'] });
  fs.mkdirSync(path.join(root, '.venv', 'Scripts'), { recursive: true });
  fs.writeFileSync(venvPy(root), '');
  s = await d.status('p');
  assert.equal(s.venv, true);
  assert.equal(s.deps, true);
  assert.deepEqual(calls.at(-1).slice(1), ['-c', 'import streamlit, plotly, pandas']);
  const none = createDashboards({ getProject: () => ({ id: 'p', path: root }), run: async () => ({ code: -1, stdout: '', stderr: '' }), platform: 'win32' });
  assert.equal((await none.status('p')).python.found, false);
  await assert.rejects(d.status('nope'), /Unknown project/);
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

test('start validates the app path, spawns venv python, waits, stop kills the tree', async () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, '.venv', 'Scripts'), { recursive: true });
  fs.writeFileSync(venvPy(root), '');
  fs.writeFileSync(path.join(root, 'dash.py'), 'import streamlit\n');
  fs.writeFileSync(path.join(root, 'x.txt'), '');
  const spawned = []; const killed = []; const events = [];
  const child = fakeChild();
  const d = createDashboards({
    getProject: () => ({ id: 'p', path: root }), platform: 'win32', push: (e) => events.push(e),
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

test('start fails cleanly when the port never answers or the process dies', async () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, '.venv', 'Scripts'), { recursive: true });
  fs.writeFileSync(venvPy(root), '');
  fs.writeFileSync(path.join(root, 'dash.py'), 'import streamlit\n');
  const killed = [];
  const child = fakeChild();
  const d = createDashboards({
    getProject: () => ({ id: 'p', path: root }), platform: 'win32', spawn: () => child, kill: (c) => killed.push(c),
    getPort: async () => 9124, wait: async () => false,
  });
  await assert.rejects(d.start('p', 'dash.py'), /did not start/);
  assert.equal(killed.length, 1);
  assert.equal((await d.status('p').catch(() => ({ running: false }))).running, false);
});

test('setup streams logs, runs venv then pip, only one at a time', async () => {
  const root = tmp();
  const events = []; const cmds = [];
  const run = async () => ({ code: 0, stdout: 'Python 3.12.0', stderr: '' });
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
  const d = createDashboards({ getProject: () => ({ id: 'p', path: root }), run, spawn, platform: 'win32', push: (e) => events.push(e) });
  const first = d.setup('p');
  await assert.rejects(d.setup('p'), /already running/);
  assert.deepEqual(await first, { ok: true });
  assert.equal(cmds.length, 2);
  assert.deepEqual(cmds[0].slice(0, 4), ['py', '-3', '-m', 'venv']);
  assert.equal(cmds[1][0], venvPy(root));
  assert.deepEqual(cmds[1].slice(1), ['-m', 'pip', 'install', '--disable-pip-version-check', 'streamlit', 'plotly', 'pandas']);
  assert.ok(events.some((e) => e.kind === 'log' && e.text === 'line one'));
  assert.equal(events.at(-1).kind, 'done');
  assert.deepEqual(await d.setup('p'), { ok: true }); // allowed again afterwards
});
