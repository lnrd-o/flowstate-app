import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRunner, checkExe, validateVars } from '../../src/main/runner.js';
import { createAgentManager } from '../../src/main/agents/manager.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fs-run-'));
const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await new Promise((r) => setTimeout(r, 5)); }
  throw new Error('timeout waiting for condition');
};

function setup({ methodology, agentResult = { type: 'result', ok: true, text: 'done it' }, exec, commit } = {}) {
  const dir = tmp();
  const projDir = tmp();
  const project = { id: 'p1', name: 'Demo', path: projDir, agent: 'claude', mode: 'default' };
  const states = [];
  const sent = [];
  let running = false;
  let runner;
  const agents = {
    status: () => ({ running }),
    stop: () => { agents.stopped = true; if (agents.pending) { const ev = { type: 'result', ok: false, stopped: true, text: 'Stopped by user' }; running = false; runner.onAgentEvent('p1', ev); } },
    async send(req) {
      sent.push(req);
      if (agentResult === 'hang') { running = true; agents.pending = true; return { turnId: 't' }; }
      running = true;
      setTimeout(() => { runner.onAgentEvent('p1', agentResult); setTimeout(() => { running = false; }, 5); }, 5);
      return { turnId: 't' };
    },
  };
  const gitCalls = [];
  const git = { autoCommit: async (cwd, msg) => { gitCalls.push([cwd, msg]); return commit ?? { committed: true }; } };
  runner = createRunner({
    dir, getProject: (id) => (id === 'p1' ? project : null), getMethodology: () => methodology, agents, git,
    emit: (id, s) => states.push(s), exec, idleWaitMs: 500,
  });
  return { runner, states, sent, gitCalls, dir, projDir, agents, last: () => states.at(-1) };
}

const T = (s) => ({ en: s, es: s });
const base = (nodes, edges, vars = []) => ({ id: 'flow', version: 1, name: T('Flow'), vars, nodes, edges });

test('happy path: ask-user -> prompt -> condition -> checkpoint -> artifact -> git-commit', async () => {
  const m = base([
    { id: 'ask', type: 'ask-user', title: 'Ask', question: 'Which file for {{projectName}}?', saveAs: 'file' },
    { id: 'go', type: 'prompt', title: 'Go', text: 'Edit {{file}} in {{projectPath}} for {{mode}}', agent: 'agy', mode: 'plan' },
    { id: 'cond', type: 'condition', title: 'C', var: 'mode', equals: 'fast' },
    { id: 'slow', type: 'checkpoint', title: 'Slow', message: 'never' },
    { id: 'cp', type: 'checkpoint', title: 'CP', message: 'Looks ok?' },
    { id: 'art', type: 'artifact', title: 'Art', path: '{{file}}' },
    { id: 'miss', type: 'artifact', title: 'Miss', path: 'nope.txt' },
    { id: 'gc', type: 'git-commit', title: 'GC', message: 'Done {{file}}' },
  ], [
    { from: 'ask', to: 'go' }, { from: 'go', to: 'cond' }, { from: 'cond', to: 'cp', label: 'yes' }, { from: 'cond', to: 'slow', label: 'no' },
    { from: 'cp', to: 'art' }, { from: 'art', to: 'miss' }, { from: 'miss', to: 'gc' },
  ], [{ key: 'mode', label: T('Mode'), type: 'select', options: ['fast', 'slow'], required: true }]);
  const t = setup({ methodology: m });
  fs.writeFileSync(path.join(t.projDir, 'a.txt'), 'x');
  const { runId } = t.runner.run('p1', 'flow', { mode: 'fast' });
  assert.throws(() => t.runner.run('p1', 'flow', { mode: 'fast' }), /already active/);
  await until(() => t.last()?.status === 'waiting');
  assert.deepEqual(t.last().waiting, { nodeId: 'ask', kind: 'ask-user', text: 'Which file for Demo?' });
  assert.throws(() => t.runner.respond(runId, 'cp', { answer: 'a.txt' }), /not waiting/);
  assert.throws(() => t.runner.respond(runId, 'ask', { approve: true }), /answer/);
  t.runner.respond(runId, 'ask', { answer: 'a.txt' });
  await until(() => t.last()?.waiting?.nodeId === 'cp');
  assert.equal(t.sent.length, 1);
  assert.deepEqual(t.sent[0], { projectId: 'p1', text: `Edit a.txt in ${t.projDir} for fast`, agent: 'agy', mode: 'plan' });
  assert.equal(t.last().vars.file, 'a.txt');
  assert.equal(t.last().nodes.go.state, 'done');
  assert.equal(t.last().nodes.cond.message, 'yes');
  t.runner.respond(runId, 'cp', { approve: true });
  await until(() => t.last()?.status === 'done');
  const s = t.last();
  assert.equal(s.nodes.art.state, 'done');
  assert.equal(s.nodes.miss.state, 'warn');
  assert.equal(s.nodes.gc.state, 'done');
  assert.equal(s.nodes.slow.state, 'skipped');
  assert.deepEqual(t.gitCalls, [[t.projDir, 'Done a.txt']]);
  assert.ok(s.endedAt && s.current === null);
  // persisted + loadable without an active run; a new run is now allowed
  const persisted = JSON.parse(fs.readFileSync(path.join(t.dir, 'runs', 'p1.json'), 'utf8'));
  assert.equal(persisted.status, 'done');
  assert.equal(t.runner.state('p1').runId, runId);
  assert.equal(t.runner.state('nope'), null);
  t.runner.run('p1', 'flow', { mode: 'fast' });
  t.runner.stopAll();
});

