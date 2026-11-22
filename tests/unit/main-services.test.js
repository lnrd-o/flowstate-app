import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createPrereq, wingetArgs, PACKAGES } from '../../src/main/prereq.js';
import { createAuth, buildLoginCommand } from '../../src/main/auth.js';
import { createRemote, claudeRemoteArgs, agyRemoteArgs, classifyFailure, parseAgyStatus } from '../../src/main/remote.js';
import { createHistory, MAX_BYTES } from '../../src/main/history.js';
import { CSP, shouldApplyCsp } from '../../src/main/security.js';
import { CH } from '../../src/shared/ipc.js';
import { registerIpc } from '../../src/main/ipc.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fs-svc-'));
function fakeChild() {
  const c = new EventEmitter();
  c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = new EventEmitter();
  c.pid = 77; c.exitCode = null; c.unref = () => {};
  return c;
}

test('prereq: allow-list, exact winget args, unknown id refused', async () => {
  assert.deepEqual(PACKAGES, { git: 'Git.Git', node: 'OpenJS.NodeJS.LTS', python: 'Python.Python.3.12' });
  assert.deepEqual(wingetArgs('git'), ['install', '--id', 'Git.Git', '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements']);
  for (const bad of ['calc', 'git; calc', '__proto__', 'constructor', '', 'Git.Git']) assert.throws(() => wingetArgs(bad), /Unknown/);
  let spawned = 0;
  const p = createPrereq({ platform: 'win32', spawn: () => { spawned++; return fakeChild(); } });
  await assert.rejects(p.install('evil'), /Unknown/);
  assert.equal(spawned, 0);
});

test('prereq: streams, rechecks, refuses concurrent installs', async () => {
  const events = []; let rechecked = 0; const seen = [];
  const child = fakeChild();
  const p = createPrereq({ platform: 'win32',
    spawn: (cmd, args, opts) => { seen.push([cmd, args, opts]); return child; },
    push: (e) => events.push(e), recheck: async () => { rechecked++; },
  });
  const first = p.install('python');
  await assert.rejects(p.install('git'), /already running/);
  child.stdout.emit('data', 'Downloading\nInstalling\n');
  child.emit('close', 0);
  const r = await first;
  assert.equal(r.ok, true);
  assert.match(r.log, /Installing/);
  assert.equal(seen[0][0], 'winget');
  assert.equal(seen[0][2].shell, false);
  assert.deepEqual(events.map((e) => e.kind), ['log', 'log', 'done']);
  assert.equal(rechecked, 1);
  const c2 = fakeChild();
  const p2 = createPrereq({ platform: 'win32', spawn: () => c2, push: (e) => events.push(e) });
  const pr = p2.install('node');
  c2.emit('close', 1);
  assert.equal((await pr).ok, false);
  assert.equal(events.at(-1).kind, 'error');
  const bad = createPrereq({ platform: 'win32', spawn: () => { const c = fakeChild(); setImmediate(() => c.emit('error', new Error('ENOENT'))); return c; } });
  assert.equal((await bad.install('git')).ok, false);
});

test('auth: argument building and validation', async () => {
  assert.deepEqual(buildLoginCommand('claude', 'C:\\x\\claude.exe', 'win32'), { command: 'cmd.exe', args: ['/c', 'start', 'FlowState sign-in', 'C:\\x\\claude.exe', 'auth', 'login'] });
  assert.deepEqual(buildLoginCommand('agy', 'C:\\x\\agy.exe', 'win32').args, ['/c', 'start', 'FlowState sign-in', 'C:\\x\\agy.exe']);
  assert.throws(() => buildLoginCommand('claude', 'C:\\x\\claude.cmd', 'win32'));
  assert.throws(() => buildLoginCommand('claude', 'C:\\x" & calc & ".exe', 'win32'));
  assert.throws(() => buildLoginCommand('evil', 'a.exe', 'win32'));
  const seen = [];
  const auth = createAuth({
    platform: 'win32',
    health: { findClaude: async () => 'C:\\x\\claude.exe', findAgy: async () => null },
    fsx: { existsSync: () => true },
    spawn: (cmd, args, opts) => { seen.push([cmd, args, opts]); const c = fakeChild(); setImmediate(() => c.emit('spawn')); return c; },
  });
  assert.deepEqual(await auth.login('claude'), { ok: true });
  assert.equal(seen[0][2].detached, true);
  assert.equal(seen[0][2].windowsHide, false);
  assert.equal(seen[0][2].shell, false);
  await assert.rejects(auth.login('agy'), /not found/);
  await assert.rejects(auth.login('x'), /invalid agent/);
});

