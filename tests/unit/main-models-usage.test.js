import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeAdapter } from '../../src/main/agents/claude.js';
import { AgyAdapter } from '../../src/main/agents/agy.js';
import { modelArgs, isModel, isEffort } from '../../src/main/agents/model-spec.js';
import { createProjects } from '../../src/main/projects.js';
import { parseAgyModels, claudeList, createModels } from '../../src/main/svc/models.js';
import { parseUsageText, parseResetsAt, tokensOf, createUsage, dayKey, wallToEpoch } from '../../src/main/svc/usage.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fs-mu-'));
const AGY_OUT = 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\ngpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n\n';

test('modelArgs: model + effort only when set, default is never passed, junk is dropped', () => {
  assert.deepEqual(modelArgs({}), []);
  assert.deepEqual(modelArgs({ model: null, effort: null }), []);
  assert.deepEqual(modelArgs({ model: 'default' }), []);
  assert.deepEqual(modelArgs({ model: 'opus', effort: 'high' }), ['--model', 'opus', '--effort', 'high']);
  assert.deepEqual(modelArgs({ model: 'claude-opus-4-6-thinking' }), ['--model', 'claude-opus-4-6-thinking']);
  assert.deepEqual(modelArgs({ model: '--evil x', effort: 'turbo' }), []);
  assert.ok(isModel(null) && isModel('a.b:c/d-e_f') && !isModel('') && !isModel(' x') && !isModel('x'.repeat(81)) && isModel('x'.repeat(80)));
  assert.ok(isEffort(null) && isEffort('xhigh') && !isEffort('ultra'));
});

test('claude args: --model/--effort before --permission-mode (mode stays last without allow rules)', () => {
  const a = new ClaudeAdapter();
  const args = a.buildArgs({ mode: 'plan', sessionId: 's1', model: 'sonnet', effort: 'low' });
  assert.equal(args[args.indexOf('--model') + 1], 'sonnet');
  assert.equal(args[args.indexOf('--effort') + 1], 'low');
  assert.deepEqual(args.slice(-2), ['--permission-mode', 'plan']);
  assert.ok(!a.buildArgs({ mode: 'plan', model: 'default' }).includes('--model'));
});

test('agy args: --model/--effort added, -p= stays attached and last', () => {
  const a = new AgyAdapter();
  const args = a.buildArgs({ mode: 'plan', model: 'gemini-3.8-flash-high', effort: 'max' }, 'do it');
  assert.equal(args[args.indexOf('--model') + 1], 'gemini-3.8-flash-high');
  assert.equal(args[args.indexOf('--effort') + 1], 'max');
  assert.equal(args.at(-1), '-p=do it');
  assert.ok(!a.buildArgs({ mode: 'plan' }, 'x').includes('--model'));
});

test('projects: model / effort / developerMode are validated, patchable and default to null', () => {
  const d = tmp();
  const reg = createProjects({ dir: d });
  const p = reg.add({ path: path.join(d, 'a b') });
  assert.equal(p.model, null); assert.equal(p.effort, null); assert.equal(p.developerMode, null);
  const u = reg.update(p.id, { model: 'opus', effort: 'high', developerMode: false });
  assert.deepEqual([u.model, u.effort, u.developerMode], ['opus', 'high', false]);
  assert.throws(() => reg.update(p.id, { model: 'a b' }), /model/);
  assert.throws(() => reg.update(p.id, { effort: 'ultra' }), /effort/);
  assert.throws(() => reg.update(p.id, { developerMode: 'yes' }), /developerMode/);
  assert.equal(reg.update(p.id, { model: null, developerMode: null }).developerMode, null);
  assert.throws(() => reg.add({ path: path.join(d, 'c'), model: 'bad model' }));
  // old registry entries without the new fields get null defaults
  const reg2 = createProjects({ dir: d });
  assert.equal(reg2.get(p.id).effort, 'high');
});

