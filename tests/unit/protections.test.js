import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CATEGORIES, normalizeProtections, validProtections, categoriesOf, protectedCategory, protectionPlan, commandHasPrefix, isOutside, BASE_ALLOW,
} from '../../src/shared/protections.js';
import { sanitizeUnprotect, protectionArgs, sanitizeAllow } from '../../src/main/permissions.js';
import { ClaudeAdapter } from '../../src/main/agents/claude.js';
import { AgyAdapter } from '../../src/main/agents/agy.js';
import { createAgentManager } from '../../src/main/agents/manager.js';
import { allowPlan, protectionOf, unprotectFor, whyKey, classifyBlocked, blockedItems, ruleFor, describeItem } from '../../src/renderer/lib/approvals.js';
import { createProjects } from '../../src/main/projects.js';
import { parseProjectJson, buildProjectJson } from '../../src/main/svc/store.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = 'C:\\Users\\me\\proj';
const cat = (tool, input) => categoriesOf({ tool, input }, ROOT);

test('normalizeProtections: every category defaults ON; validProtections is strict', () => {
  assert.deepEqual(normalizeProtections(undefined), Object.fromEntries(CATEGORIES.map((c) => [c, true])));
  assert.equal(normalizeProtections({ git: false }).git, false);
  assert.equal(normalizeProtections({ git: 'no' }).git, true);
  assert.equal(validProtections({ git: false }), true);
  assert.equal(validProtections({ nope: true }), false);
  assert.equal(validProtections({ git: 1 }), false);
  assert.equal(validProtections([]), false);
  assert.equal(validProtections(null), false);
});

test('classification: sensitive files, delete/move, install, network, git, outside', () => {
  assert.deepEqual(cat('Read', { file_path: `${ROOT}\\.env` }), ['files']);
  assert.deepEqual(cat('Read', { file_path: 'sub/.env.local' }), ['files']);
  assert.deepEqual(cat('Edit', { file_path: `${ROOT}\\keys\\server.PEM` }), ['files']);
  assert.deepEqual(cat('Write', { file_path: `${ROOT}\\id_rsa.pub` }), ['files']);
  assert.deepEqual(cat('Read', { file_path: `${ROOT}\\credentials.json` }), ['files']);
  assert.deepEqual(cat('Read', { file_path: `${ROOT}\\secrets.yml` }), ['files']);
  assert.deepEqual(cat('Write', { file_path: `${ROOT}\\.git\\config` }), ['files']);
  assert.deepEqual(cat('Write', { file_path: `${ROOT}\\.claude\\settings.json` }), ['files']);
  assert.deepEqual(cat('Edit', { file_path: '.flowstate/project.json' }), ['files']);
  assert.deepEqual(cat('Read', { file_path: `${ROOT}\\.git\\config` }), [], 'reading inside .git is fine');
  assert.deepEqual(cat('Write', { file_path: `${ROOT}\\notes.txt` }), []);
  assert.deepEqual(cat('Write', { file_path: `${ROOT}\\environment.md` }), []);
  assert.deepEqual(cat('Bash', { command: 'rm -rf build' }), ['delete']);
  assert.deepEqual(cat('PowerShell', { command: 'remove-item a.txt' }), ['delete']);
  assert.deepEqual(cat('PowerShell', { command: 'Get-Date; Move-Item a b' }), ['delete']);
  assert.deepEqual(cat('Bash', { command: 'echo hi && rm a' }), ['delete'], 'compound commands are seen through');
  assert.deepEqual(cat('Bash', { command: 'pip install requests' }), ['install']);
  assert.deepEqual(cat('Bash', { command: 'python -m pip install x' }), ['install']);
  assert.deepEqual(cat('Bash', { command: 'npx --yes cowsay' }), ['install']);
  assert.deepEqual(cat('Bash', { command: 'npm install' }), ['install']);
  assert.deepEqual(cat('Bash', { command: 'curl -s https://x.y' }), ['network']);
  assert.deepEqual(cat('PowerShell', { command: 'iwr https://x.y' }), ['network']);
  assert.deepEqual(cat('PowerShell', { command: 'Invoke-RestMethod https://x.y' }), ['network']);
  assert.deepEqual(cat('Bash', { command: 'git push origin main' }), ['git']);
  assert.deepEqual(cat('Bash', { command: 'git config user.name x' }), ['git']);
  assert.deepEqual(cat('Read', { file_path: 'C:\\other\\a.txt' }), ['outside']);
  assert.deepEqual(cat('Write', { file_path: 'C:/OTHER/a.txt' }), ['outside']);
  assert.deepEqual(cat('Read', { file_path: 'C:\\Users\\ME\\PROJ\\a.txt' }), [], 'case-insensitive, inside');
  assert.deepEqual(cat('Read', { file_path: `${ROOT}\\..\\x.txt` }), ['outside']);
});