test('remote: arg building per agent and status parsing', () => {
  assert.deepEqual(claudeRemoteArgs({ name: 'My App', mode: 'plan' }), ['remote-control', '--name', 'My App', '--permission-mode', 'plan']);
  assert.equal(claudeRemoteArgs({ name: 'x', mode: 'bogus' }).at(-1), 'default');
  assert.equal(claudeRemoteArgs({ name: '--evil', mode: 'default' })[2], 'fs--evil');
  assert.deepEqual(agyRemoteArgs({ name: 'P' }), ['remote-control', 'start', '--session', '--name', 'P']);
  assert.equal(classifyFailure('Error: Workspace not trusted. Please run'), 'workspace-not-trusted');
  assert.equal(classifyFailure('Raw mode is not supported'), 'needs-terminal');
  assert.equal(parseAgyStatus('Daemon status: not registered'), false);
  assert.equal(parseAgyStatus('Daemon status: running'), true);
});

test('remote: claude lifecycle with a fake child', async () => {
  const projects = { p1: { id: 'p1', name: 'Proj', path: 'C:\\proj', agent: 'claude', mode: 'acceptEdits' } };
  const child = fakeChild(); const killed = []; const events = []; const spawned = [];
  const r = createRemote({ platform: 'win32',
    getProject: (id) => projects[id] ?? null, findExe: async () => 'C:\\claude.exe', settleMs: 30,
    spawn: (cmd, args, opts) => { spawned.push([cmd, args, opts]); return child; }, kill: (c) => killed.push(c), push: (e) => events.push(e),
  });
  assert.deepEqual(await r.status('p1'), { running: false, supported: true });
  const pending = r.start('p1');
  await new Promise((res) => setImmediate(res));
  child.stdout.emit('data', 'Remote Control\nhttps://claude.ai/code/abc\n');
  const st = await pending;
  assert.equal(st.running, true);
  assert.match(st.info, /claude\.ai\/code\/abc/);
  assert.deepEqual(spawned[0][1], ['remote-control', '--name', 'Proj', '--permission-mode', 'acceptEdits']);
  assert.equal(spawned[0][2].cwd, 'C:\\proj');
  assert.equal(spawned[0][2].shell, false);
  assert.equal((await r.status('p1')).running, true);
  assert.equal(spawned.length, 1);
  await r.start('p1');
  assert.equal(spawned.length, 1);
  assert.deepEqual(await r.stop('p1'), { running: false });
  assert.deepEqual(killed, [child]);
  assert.equal(events.at(-1).running, false);
  await assert.rejects(r.start('nope'), /Unknown project/);
});

test('remote: early exit maps to error code; needs-terminal opens a console; stopAll kills', async () => {
  const proj = { id: 'p1', name: 'Proj', path: 'C:\\proj', agent: 'claude', mode: 'default' };
  const kids = []; const spawned = [];
  const mk = (out, code) => {
    const c = fakeChild();
    setImmediate(() => { c.stderr.emit('data', out); c.emit('close', code); });
    return c;
  };
  let script = [() => mk('Error: Workspace not trusted. Please run claude', 1), () => mk('Raw mode is not supported', 1), () => fakeChild()];
  const r = createRemote({ platform: 'win32',
    getProject: () => proj, findExe: async () => 'C:\\claude.exe', settleMs: 200,
    spawn: (cmd, args) => { spawned.push([cmd, args]); const c = (script.length ? script.shift()() : fakeChild()); if (cmd === 'cmd.exe') setImmediate(() => c.emit('spawn')); kids.push(c); return c; },
    kill: (c) => kids.push(['killed', c]),
  });
  const a = await r.start('p1');
  assert.equal(a.running, false);
  assert.equal(a.error, 'workspace-not-trusted');
  const b = await r.start('p1');
  assert.equal(b.error, 'needs-terminal');
  assert.equal(b.running, false);
  assert.equal(spawned.at(-1)[0], 'cmd.exe');
  assert.deepEqual(spawned.at(-1)[1].slice(0, 3), ['/c', 'start', 'FlowState remote control']);
  script = [() => fakeChild()];
  await r.start('p1');
  r.stopAll();
  assert.ok(kids.some((k) => Array.isArray(k) && k[0] === 'killed'));
});