test('git-commit: nothing to commit is done; failure is an error', async () => {
  const m = base([{ id: 'gc', type: 'git-commit', title: 'GC', message: 'x' }], []);
  let t = setup({ methodology: m, commit: { committed: false, reason: 'clean' } });
  t.runner.run('p1', 'flow', {});
  await until(() => t.last()?.status === 'done');
  assert.deepEqual([t.last().nodes.gc.state, t.last().nodes.gc.message], ['done', 'nothing to commit']);
  t = setup({ methodology: m, commit: { committed: false, reason: 'commit-failed', message: 'boom' } });
  t.runner.run('p1', 'flow', {});
  await until(() => t.last()?.status === 'error');
  assert.equal(t.last().nodes.gc.state, 'error');
});

test('command: confirmation required, executes after approve, deny-list and rejection', async () => {
  const calls = [];
  const exec = async (exe, args, opts) => { calls.push({ exe, args, opts }); return { code: 0, stdout: 'ok\n', stderr: '' }; };
  const m = base([{ id: 'c', type: 'command', title: 'C', exe: 'node', args: ['-e', 'console.log("{{n}}")'] }], [], [{ key: 'n', label: T('n'), type: 'text' }]);
  let t = setup({ methodology: m, exec });
  const { runId } = t.runner.run('p1', 'flow', { n: '1' });
  await until(() => t.last()?.status === 'waiting');
  assert.equal(t.last().waiting.kind, 'command-confirm');
  assert.deepEqual(t.last().waiting.command, { exe: 'node', args: ['-e', 'console.log("1")'] });
  assert.equal(calls.length, 0);
  t.runner.respond(runId, 'c', { approve: true });
  await until(() => t.last()?.status === 'done');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.cwd, t.projDir);
  assert.equal(calls[0].opts.timeout, 120000);
  assert.equal(calls[0].opts.maxBuffer, 1024 * 1024);
  // rejection
  t = setup({ methodology: m, exec });
  const r2 = t.runner.run('p1', 'flow', {});
  await until(() => t.last()?.status === 'waiting');
  t.runner.respond(r2.runId, 'c', { approve: false });
  await until(() => t.last()?.status === 'stopped');
  // non-zero exit
  t = setup({ methodology: m, exec: async () => ({ code: 3, stdout: '', stderr: 'bad thing' }) });
  const r3 = t.runner.run('p1', 'flow', {});
  await until(() => t.last()?.status === 'waiting');
  t.runner.respond(r3.runId, 'c', { approve: true });
  await until(() => t.last()?.status === 'error');
  assert.match(t.last().nodes.c.message, /Exit code 3: bad thing/);
  // deny-list: never even asks
  for (const exe of ['powershell', 'PWSH.exe', 'cmd', 'C:\\Windows\\System32\\cmd.exe', 'curl', 'certutil', 'Invoke-WebRequest', 'x.bat', 'a;b', 'a|b', 'a&b', 'a>b', 'a`b', 'a\nb', 'rel\\dir\\tool']) {
    assert.throws(() => checkExe(exe), /Blocked|metacharacters|bare name|empty/, exe);
  }
  assert.equal(checkExe('node'), 'node');
  assert.equal(checkExe('C:\\Program Files\\Git\\bin\\git.exe'), 'C:\\Program Files\\Git\\bin\\git.exe');
  assert.throws(() => checkExe('powershell'), /colleagues or imports/);
  t = setup({ methodology: base([{ id: 'c', type: 'command', title: 'C', exe: 'powershell', args: ['-c', 'x'] }], []), exec });
  t.runner.run('p1', 'flow', {});
  await until(() => t.last()?.status === 'error');
  assert.match(t.last().error, /not allowed/);
  assert.equal(calls.length, 1);
});