test('classification: ordinary work is NOT protected', () => {
  for (const command of ['node -e "console.log(1)"', 'python hello.py', 'git status', 'git commit -m x', 'npm test', 'npm init -y', 'rmx a', 'curly b', 'ls -la', 'echo rm']) {
    assert.deepEqual(cat('Bash', { command }), [], command);
    assert.deepEqual(cat('PowerShell', { command }), [], command);
  }
  assert.deepEqual(cat('Write', { file_path: `${ROOT}\\src\\app.js` }), []);
  assert.deepEqual(cat('WebFetch', { url: 'https://example.com' }), []);
  assert.equal(commandHasPrefix('Remove-Item x', 'remove-item'), true);
  assert.equal(commandHasPrefix('rmdir x', 'rm'), false);
  assert.equal(isOutside('a/b.txt', ROOT), false);
});

test('protectedCategory honours the per-category toggles', () => {
  const rm = { tool: 'Bash', input: { command: 'rm a' } };
  assert.equal(protectedCategory(rm, undefined, ROOT), 'delete');
  assert.equal(protectedCategory(rm, { delete: false }, ROOT), null);
  assert.equal(protectedCategory({ tool: 'Bash', input: { command: 'rm a; curl x' } }, { delete: false }, ROOT), 'network', 'the next enabled category explains it');
});

test('protectionPlan: deny rules for every enabled category; outside ON runs as acceptEdits + broad allows', () => {
  const p = protectionPlan(undefined, [], ROOT);
  assert.equal(p.permissionMode, 'acceptEdits');
  assert.deepEqual(p.allow, [...BASE_ALLOW]);
  for (const r of ['Bash(rm:*)', 'PowerShell(Remove-Item:*)', 'Bash(pip install:*)', 'Bash(npx:*)', 'Bash(curl:*)', 'PowerShell(iwr:*)', 'PowerShell(Invoke-WebRequest:*)',
    'Bash(git push:*)', 'Bash(git remote:*)', 'Bash(git config:*)', 'Read(**/.env*)', 'Edit(**/.env*)', 'Edit(**/*.pem)', 'Edit(.git/**)', 'Edit(.claude/**)', 'Edit(.flowstate/**)', 'Read(**/id_rsa*)']) {
    assert.ok(p.deny.includes(r), r);
  }
  const noOutside = protectionPlan({ outside: false }, [], ROOT);
  assert.equal(noOutside.permissionMode, 'bypassPermissions');
  assert.deepEqual(noOutside.allow, []);
  assert.ok(noOutside.deny.includes('Bash(rm:*)'));
  const onlyOutside = protectionPlan({ files: false, delete: false, install: false, network: false, git: false }, [], ROOT);
  assert.equal(onlyOutside.permissionMode, 'acceptEdits');
  assert.deepEqual(onlyOutside.deny, []);
  assert.equal(protectionPlan(Object.fromEntries(CATEGORIES.map((c) => [c, false])), [], ROOT), null);
  assert.ok(!protectionPlan({ network: false }, [], ROOT).deny.some((r) => /curl|iwr|wget/.test(r)));
});

test('protectionPlan: "allow once" lifts only the deny rules that action matches', () => {
  const base = protectionPlan(undefined, [], ROOT).deny;
  const rm = protectionPlan(undefined, [{ tool: 'Bash', value: 'rm ok.txt' }], ROOT).deny;
  assert.ok(base.includes('Bash(rm:*)') && !rm.includes('Bash(rm:*)'));
  assert.ok(rm.includes('PowerShell(rm:*)') && rm.includes('Bash(curl:*)') && rm.includes('Bash(pip install:*)'), 'every other protection stays');
  assert.equal(rm.length, base.length - 1);
  const env = protectionPlan(undefined, [{ tool: 'Read', value: `${ROOT}\\.env` }], ROOT).deny;
  assert.ok(!env.includes('Read(**/.env*)') && env.includes('Edit(**/.env*)') && env.includes('Bash(rm:*)'));
  const git = protectionPlan(undefined, [{ tool: 'Write', value: `${ROOT}\\.git\\hooks\\x` }], ROOT).deny;
  assert.ok(!git.includes('Edit(.git/**)') && git.includes('Edit(.claude/**)'));
  const both = protectionPlan(undefined, [{ tool: 'Bash', value: 'cd x && rm a; curl u' }], ROOT).deny;
  assert.ok(!both.includes('Bash(rm:*)') && !both.includes('Bash(curl:*)') && both.includes('Bash(wget:*)'));
  const wrongShell = protectionPlan(undefined, [{ tool: 'PowerShell', value: 'rm a' }], ROOT).deny;
  assert.ok(wrongShell.includes('Bash(rm:*)') && !wrongShell.includes('PowerShell(rm:*)'));
});

