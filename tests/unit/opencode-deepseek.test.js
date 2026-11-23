import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn as realSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createOpencodeNormalizer, NORMALIZERS, looksLikeLimitText, classifyTool } from '../../src/shared/events.js';
import { OpencodeAdapter } from '../../src/main/agents/opencode.js';
import { ClaudeAdapter } from '../../src/main/agents/claude.js';
import { routeOf, deepseekEnv, mergeEnv, DEEPSEEK_BASE_URL } from '../../src/main/agents/routes.js';
import { createAgentManager } from '../../src/main/agents/manager.js';
import { parseOpencodeModels, deepseekModels, claudeList } from '../../src/main/svc/models.js';
import { isOpencodeLoggedInOutput } from '../../src/main/auth-check.js';
import { createDeepseek } from '../../src/main/svc/deepseek.js';
import { groupModelOptions, modelOptions } from '../../src/renderer/lib/models.js';
import { visibleAgents } from '../../src/renderer/components/composer.js';
import { createChatState, reduceEvent } from '../../src/renderer/lib/events.js';

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'fake-agent.js');
const KEY = 'sk-test-SECRET-123456';
const wait = async (m, id) => { for (let i = 0; i < 100 && m.status(id).running; i++) await new Promise((r) => setTimeout(r, 50)); };

test('opencode normalizer: session, text, tool use/result, usage, result', () => {
  const n = createOpencodeNormalizer();
  const evs = [
    { type: 'step_start', sessionID: 'ses_1', part: {} },
    { type: 'text', sessionID: 'ses_1', part: { text: 'hello' } },
    { type: 'tool_use', sessionID: 'ses_1', part: { callID: 'c1', tool: 'bash', state: { status: 'completed', input: { command: 'ls' }, output: 'a\n', metadata: { exit: 0 }, time: { start: 1, end: 11 } } } },
    { type: 'tool_use', sessionID: 'ses_1', part: { callID: 'c2', tool: 'edit', state: { status: 'error', input: { filePath: 'x.txt' }, error: 'nope' } } },
    { type: 'step_finish', sessionID: 'ses_1', part: { reason: 'tool-calls', cost: 0.01, tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 3, write: 0 } } } },
    { type: 'step_finish', sessionID: 'ses_1', part: { reason: 'stop', cost: 0.02, tokens: { input: 5, output: 4, reasoning: 0, cache: { read: 0, write: 0 } } } },
  ].flatMap((j) => n(j));
  assert.deepEqual(evs[0], { type: 'session', sessionId: 'ses_1' });
  assert.equal(evs.filter((e) => e.type === 'session').length, 1);
  assert.deepEqual(evs.find((e) => e.type === 'text'), { type: 'text', text: 'hello' });
  const tu = evs.filter((e) => e.type === 'tool-use');
  assert.equal(tu[0].kind, 'command');
  assert.equal(tu[1].kind, 'edit');
  const tr = evs.filter((e) => e.type === 'tool-result');
  assert.equal(tr[0].exitCode, 0);
  assert.equal(tr[0].commandOutput, 'a');
  assert.equal(tr[0].durationMs, 10);
  assert.equal(tr[1].isError, true);
  assert.equal(tr[1].output, 'nope');
  const res = evs.filter((e) => e.type === 'result');
  assert.equal(res.length, 1);
  assert.equal(res[0].ok, true);
  assert.equal(res[0].usage.input_tokens, 15);
  assert.equal(res[0].usage.output_tokens, 6);
  assert.equal(res[0].usage.cache_read_input_tokens, 3);
  assert.ok(Math.abs(res[0].costUsd - 0.03) < 1e-9);
  assert.equal(typeof NORMALIZERS.opencode, 'function');
  assert.equal(classifyTool('opencode', 'todowrite'), 'other');
});

test('opencode normalizer: error and limit events keep the text verbatim', () => {
  const out = createOpencodeNormalizer()({ type: 'error', error: { name: 'APIError', data: { message: 'Insufficient Balance' } } });
  assert.equal(out[0].type, 'limit');
  assert.equal(out[0].agent, 'opencode');
  assert.equal(out[0].message, 'Insufficient Balance');
  assert.equal(out[1].type, 'error');
  const a = createOpencodeNormalizer()({ type: 'error', error: { name: 'ProviderAuthError', data: { message: 'Invalid API key' } } });
  assert.equal(a[0].kind, 'auth');
  assert.ok(looksLikeLimitText('402 Insufficient Balance'));
});