test('checkpoint rejection stops the run', async () => {
  const m = base([{ id: 'cp', type: 'checkpoint', title: 'CP', message: 'ok?' }, { id: 'gc', type: 'git-commit', title: 'G', message: 'm' }], [{ from: 'cp', to: 'gc' }]);
  const t = setup({ methodology: m });
  const { runId } = t.runner.run('p1', 'flow', {});
  await until(() => t.last()?.status === 'waiting');
  t.runner.respond(runId, 'cp', { approve: false });
  await until(() => t.last()?.status === 'stopped');
  assert.equal(t.gitCalls.length, 0);
  assert.equal(t.last().nodes.gc.state, 'pending');
});

test('prompt error / result ok:false => node error and run error', async () => {
  const m = base([{ id: 'p', type: 'prompt', title: 'P', text: 'do' }, { id: 'gc', type: 'git-commit', title: 'G', message: 'm' }], [{ from: 'p', to: 'gc' }]);
  let t = setup({ methodology: m, agentResult: { type: 'error', kind: 'auth', message: 'Please log in' } });
  t.runner.run('p1', 'flow', {});
  await until(() => t.last()?.status === 'error');
  assert.equal(t.last().nodes.p.state, 'error');
  assert.match(t.last().error, /Please log in/);
  assert.equal(t.gitCalls.length, 0);
  t = setup({ methodology: m, agentResult: { type: 'result', ok: false, text: 'model failed' } });
  t.runner.run('p1', 'flow', {});
  await until(() => t.last()?.status === 'error');
  assert.match(t.last().nodes.p.message, /model failed/);
});

test('stop: during a prompt turn stops the agent; during a wait ends the run', async () => {
  const m = base([{ id: 'p', type: 'prompt', title: 'P', text: 'do' }], []);
  let t = setup({ methodology: m, agentResult: 'hang' });
  let { runId } = t.runner.run('p1', 'flow', {});
  await until(() => t.sent.length === 1);
  t.runner.stop(runId);
  await until(() => t.last()?.status === 'stopped');
  assert.equal(t.agents.stopped, true);
  assert.equal(t.runner.state('p1').status, 'stopped');
  const m2 = base([{ id: 'a', type: 'ask-user', title: 'A', question: 'q', saveAs: 'x' }], []);
  t = setup({ methodology: m2 });
  ({ runId } = t.runner.run('p1', 'flow', {}));
  await until(() => t.last()?.status === 'waiting');
  t.runner.stop(runId);
  await until(() => t.last()?.status === 'stopped');
  t.runner.run('p1', 'flow', {}); // slot released
  t.runner.stopAll();
});