test('remote: agy uses daemon commands', async () => {
  const proj = { id: 'p2', name: 'Agy P', path: 'C:\\p', agent: 'agy', mode: 'default' };
  const calls = [];
  const run = async (cmd, args) => { calls.push(args.join(' ')); return { code: 0, stdout: args[1] === 'status' ? 'Daemon status: running' : 'started', stderr: '' }; };
  const r = createRemote({ platform: 'win32', getProject: () => proj, findExe: async () => 'C:\\agy.exe', run });
  assert.equal((await r.status('p2')).running, true);
  assert.equal((await r.start('p2')).running, true);
  assert.equal(calls.at(-1), 'remote-control start --session --name Agy P');
  assert.deepEqual(await r.stop('p2'), { running: false });
  assert.equal(calls.at(-1), 'remote-control stop');
  await r.stopForRemoved(proj); // no daemon owned any more: must not call stop again
  assert.equal(calls.at(-1), 'remote-control stop');
  assert.equal(calls.length, 3);
});

test('history: append, coalesce deltas, supersede by text, truncate, clear', () => {
  const dir = tmp();
  let t = 1;
  const h = createHistory({ dir, now: () => t++ });
  const id = 'proj-1';
  h.recordUser(id, 'hello');
  h.recordEvent(id, { type: 'session', sessionId: 's' });
  h.recordEvent(id, { type: 'text-delta', text: 'Hel' });
  h.recordEvent(id, { type: 'text-delta', text: 'lo' });
  h.recordEvent(id, { type: 'tool-use', id: 'a', name: 'Read', input: {} });
  h.recordEvent(id, { type: 'text-delta', text: 'dup' });
  h.recordEvent(id, { type: 'text', text: 'dup full' });
  h.recordEvent(id, { type: 'result', ok: true });
  const recs = h.get(id);
  assert.deepEqual(recs.map((r) => (r.t === 'user' ? 'user' : r.event.type)), ['user', 'session', 'text', 'tool-use', 'text', 'result']);
  assert.equal(recs[2].event.text, 'Hello');
  assert.equal(recs[4].event.text, 'dup full');
  assert.ok(!recs.some((r) => r.event?.type === 'text-delta'));
  assert.throws(() => h.get('../x'));
  // truncation of oldest lines at load
  const big = 'x'.repeat(10000);
  for (let i = 0; i < 300; i++) h.recordEvent(id, { type: 'tool-result', id: String(i), output: big });
  const file = path.join(dir, 'history', `${id}.jsonl`);
  assert.ok(fs.statSync(file).size > MAX_BYTES);
  const after = h.get(id);
  assert.ok(fs.statSync(file).size <= MAX_BYTES);
  assert.equal(after.at(-1).event.id, '299');
  assert.ok(after.length <= 500);
  // bad line tolerated, last-500 cap
  fs.appendFileSync(file, 'not json\n');
  assert.ok(h.get(id).length > 0);
  h.clear(id);
  assert.deepEqual(h.get(id), []);
  assert.ok(!fs.existsSync(file));
  for (let i = 0; i < 600; i++) h.recordUser('p-2', `m${i}`);
  const last = h.get('p-2');
  assert.equal(last.length, 500);
  assert.equal(last.at(-1).text, 'm599');
});

test('security: CSP allows 127.0.0.1 frames only and applies to app pages only', () => {
  assert.ok(CSP.includes('frame-src http://127.0.0.1:*'));
  assert.ok(CSP.includes("default-src 'self'") && CSP.includes("script-src 'self'") && CSP.includes("object-src 'none'"));
  assert.ok(shouldApplyCsp('file:///C:/app/index.html'));
  assert.ok(!shouldApplyCsp('http://127.0.0.1:8501/'));
});