test('sanitizeUnprotect: strict', () => {
  assert.deepEqual(sanitizeUnprotect([{ tool: 'Bash', value: 'rm a (b) *' }]), [{ tool: 'Bash', value: 'rm a (b) *' }]);
  assert.deepEqual(sanitizeUnprotect(undefined), []);
  assert.deepEqual(sanitizeUnprotect([{ tool: 'PowerShell', value: 'a\nb' }]), [{ tool: 'PowerShell', value: 'a\nb' }], 'multi-line commands are fine');
  for (const bad of [{}, 'x', [{ tool: 'WebFetch', value: 'x' }], [{ tool: 'Bash' }], [{ tool: 'Bash', value: '  ' }], [{ tool: 'Bash', value: 'a\u0000b' }],
    [{ tool: 'Bash', value: 'x'.repeat(4001) }], Array.from({ length: 11 }, () => ({ tool: 'Bash', value: 'x' })), [null]]) {
    assert.throws(() => sanitizeUnprotect(bad), TypeError);
  }
});

test('claude adapter: Auto builds acceptEdits + allows + deny rules; other modes and agy are untouched', () => {
  const a = new ClaudeAdapter().buildArgs({ mode: 'auto', path: ROOT, sessionId: null });
  assert.equal(a[a.indexOf('--permission-mode') + 1], 'acceptEdits');
  const pairs = (flag) => a.flatMap((x, i) => (x === flag ? [a[i + 1]] : []));
  assert.deepEqual(pairs('--allowedTools'), [...BASE_ALLOW]);
  assert.ok(pairs('--disallowedTools').includes('Bash(curl:*)'));
  // the per-turn "allow once" rules still come last, after the protections
  const r = new ClaudeAdapter().buildArgs({ mode: 'auto', path: ROOT, allow: ['Edit(C:\\o\\w.txt)'], unprotect: [{ tool: 'Bash', value: 'rm a' }] });
  assert.deepEqual(r.slice(-2), ['--allowedTools', 'Edit(C:\\o\\w.txt)']);
  assert.ok(!r.includes('Bash(rm:*)') && r.includes('Bash(curl:*)'));
  for (const mode of ['default', 'acceptEdits', 'plan']) {
    const x = new ClaudeAdapter().buildArgs({ mode, path: ROOT });
    assert.ok(!x.includes('--disallowedTools'), mode);
  }
  assert.equal(protectionArgs({ protections: Object.fromEntries(CATEGORIES.map((c) => [c, false])), path: ROOT }), null);
  const agy = new AgyAdapter().buildArgs({ mode: 'auto', path: ROOT }, 'hi');
  assert.equal(agy[agy.indexOf('--mode') + 1], 'auto');
  assert.ok(!agy.some((x) => /disallowed|deny/i.test(x)), 'agy has no deny rules: protections apply to claude only');
});

test('manager: unprotect is validated and reaches the adapter; never persisted', async () => {
  const seen = [];
  const adapter = { run: (o) => { seen.push(o.project); return { done: Promise.resolve({ ok: true }), stop() {}, child: { pid: 1 } }; } };
  const proj = { id: 'p', path: ROOT, agent: 'claude', mode: 'auto', sessionId: null };
  const m = createAgentManager({ projects: { get: () => proj, update() {} }, resolveLauncher: async () => ({ command: 'x' }), emit() {}, spawn() {}, kill() {}, adapters: { claude: adapter } });
  await m.send({ projectId: 'p', text: 'go', unprotect: [{ tool: 'Bash', value: 'rm a' }] });
  assert.deepEqual(seen[0].unprotect, [{ tool: 'Bash', value: 'rm a' }]);
  await new Promise((r) => setTimeout(r, 5));
  await assert.rejects(m.send({ projectId: 'p', text: 'go', unprotect: [{ tool: 'Nope', value: 'x' }] }), TypeError);
  await new Promise((r) => setTimeout(r, 5));
  await m.send({ projectId: 'p', text: 'again' });
  assert.deepEqual(seen[1].unprotect, [], 'a fresh turn has no exceptions');
  assert.equal(proj.unprotect, undefined);
});