test('opencode adapter args', () => {
  const a = new OpencodeAdapter();
  const args = a.buildArgs({ mode: 'plan', sessionId: 'ses_9', model: 'deepseek/deepseek-chat' }, 'do it');
  assert.deepEqual(args, ['run', '--format', 'json', '--session', 'ses_9', '--model', 'deepseek/deepseek-chat', '--agent', 'plan', '--', 'do it']);
  assert.deepEqual(a.buildArgs({ mode: 'default', model: 'bad model;rm' }, 'x'), ['run', '--format', 'json', '--', 'x']);
});

test('routes: deepseek route derived from model; key only in env, never in args', () => {
  assert.equal(routeOf({ agent: 'claude', model: 'deepseek-chat' }), 'deepseek');
  assert.equal(routeOf({ agent: 'claude', model: 'opus' }), 'anthropic');
  assert.equal(routeOf({ agent: 'agy', model: 'deepseek-chat' }), 'agy');
  assert.equal(routeOf({ agent: 'opencode' }), 'opencode');
  const env = deepseekEnv(KEY, 'deepseek-reasoner');
  assert.equal(env.ANTHROPIC_BASE_URL, DEEPSEEK_BASE_URL);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, KEY);
  assert.equal(env.ANTHROPIC_MODEL, 'deepseek-reasoner');
  const args = new ClaudeAdapter().buildArgs({ agent: 'claude', model: 'deepseek-reasoner', effort: 'high', mode: 'default' });
  assert.ok(!JSON.stringify(args).includes(KEY));
  assert.ok(args.includes('deepseek-reasoner'));
  assert.ok(!args.includes('--effort'));
  const merged = mergeEnv({ ANTHROPIC_API_KEY: 'x', PATH: 'p' }, env);
  assert.equal(merged.ANTHROPIC_API_KEY, undefined);
  assert.equal(merged.PATH, 'p');
});

test('deepseek service: routeEnv decrypts the key in main only', () => {
  const files = new Map();
  const fsx = {
    statSync: (p) => { if (!files.has(p)) throw new Error('x'); return { size: files.get(p).length }; },
    readFileSync: (p) => files.get(p),
    writeFileSync: (p, d) => files.set(p, d),
    renameSync: (a, b) => { files.set(b, files.get(a)); files.delete(a); },
    mkdirSync() {},
    unlinkSync: (p) => files.delete(p),
  };
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(`enc:${s}`), decryptString: (b) => b.toString().slice(4) };
  const ds = createDeepseek({ dir: 'd', settings: { get: () => ({}) }, safeStorage, fsx });
  assert.deepEqual(ds.routeEnv('deepseek-chat'), { error: 'no-key' });
  assert.deepEqual(ds.setKey(KEY), { ok: true });
  assert.ok(![...files.values()].some((v) => String(v).includes(KEY)));
  assert.equal(ds.routeEnv('deepseek-chat').env.ANTHROPIC_AUTH_TOKEN, KEY);
  assert.deepEqual(ds.routeEnv('opus'), { error: 'invalid-model' });
});

test('model lists: grouping, disabled without key, opencode providers', () => {
  const noKey = claudeList(null, deepseekModels(false));
  const ds = noKey.models.filter((m) => m.group === 'deepseek');
  assert.deepEqual(ds.map((m) => m.id), ['deepseek-chat', 'deepseek-reasoner']);
  assert.ok(ds.every((m) => m.disabled && m.needsKey));
  const withKey = deepseekModels(true, [{ id: 'deepseek-v4-pro' }, { id: 'other' }]);
  assert.ok(withKey.every((m) => !m.disabled));
  assert.ok(withKey.some((m) => m.id === 'deepseek-v4-pro'));
  assert.ok(!withKey.some((m) => m.id === 'other'));
  const g = groupModelOptions(modelOptions(noKey, { agent: 'claude' }, true));
  assert.deepEqual(g.map((x) => x.kind), ['claude', 'deepseek']);
  assert.equal(g[1].options[0].disabled, true);
  const oc = parseOpencodeModels('anthropic/claude-sonnet-4\nopenrouter/deepseek/deepseek-chat\nnoise line\n');
  assert.deepEqual(oc.models.map((m) => m.group), ['opencode:anthropic', 'opencode:openrouter']);
  assert.equal(parseOpencodeModels('', 'Please sign in').error, 'not-signed-in');
  assert.equal(isOpencodeLoggedInOutput('Credentials\n 2 credentials'), true);
  assert.equal(isOpencodeLoggedInOutput('0 credentials\n0 environment variables'), false);
  assert.equal(isOpencodeLoggedInOutput(''), null);
});