test('restart marks persisted running/waiting runs as stopped; forgetProject clears', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'runs'));
  fs.writeFileSync(path.join(dir, 'runs', 'pa.json'), JSON.stringify({ runId: 'r', projectId: 'pa', status: 'waiting', nodes: { a: { state: 'waiting' } }, waiting: { nodeId: 'a' } }));
  fs.writeFileSync(path.join(dir, 'runs', 'pb.json'), JSON.stringify({ runId: 'r2', projectId: 'pb', status: 'done', nodes: {} }));
  const runner = createRunner({ dir, getProject: () => null, getMethodology: () => null, agents: {}, git: {} });
  const a = runner.state('pa');
  assert.equal(a.status, 'stopped');
  assert.ok(a.endedAt);
  assert.equal(a.waiting, undefined);
  assert.equal(a.nodes.a.state, 'skipped');
  assert.equal(runner.state('pb').status, 'done');
  runner.forgetProject('pa');
  assert.equal(runner.state('pa'), null);
});

test('var validation and unknown project/methodology', () => {
  const m = base([{ id: 'a', type: 'checkpoint', title: 'A', message: 'm' }], [], [
    { key: 'req', label: T('r'), type: 'text', required: true },
    { key: 'sel', label: T('s'), type: 'select', options: ['a', 'b'], default: 'a' },
    { key: 'p', label: T('p'), type: 'path' },
  ]);
  const proj = { name: 'Demo', path: 'C:\\d' };
  assert.deepEqual(validateVars(m, { req: 'x', extra: 'ignored' }, proj), { req: 'x', sel: 'a', projectName: 'Demo', projectPath: 'C:\\d' });
  assert.deepEqual(validateVars(m, { req: 'x', projectName: 'evil' }, proj).projectName, 'Demo');
  assert.throws(() => validateVars(m, {}, proj), /required variable: req/);
  assert.throws(() => validateVars(m, { req: '' }, proj), /required/);
  assert.throws(() => validateVars(m, { req: 'x', sel: 'c' }, proj), /one of/);
  assert.throws(() => validateVars(m, { req: 5 }, proj), /string/);
  assert.throws(() => validateVars(m, { req: 'x', p: 'a'.repeat(1025) }, proj), /too long/);
  assert.throws(() => validateVars(m, [], proj), /object/);
  const t = setup({ methodology: m });
  assert.throws(() => t.runner.run('nope', 'flow', {}), /Unknown project/);
  assert.throws(() => t.runner.run('p1', '../x', {}), /invalid methodology id/);
  assert.throws(() => t.runner.run('p1', 'flow', {}), /required/);
  assert.equal(t.runner.state('p1'), null); // failed validation never starts a run
  assert.throws(() => setup({ methodology: { id: 'flow' } }).runner.run('p1', 'flow', {}), /Invalid methodology/);
});

test('agent manager: per-turn agent/mode override does not change the stored project', async () => {
  const store = { id1: { id: 'id1', path: process.cwd(), agent: 'claude', mode: 'default', sessionId: 'S1', autoCommit: false } };
  const projects = { get: (id) => (store[id] ? { ...store[id] } : null), update: (id, p) => Object.assign(store[id], p) };
  const seen = [];
  const mkAdapter = (name) => ({
    run: ({ project, onSession }) => {
      seen.push([name, project.mode, project.sessionId]);
      onSession('NEW');
      return { done: Promise.resolve({ ok: true }), stop() {} };
    },
  });
  const mgr = createAgentManager({
    projects, emit() {}, resolveLauncher: async () => ({ command: 'x' }), adapters: { claude: mkAdapter('claude'), agy: mkAdapter('agy') },
  });
  await mgr.send({ projectId: 'id1', text: 'a', mode: 'plan' });
  await new Promise((r) => setTimeout(r, 10));
  await mgr.send({ projectId: 'id1', text: 'b', agent: 'agy', mode: 'acceptEdits' });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(seen, [['claude', 'plan', 'S1'], ['agy', 'acceptEdits', null]]);
  assert.equal(store.id1.agent, 'claude');
  assert.equal(store.id1.mode, 'default');
  assert.equal(store.id1.sessionId, 'NEW'); // only the non-switched turn persisted its session
});