test('projects persist protections (patch, folder file) and reject invalid ones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-prot-'));
  try {
    const projects = createProjects({ dir });
    const p = projects.add({ path: path.join(dir, 'proj') });
    assert.equal(p.protections, undefined, 'unset = every protection ON');
    const u = projects.update(p.id, { protections: { git: false } });
    assert.deepEqual(u.protections, { git: false });
    assert.throws(() => projects.update(p.id, { protections: { git: 'x' } }), TypeError);
    assert.throws(() => projects.update(p.id, { protections: { zzz: true } }), TypeError);
    assert.deepEqual(createProjects({ dir }).get(p.id).protections, { git: false }, 'persisted');
    const json = buildProjectJson({ ...u, name: 'n', agent: 'claude', mode: 'auto' }, 'c', 'n');
    assert.equal(json.protections.git, false);
    assert.equal(json.protections.delete, true);
    assert.equal(parseProjectJson(json).protections.git, false);
    assert.equal(parseProjectJson({ ...json, protections: { git: 'x' } }).protections, undefined);
    assert.equal('protections' in buildProjectJson({ name: 'n', agent: 'claude', mode: 'auto' }, 'c', 'n'), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- renderer: approval card logic ----
const ctx = { agent: 'claude', mode: 'auto', protections: undefined, root: ROOT };
const item = (id, tool, input, kind) => ({ id, tool, kind: kind ?? (tool === 'Bash' || tool === 'PowerShell' ? 'command' : tool === 'Read' ? 'read' : 'write'), input, reason: 'approval' });

test('deny-rule results are recognised as blocked actions', () => {
  assert.equal(classifyBlocked('Permission to use Bash with command pip install requests has been denied.').blocked, true);
  assert.equal(classifyBlocked('<tool_use_error>File is in a directory that is denied by your permission settings.</tool_use_error>').blocked, true);
  assert.equal(classifyBlocked('Permission denied: ls /root').blocked, false);
});

test('protectionOf / whyKey: plain-words reason per category, only for claude in Auto', () => {
  const rm = item('1', 'Bash', { command: 'rm a.txt' });
  assert.equal(protectionOf(rm, ctx), 'delete');
  assert.equal(whyKey('approval', 'delete'), 'approval.why.protected.delete');
  assert.equal(whyKey('approval', null), 'approval.why.approval');
  assert.equal(protectionOf(rm, { ...ctx, mode: 'acceptEdits' }), null);
  assert.equal(protectionOf(rm, { ...ctx, agent: 'agy' }), null);
  assert.equal(protectionOf(rm, { ...ctx, protections: { delete: false } }), null);
  assert.equal(protectionOf(item('2', 'Write', { file_path: 'C:\\o\\x.txt' }), ctx), 'outside');
  assert.equal(protectionOf(item('3', 'Read', { file_path: `${ROOT}\\.env` }), ctx), 'files');
});

test('allowPlan: a protected item is allowed once via unprotect, even when it has no narrow rule; never "for the project"', () => {
  const cmd = item('1', 'Bash', { command: 'pip install "a(b)" > out.txt' });
  assert.equal(ruleFor(cmd), null, 'no narrow CLI rule (parentheses + redirect)');
  const plan = allowPlan([cmd], null, 'claude', ctx);
  assert.equal(plan.mode, 'once');
  assert.deepEqual(plan.rules, []);
  assert.deepEqual(plan.unprotect, [{ tool: 'Bash', value: 'pip install "a(b)" > out.txt' }]);
  assert.equal(plan.protectedSelected, true);
  // without protections context the old behaviour holds
  assert.equal(allowPlan([cmd], null, 'claude').mode, 'switch');
  // outside-project write: allow rule AND unprotect
  const w = item('2', 'Write', { file_path: 'C:\\o\\x.txt' });
  const p2 = allowPlan([w], null, 'claude', ctx);
  assert.deepEqual(p2.rules, [{ tool: 'Write', pattern: 'C:\\o\\x.txt' }]);
  assert.deepEqual(p2.unprotect, [{ tool: 'Write', value: 'C:\\o\\x.txt' }]);
  assert.deepEqual(sanitizeAllow(p2.rules), ['Edit(C:\\o\\x.txt)']);
  // Read outside the project can now be allowed once
  const rd = item('3', 'Read', { file_path: 'C:\\o\\r.txt' });
  assert.deepEqual(sanitizeAllow(allowPlan([rd], null, 'claude', ctx).rules), ['Read(C:\\o\\r.txt)']);
  assert.equal(unprotectFor({ tool: 'Bash', input: {} }), null);
  assert.equal(allowPlan([cmd], null, 'agy', ctx).mode, 'switch');
});

test('describeItem: a blocked Read says what it wants to read', () => {
  assert.deepEqual(describeItem(item('3', 'Read', { file_path: `${ROOT}\\.env` }), ROOT), { key: 'approval.wants.read', vars: { file: '.env' } });
  const items = blockedItems([{ id: 'm', role: 'tool', turn: 't', name: 'Read', status: 'blocked', toolId: 'x', input: { file_path: 'a.txt' }, blocked: { reason: 'approval' } }], 't');
  assert.equal(items[0].kind, 'read');
});