test('composer: opencode hidden unless detected', () => {
  assert.deepEqual(visibleAgents({ agent: 'claude' }, { opencode: { found: false } }), ['claude', 'agy']);
  assert.deepEqual(visibleAgents({ agent: 'claude' }, { opencode: { found: true } }), ['claude', 'agy', 'opencode']);
  assert.deepEqual(visibleAgents({ agent: 'opencode' }, null), ['claude', 'agy', 'opencode']);
});

test('reducer shows the route-change notice', () => {
  const s0 = createChatState();
  const s = reduceEvent(s0, { type: 'notice', key: 'chat.routeChanged' });
  assert.ok(s.messages.some((m) => m.role === 'system' && m.key === 'chat.routeChanged'));
});

test('manager: opencode registered, runs the fake agent, session stored with route', async () => {
  const store = new Map([['p1', { id: 'p1', path: process.cwd(), agent: 'opencode', mode: 'default', sessionId: null }]]);
  const events = [];
  const m = createAgentManager({
    projects: { get: (id) => ({ ...store.get(id) }), update: (id, patch) => store.set(id, { ...store.get(id), ...patch }) },
    resolveLauncher: async () => ({ command: process.execPath, baseArgs: [fake, '--style', 'opencode'] }),
    emit: (id, ev, meta) => events.push({ ev, meta }),
  });
  await m.send({ projectId: 'p1', text: 'hi opencode' });
  await wait(m, 'p1');
  const types = events.map((e) => e.ev.type);
  for (const t of ['session', 'text', 'tool-result', 'result']) assert.ok(types.includes(t), t);
  assert.equal(events.find((e) => e.ev.type === 'text').ev.text, 'echo: hi opencode');
  assert.equal(store.get('p1').sessionId, 'ses_fake1');
  assert.equal(store.get('p1').sessionRoute, 'opencode');
});

test('manager: deepseek route injects the key into the child env only; route change = fresh session + notice', async () => {
  const seen = [];
  const store = new Map([['p1', { id: 'p1', path: process.cwd(), agent: 'claude', model: 'deepseek-chat', mode: 'default', sessionId: 'old-anthropic-session', sessionRoute: 'anthropic' }]]);
  const events = [];
  process.env.FAKE_DUMP_ARGS = '1';
  try {
    const m = createAgentManager({
      projects: { get: (id) => ({ ...store.get(id) }), update: (id, patch) => store.set(id, { ...store.get(id), ...patch }) },
      resolveLauncher: async () => ({ command: process.execPath, baseArgs: [fake, '--style', 'claude'] }),
      emit: (id, ev, meta) => events.push({ ev, meta }),
      spawn: (cmd, args, opts) => { seen.push({ args, env: opts.env }); return realSpawn(cmd, args, opts); },
      routeEnv: async (project, route) => (route === 'deepseek' ? { env: deepseekEnv(KEY, project.model) } : null),
    });
    await m.send({ projectId: 'p1', text: 'hello' });
    await wait(m, 'p1');
  } finally { delete process.env.FAKE_DUMP_ARGS; }
  assert.equal(seen.length, 1);
  assert.ok(!JSON.stringify(seen[0].args).includes(KEY));
  assert.ok(!seen[0].args.includes('--resume'), 'old session must not be resumed on another route');
  assert.equal(seen[0].env.ANTHROPIC_AUTH_TOKEN, KEY);
  assert.equal(seen[0].env.ANTHROPIC_BASE_URL, DEEPSEEK_BASE_URL);
  assert.ok(!JSON.stringify(events).includes(KEY), 'key never appears in emitted events');
  const init = events.find((e) => e.ev.type === 'session');
  assert.equal(init.meta.route, 'deepseek');
  assert.deepEqual(init.ev.envSeen, undefined); // normaliser does not forward raw init fields
  assert.ok(events.some((e) => e.ev.type === 'notice' && e.ev.key === 'chat.routeChanged'));
  assert.equal(store.get('p1').sessionRoute, 'deepseek');
  assert.equal(store.get('p1').sessionId, 'fake-session-1');
});

