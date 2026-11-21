import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeAdapter } from '../../src/main/agents/claude.js';
import { AgyAdapter, agyModeFor } from '../../src/main/agents/agy.js';
import { createAgentManager } from '../../src/main/agents/manager.js';

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'fake-agent.js');
const launcher = (style) => ({ command: process.execPath, baseArgs: [fake, '--style', style] });
const cwd = process.cwd();

test('claude args: resume + permission mode', () => {
  const a = new ClaudeAdapter();
  const base = a.buildArgs({ mode: 'plan', sessionId: null });
  assert.deepEqual(base.slice(0, 7), ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--input-format', 'stream-json']);
  assert.ok(!base.includes('--resume'));
  assert.deepEqual(base.slice(-2), ['--permission-mode', 'plan']);
  const r = a.buildArgs({ mode: 'acceptEdits', sessionId: 's-1' });
  assert.equal(r[r.indexOf('--resume') + 1], 's-1');
  assert.equal(a.buildArgs({ mode: 'bogus' }).slice(-1)[0], 'default');
  const line = a.stdinPayload('hi "there"');
  assert.ok(line.endsWith('\n'));
  assert.deepEqual(JSON.parse(line), { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi "there"' }] } });
});

test('agy args: -p= attached, conversation resume, never always-proceed', () => {
  const a = new AgyAdapter();
  for (const mode of ['default', 'acceptEdits', 'plan', undefined]) {
    const args = a.buildArgs({ mode, sessionId: null }, 'do it');
    assert.ok(args.includes('-p=do it'));
    assert.ok(!args.includes('-p'));
    assert.ok(!args.some((x) => /always-proceed/.test(x)));
    assert.ok(['plan', 'accept-edits'].includes(args[args.indexOf('--mode') + 1]));
  }
  assert.equal(agyModeFor('plan'), 'plan');
  assert.equal(agyModeFor('default'), 'accept-edits');
  assert.equal(agyModeFor('acceptEdits'), 'accept-edits');
  const r = a.buildArgs({ mode: 'plan', sessionId: 'c-9' }, '-x');
  assert.equal(r[r.indexOf('--conversation') + 1], 'c-9');
  assert.ok(r.includes('-p=-x'));
});

async function runAdapter(adapter, style, project, env = {}) {
  const events = []; const sessions = [];
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    const h = adapter.run({ project: { ...project, path: cwd }, text: 'hello', launcher: launcher(style), emit: (e) => events.push(e), onSession: (s) => sessions.push(s) });
    const r = await h.done;
    return { events, sessions, r };
  } finally {
    for (const k of Object.keys(env)) { if (k in saved) process.env[k] = saved[k]; else delete process.env[k]; }
  }
}

test('claude adapter event flow via fake agent (stdin closed after result)', async () => {
  const { events, sessions, r } = await runAdapter(new ClaudeAdapter(), 'claude', { mode: 'default' });
  assert.deepEqual(events.map((e) => e.type), ['session', 'text-delta', 'text', 'tool-use', 'tool-result', 'result']);
  assert.equal(events.find((e) => e.type === 'text').text, 'echo: hello');
  assert.deepEqual(sessions, ['fake-session-1']);
  assert.equal(r.code, 0);
  assert.ok(r.ok);
});

test('agy adapter event flow (init label always-proceed is not surfaced as a warning)', async () => {
  const { events, sessions, r } = await runAdapter(new AgyAdapter(), 'agy', { mode: 'default' });
  assert.deepEqual(events.map((e) => e.type), ['session', 'text-delta', 'tool-use', 'tool-result', 'result']);
  assert.equal(events[0].warning, undefined);
  assert.equal(events[1].text, 'echo: hello');
  assert.deepEqual(sessions, ['fake-conv-1']);
  assert.ok(r.ok);
  const safe = await runAdapter(new AgyAdapter(), 'agy', { mode: 'plan' }, { FAKE_PERMISSION_MODE: 'plan' });
  assert.equal(safe.events[0].warning, undefined);
});

test('non-zero exit -> error/process with stderr; spawn failure -> error/process', async () => {
  const { events } = await runAdapter(new AgyAdapter(), 'agy', {}, { FAKE_FAIL: '1' });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'error');
  assert.equal(events[0].kind, 'process');
  assert.match(events[0].stderr, /boom/);
  const ev = [];
  const h = new AgyAdapter().run({ project: { path: cwd }, text: 'x', launcher: { command: 'definitely-not-a-real-binary-xyz' }, emit: (e) => ev.push(e) });
  await h.done;
  assert.equal(ev[0].kind, 'process');
});

test('manager: persists sessionId, rejects concurrent send, stop kills, autoCommit on ok', async () => {
  const store = { id1: { id: 'id1', path: cwd, agent: 'claude', mode: 'default', sessionId: null, autoCommit: true } };
  const projects = { get: (id) => (store[id] ? { ...store[id] } : null), update: (id, p) => Object.assign(store[id], p) };
  const events = []; const commits = [];
  const mgr = createAgentManager({
    projects, emit: (id, e) => events.push(e), resolveLauncher: async () => launcher('claude'),
    git: { autoCommit: async (p, t) => { commits.push([p, t]); } },
  });
  process.env.FAKE_DELAY = '30';
  try {
    const { turnId } = await mgr.send({ projectId: 'id1', text: 'hello' });
    assert.ok(turnId);
    assert.deepEqual(mgr.status('id1'), { running: true });
    await assert.rejects(mgr.send({ projectId: 'id1', text: 'again' }), /already running/);
    await new Promise((res) => { const t = setInterval(() => { if (!mgr.status('id1').running) { clearInterval(t); res(); } }, 20); });
    assert.equal(store.id1.sessionId, 'fake-session-1');
    assert.deepEqual(commits, [[cwd, 'hello']]);

    process.env.FAKE_DELAY = '400';
    events.length = 0;
    await mgr.send({ projectId: 'id1', text: 'slow' });
    await new Promise((r) => setTimeout(r, 150));
    mgr.stop('id1');
    await new Promise((res) => { const t = setInterval(() => { if (!mgr.status('id1').running) { clearInterval(t); res(); } }, 20); });
    const last = events.at(-1);
    assert.equal(last.type, 'result');
    assert.equal(last.ok, false);
    assert.equal(commits.length, 1);
  } finally { delete process.env.FAKE_DELAY; }
  await assert.rejects(mgr.send({ projectId: 'nope', text: 'x' }), /Unknown project/);
});