test('ipc: phase 2 handlers validate arguments', async () => {
  const handlers = {};
  const proj = { id: 'p', path: 'C:\\x', agent: 'claude' };
  const called = [];
  const mk = (name) => new Proxy({}, { get: (_t, m) => (...a) => { called.push(`${name}.${String(m)}`); return a; } });
  registerIpc({
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } }, getWindow: () => null,
    projects: { get: (id) => (id === 'p' ? proj : null), remove() {} }, agents: mk('agents'),
    prompts: mk('prompts'), files: mk('files'), dashboards: mk('dashboards'), prereq: mk('prereq'), auth: mk('auth'),
    remote: { ...mk('remote'), stopForRemoved: async () => {} }, history: mk('history'),
    methodologies: mk('methodologies'), recorder: mk('recorder'), runner: mk('runner'),
    login: mk('login'), windowCtl: mk('windowCtl'),
  });
  for (const ch of Object.values(CH).filter((c) => !c.startsWith('ev:'))) assert.equal(typeof handlers[ch], 'function', ch);
  await assert.rejects(async () => handlers[CH.filesRead]({}, 'nope', 'a.txt'), /Unknown project/);
  await assert.rejects(async () => handlers[CH.filesRead]({}, 'p', 42), /path required/);
  await assert.rejects(async () => handlers[CH.filesList]({}, 'p', 'x'.repeat(2000)), /invalid path/);
  await assert.rejects(async () => handlers[CH.authLogin]({}, 'rm'), /invalid agent/);
  await assert.rejects(async () => handlers[CH.dashboardStart]({}, 'p', ''), /app path/);
  await assert.rejects(async () => handlers[CH.promptsDelete]({}, ''), /id required/);
  await handlers[CH.filesRead]({}, 'p', 'a.txt');
  await handlers[CH.projectsRemove]({}, 'p');
  assert.ok(called.includes('files.read') && called.includes('history.forget') && called.includes('dashboards.stop') && called.includes('runner.forgetProject'));

  // phase 3 validation
  const h = handlers;
  const bad = (fn, re) => assert.rejects(async () => fn(), re);
  await bad(() => h[CH.methodGet]({}, '../x'), /invalid methodology id/);
  await bad(() => h[CH.methodDelete]({}, 'A'), /invalid methodology id/);
  await bad(() => h[CH.methodExport]({}, 5), /invalid methodology id/);
  await bad(() => h[CH.methodSave]({}, 'str'), /methodology required/);
  await bad(() => h[CH.methodSave]({}, [1]), /methodology required/);
  await bad(() => h[CH.methodRecord]({}, 'nope', {}), /Unknown project/);
  await bad(() => h[CH.methodRecord]({}, 'p', { name: 5 }), /invalid name/);
  await bad(() => h[CH.methodRecord]({}, 'p', { fromTs: 'x' }), /invalid timestamp/);
  await bad(() => h[CH.methodRun]({}, 'nope', 'flow', {}), /Unknown project/);
  await bad(() => h[CH.methodRun]({}, 'p', '../x', {}), /invalid methodology id/);
  await bad(() => h[CH.methodRun]({}, 'p', 'flow', [1]), /plain object/);
  await bad(() => h[CH.methodRun]({}, 'p', 'flow', Object.fromEntries(Array.from({ length: 41 }, (_, i) => ['k' + i, 'v']))), /too many vars/);
  await bad(() => h[CH.methodRun]({}, 'p', 'flow', { 'bad key': 'v' }), /invalid var name/);
  await bad(() => h[CH.methodRespond]({}, '', 'n1', {}), /run id required/);
  await bad(() => h[CH.methodRespond]({}, 'r1', 'bad node!', {}), /invalid node id/);
  await bad(() => h[CH.methodRespond]({}, 'r1', 'n1', null), /response required/);
  await bad(() => h[CH.methodStop]({}, 7), /run id required/);
  await bad(() => h[CH.methodRunState]({}, 'nope'), /Unknown project/);
  called.length = 0;
  await h[CH.methodRun]({}, 'p', 'flow', { a: 'b' });
  await h[CH.methodRespond]({}, 'r1', 'n1', { approve: true });
  await h[CH.methodStop]({}, 'r1');
  await h[CH.methodRunState]({}, 'p');
  await h[CH.methodRecord]({}, 'p');
  await h[CH.methodList]({});
  assert.deepEqual(called, ['runner.run', 'runner.respond', 'runner.stop', 'runner.state', 'recorder.record', 'methodologies.list']);
});