test('manager: deepseek without a key rejects the send before spawning', async () => {
  const store = new Map([['p1', { id: 'p1', path: process.cwd(), agent: 'claude', model: 'deepseek-chat', mode: 'default', sessionId: null }]]);
  const m = createAgentManager({
    projects: { get: (id) => ({ ...store.get(id) }), update() {} },
    resolveLauncher: async () => ({ command: process.execPath, baseArgs: [fake] }),
    emit() {},
    routeEnv: async () => ({ error: 'no-key' }),
  });
  await assert.rejects(() => m.send({ projectId: 'p1', text: 'x' }), /no-key/);
  assert.equal(m.status('p1').running, false);
});

test('opencode 2.x: auth list rows, shell tool kind, closing result without step_finish, edit/write file changes', async () => {
  const { isOpencodeLoggedInOutput } = await import('../../src/main/auth-check.js');
  const { createOpencodeNormalizer, opencodeFileChanges, classifyTool } = await import('../../src/shared/events.js');
  assert.equal(isOpencodeLoggedInOutput('OpenCode Go       OpenCode Go 2               stored\nOpenCode Console  Personal                    stored'), true);
  assert.equal(isOpencodeLoggedInOutput('No credentials found'), false);
  assert.equal(classifyTool('opencode', 'shell'), 'command');
  const n = createOpencodeNormalizer();
  n({ type: 'text', sessionID: 's1', part: { type: 'text', text: 'DONE' } });
  const fin = n.finish();
  assert.equal(fin.type, 'result');
  assert.equal(fin.text, 'DONE');
  assert.equal(n.finish(), null);
  const edit = opencodeFileChanges('t1', 'edit', { metadata: { metadata: { files: [{ file: 'a.txt', patch: 'Index: a.txt\n--- a.txt\n+++ a.txt\n@@ -1 +1 @@\n-x\n+y\n', status: 'modified', additions: 1, deletions: 1 }] } } });
  assert.deepEqual(edit[0], { type: 'file-change', id: 't1', path: 'a.txt', op: 'modify', added: 1, removed: 1, diff: '@@ -1 +1 @@\n-x\n+y\n', truncated: false });
  const write = opencodeFileChanges('t2', 'write', { input: { path: 'dir\\hi.txt', content: 'hola\n' }, output: 'Created file successfully' });
  assert.equal(write[0].path, 'dir/hi.txt');
  assert.equal(write[0].op, 'create');
  assert.equal(write[0].diff, '@@ -0,0 +1,1 @@\n+hola\n');
});

test('opencode installer: only https opencode.ai downloads, install path under ~/.opencode/bin', async () => {
  const { allowedDownloadUrl, opencodeInstallPath, createOpencodeInstaller } = await import('../../src/main/opencode-install.js');
  assert.equal(allowedDownloadUrl('https://opencode.ai/files/bin/2.3.2/opencode-windows-x64.zip'), true);
  assert.equal(allowedDownloadUrl('http://opencode.ai/x.zip'), false);
  assert.equal(allowedDownloadUrl('https://evil.example/opencode.ai.zip'), false);
  assert.equal(allowedDownloadUrl('https://opencode.ai.evil.com/x.zip'), false);
  assert.match(opencodeInstallPath('win32', 'C:\\Users\\me'), /\.opencode[\\/]bin[\\/]opencode\.exe$/);
  const r = await createOpencodeInstaller({ platform: 'sunos', arch: 'x64' }).install();
  assert.equal(r.ok, false);
  assert.equal(r.error, 'unsupported');
});