test('parseAgyModels: real output shape, sign-in and empty cases', () => {
  const r = parseAgyModels(AGY_OUT, 'Fetching available models...\n');
  assert.deepEqual(r.models.map((m) => m.id), ['gemini-3.8-flash-high', 'gemini-3.8-flash-low', 'claude-sonnet-4-6', 'gpt-oss-120b-medium']);
  assert.equal(r.models[3].name, 'GPT-OSS 120B (Medium)');
  assert.equal(r.error, undefined);
  assert.deepEqual(parseAgyModels('', 'Please sign in to continue'), { models: [], error: 'not-signed-in' });
  assert.deepEqual(parseAgyModels('Please sign in', ''), { models: [], error: 'not-signed-in' });
  assert.equal(parseAgyModels('garbage line\n', '').error, 'no-models');
});

test('models service: claude static + current id, agy live with a 60 s cache, errors not cached', async () => {
  let calls = 0; let t = 1000;
  let out = { code: 0, stdout: AGY_OUT, stderr: 'Fetching available models...\n' };
  const svc = createModels({ health: { findAgy: async () => 'C:\\x\\agy.exe' }, run: async (exe, args) => { calls++; assert.deepEqual(args, ['models']); return out; }, now: () => t, getProject: () => ({ agent: 'claude' }) });
  const c = await svc.list('claude');
  assert.deepEqual(c.models.filter((m) => m.group !== 'deepseek').map((m) => m.id), ['default', 'opus', 'sonnet', 'haiku', 'fable']);
  assert.deepEqual(c.efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(c.models[0].name, 'Default (recommended)');
  svc.onAgentEvent('p', { type: 'session', model: 'claude-opus-4-6' }, { agent: 'claude' });
  svc.onAgentEvent('p', { type: 'session', model: 'gemini-x' }, { agent: 'agy' }); // other agent: ignored
  const c2 = await svc.list('claude');
  const seenM = c2.models.find((m) => m.id === 'claude-opus-4-6'); assert.ok(seenM); assert.equal(seenM.current, true);
  assert.equal(claudeList('sonnet').models.find((m) => m.id === 'sonnet').current, true);
  const a1 = await svc.list('agy'); await svc.list('agy');
  assert.equal(a1.source, 'live'); assert.equal(a1.models.length, 4); assert.equal(calls, 1);
  t += 61000; await svc.list('agy'); assert.equal(calls, 2);
  out = { code: 0, stdout: '', stderr: 'Please sign in' }; t += 61000;
  assert.equal((await svc.list('agy')).error, 'not-signed-in');
  out = { code: 0, stdout: AGY_OUT, stderr: '' };
  assert.equal((await svc.list('agy')).error, undefined); // the error was not cached
  await assert.rejects(() => svc.list('gpt'), /invalid agent/);
});

test('parseUsageText: real `claude -p /usage` output', () => {
  const text = 'You are currently using your subscription to power your Claude Code usage\n\nCurrent session: 28% used \u00b7 resets Nov 22, 2:10am (America/Mexico_City)\nCurrent week (all models): 17% used \u00b7 resets Nov 25, 6am (America/Mexico_City)\n\nWhat\'s contributing to your usage?\n';
  const now = Date.UTC(2026, 10, 21, 18, 0, 0);
  const w = parseUsageText(text, now);
  assert.equal(w.five_hour.utilization, 0.28);
  assert.equal(w.seven_day.utilization, 0.17);
  // Mexico City is UTC-6 (no DST since 2022): 2:10am local = 08:10 UTC
  assert.equal(w.five_hour.resetsAt, Date.UTC(2026, 10, 22, 8, 10));
  assert.equal(w.seven_day.resetsAt, Date.UTC(2026, 10, 25, 12, 0));
  assert.equal(w.five_hour.status, 'allowed');
  assert.deepEqual(parseUsageText('nothing here', now), {});
  assert.equal(parseUsageText('Current session: 90% used \u00b7 resets 3pm (UTC)', now).five_hour.status, 'allowed_warning');
});

test('parseResetsAt: time-only rolls to the next occurrence, year rollover, bad zone falls back', () => {
  const now = Date.UTC(2026, 10, 21, 18, 0, 0);
  assert.equal(parseResetsAt('3pm (UTC)', now), Date.UTC(2026, 10, 22, 15, 0));
  assert.equal(parseResetsAt('11:30pm (UTC)', now), Date.UTC(2026, 10, 21, 23, 30));
  assert.equal(parseResetsAt('Jan 2, 1am (UTC)', now), Date.UTC(2027, 0, 2, 1, 0));
  assert.ok(Number.isFinite(parseResetsAt('5pm (Not/AZone)', now)));
  assert.equal(parseResetsAt('soon', now), null);
  assert.equal(wallToEpoch(2026, 6, 1, 12, 0, 'America/New_York'), Date.UTC(2026, 6, 1, 16, 0)); // DST
});

test('tokensOf: claude and agy usage shapes', () => {
  assert.deepEqual(tokensOf({ input_tokens: 2, cache_creation_input_tokens: 10833, cache_read_input_tokens: 27884, output_tokens: 8, output_tokens_details: { thinking_tokens: 3 } }), { input: 38719, output: 8, thinking: 3 });
  assert.deepEqual(tokensOf({ input_tokens: 15999, output_tokens: 107, thinking_tokens: 103, cache_read_tokens: 0, total_tokens: 16106 }), { input: 15999, output: 107, thinking: 103 });
  assert.deepEqual(tokensOf(undefined), { input: 0, output: 0, thinking: 0 });
  assert.deepEqual(tokensOf({ input_tokens: 'x', output_tokens: -4 }), { input: 0, output: 0, thinking: 0 });
});

test('usage service: windows, limits verbatim, per-agent buckets, stale windows, persistence, throttled push', async () => {
  const dir = tmp();
  let t = Date.UTC(2026, 10, 21, 18, 0, 0);
  const pushes = [];
  const timers = [];
  const mk = () => createUsage({
    dir, now: () => t, push: (s) => pushes.push(s), getProject: (id) => ({ agent: id === 'pa' ? 'agy' : 'claude' }),
    setTimeoutFn: (fn, ms) => { const h = { fn, ms }; timers.push(h); return h; }, clearTimeoutFn: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
  });
  const u = mk();
  u.onAgentEvent('pc', { type: 'rate-limit', status: 'allowed', windows: { five_hour: { utilization: 0.15, resetsAt: Math.floor((t + 3600e3) / 1000), status: 'allowed' }, seven_day: { utilization: 0.55, resetsAt: t + 86400e3, status: 'allowed' } } }, { agent: 'claude' });
  u.onAgentEvent('pc', { type: 'result', ok: true, costUsd: 0.0123, usage: { input_tokens: 2, cache_read_input_tokens: 98, output_tokens: 8 } }, { agent: 'claude' });
  u.onAgentEvent('pc', { type: 'result', ok: true, costUsd: 0.01 }, { agent: 'claude' });
  u.onAgentEvent('pa', { type: 'result', ok: true, usage: { input_tokens: 500, output_tokens: 50, thinking_tokens: 20 } }); // agent from the project
  u.onAgentEvent('pc', { type: 'result', ok: true, usage: { input_tokens: 7, output_tokens: 1 } }, { agent: 'agy' }); // per-turn override wins
  u.onAgentEvent('pc', { type: 'limit', agent: 'claude', kind: 'five_hour', status: 'rejected', resetsAt: t + 1000, message: "You've hit your limit - resets 3pm" });
  u.onAgentEvent('pa', { type: 'limit', agent: 'agy', kind: 'quota', status: 'rejected', message: 'out of quota until 5pm' });
  const s = u.snapshot();
  assert.equal(s.claude.windows.five_hour.utilization, 0.15);
  assert.equal(s.claude.windows.five_hour.resetsAt, Math.floor((t + 3600e3) / 1000) * 1000); // seconds normalised to ms
  assert.equal(s.claude.today.turns, 2); assert.equal(s.claude.today.costUsd, 0.0223);
  assert.equal(s.claude.today.inputTokens, 100); assert.equal(s.claude.today.outputTokens, 8);
  assert.deepEqual([s.agy.today.turns, s.agy.today.inputTokens, s.agy.today.thinkingTokens], [2, 507, 20]);
  assert.equal(s.claude.lastLimit.message, "You've hit your limit - resets 3pm");
  assert.equal(s.claude.lastLimit.projectId, 'pc');
  assert.equal(s.agy.lastLimit.message, 'out of quota until 5pm');
  assert.deepEqual(s.deepseek, { configured: false, today: { inputTokens: 0, outputTokens: 0, turns: 0 } });
  assert.ok(pushes.length >= 1 && pushes.length <= 2, `throttled to 1/s, got ${pushes.length}`);
  // flush -> persisted; a new instance reads it back; windows past their reset time become null
  u.flush();
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, 'usage.json'), 'utf8')).days[dayKey(t)]);
  t += 2 * 3600e3;
  const u2 = mk();
  const s2 = u2.snapshot();
  assert.equal(s2.claude.windows.five_hour, null);
  assert.ok(s2.claude.windows.seven_day);
  assert.equal(s2.claude.today.turns, 2);
  t += 2 * 86400e3; // new local day: today resets, bucket kept
  assert.equal(u2.snapshot().claude.today.turns, 0);
});

test('usage: 30 days kept, deepseek balance via services.deepseek, refresh merges /usage and is throttled to 5 minutes', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'usage.json'), JSON.stringify({ days: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`2026-01-${String(i + 1).padStart(2, '0')}`, {}])) }));
  let t = Date.UTC(2026, 10, 21, 18, 0, 0);
  let runs = 0;
  const u = createUsage({
    dir, now: () => t, health: { findClaude: async () => 'claude.exe' }, services: { deepseek: { status: async () => ({ configured: true, balance: { available: true, currency: 'USD', total: '1.00', granted: '0', toppedUp: '1.00' }, updatedAt: 5 }) } },
    runUsage: async () => { runs++; return { code: 0, stdout: 'Current session: 50% used \u00b7 resets 11pm (UTC)\nCurrent week (all models): 10% used \u00b7 resets Nov 25, 6am (UTC)\n' }; },
  });
  const g = await u.get();
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  assert.equal(g.deepseek.configured, true); assert.equal(g.deepseek.balance.total, '1.00');
  assert.equal(runs, 1);
  assert.equal(u.snapshot().claude.windows.five_hour.utilization, 0.5);
  assert.deepEqual(await u.refresh(), { ok: false, error: 'throttled' });
  t += 301000;
  assert.equal((await u.refresh()).ok, true); assert.equal(runs, 2);
  u.flush();
  assert.ok(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'usage.json'), 'utf8')).days).length <= 31);
  const bad = createUsage({ dir: tmp(), health: { findClaude: async () => 'c' }, runUsage: async () => ({ code: 0, stdout: 'no limits here' }) });
  assert.equal((await bad.refresh(true)).error, 'unparseable');
});

test('parseUsageText: per-model weekly windows and activity summary', async () => {
  const { parseUsageText } = await import('../../src/main/svc/usage.js');
  const txt = [
    'Current session: 15% used · resets Nov 22, 1:10pm (America/Mexico_City)',
    'Current week (all models): 34% used · resets Nov 25, 6am (America/Mexico_City)',
    'Current week (Sonnet only): 12% used · resets Nov 25, 6am (America/Mexico_City)',
    'Last 24h · 1778 requests · 58 sessions',
    '  Top subagents: general-purpose 68%',
    'Last 7d · 2660 requests · 63 sessions',
  ].join('\n');
  const r = parseUsageText(txt, Date.parse('2026-11-22T12:00:00-06:00'));
  assert.equal(r.five_hour.utilization, 0.15);
  assert.equal(r.models.Sonnet.utilization, 0.12);
  assert.deepEqual(r.activity.last24h, { requests: 1778, sessions: 58, topSubagents: [{ name: 'general-purpose', pct: 68 }] });
  assert.equal(r.activity.last7d.sessions, 63);
});
