import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyBlocked, reasonOf, blockedItems, ruleFor, projectModeFor, allowPlan, validPattern, describeItem, whyKey, itemCommand, RETRY_NOTE, stripRetryNote,
} from '../../src/renderer/lib/approvals.js';
import { sanitizeAllow } from '../../src/main/permissions.js';
import { createChatState, addUserMessage, reduceEvent, resolvePermission } from '../../src/renderer/lib/events.js';

const run = (events) => events.reduce((s, e) => reduceEvent(s, e), addUserMessage(createChatState(), 'go', { agent: 'claude' }));

test('classifyBlocked: approval / permission phrasings are blocked, ordinary failures are not', () => {
  assert.equal(classifyBlocked('This PowerShell command requires approval').blocked, true);
  assert.equal(classifyBlocked("Claude requested permissions to write to C:\\x\\a.txt, but you haven't granted it yet.").blocked, true);
  assert.equal(classifyBlocked('This command requires your permission').blocked, true);
  assert.equal(classifyBlocked('Permission denied: ls /root').blocked, false);
  assert.equal(classifyBlocked('FAIL tests/a.test.js\n expected true').blocked, false);
  assert.equal(classifyBlocked('').blocked, false);
});

test('reasonOf maps event reasons and message hints', () => {
  assert.equal(reasonOf('workingDir', ''), 'workingDir');
  assert.equal(reasonOf('safetyCheck', ''), 'safetyCheck');
  assert.equal(reasonOf('', 'path is outside the project'), 'workingDir');
  assert.equal(reasonOf('', 'whatever'), 'approval');
  assert.equal(whyKey('workingDir'), 'approval.why.workingDir');
  assert.equal(whyKey('x'), 'approval.why.approval');
});

test('reducer: an error result that asks for approval becomes a blocked card, not an error', () => {
  const s = run([
    { type: 'tool-use', id: 'b1', name: 'PowerShell', kind: 'command', input: { command: 'python hello.py' } },
    { type: 'tool-result', id: 'b1', output: 'This PowerShell command requires approval', isError: true },
  ]);
  const m = s.messages.find((x) => x.role === 'tool');
  assert.equal(m.status, 'blocked');
  assert.equal(m.blocked.reason, 'approval');
});

test('reducer: a real failing command with an exit code stays an error', () => {
  const s = run([
    { type: 'tool-use', id: 'c1', name: 'Bash', kind: 'command', input: { command: 'cat x' } },
    { type: 'tool-result', id: 'c1', output: 'requires approval', isError: true, exitCode: 1 },
  ]);
  assert.equal(s.messages.find((x) => x.role === 'tool').status, 'error');
});

test('reducer: permission-denied marks the matching tool card blocked (no separate permission message)', () => {
  const s = run([
    { type: 'tool-use', id: 'w1', name: 'Write', kind: 'write', input: { file_path: 'C:\\p\\a.txt', content: 'x' } },
    { type: 'permission-denied', id: 'w1', tool: 'Write', reason: 'workingDir', message: 'blocked' },
    { type: 'tool-result', id: 'w1', output: 'whatever', isError: true },
  ]);
  assert.equal(s.messages.filter((m) => m.role === 'permission').length, 0);
  const t = s.messages.find((m) => m.role === 'tool');
  assert.deepEqual([t.status, t.blocked.reason], ['blocked', 'workingDir']);
});

test('reducer: a turn that ends with blocked actions gets one pending approval message before the summary', () => {
  const s = run([
    { type: 'tool-use', id: 'b1', name: 'PowerShell', kind: 'command', input: { command: 'python hello.py' } },
    { type: 'permission-denied', id: 'b1', tool: 'PowerShell', reason: 'approval' },
    { type: 'tool-use', id: 'b2', name: 'Write', kind: 'write', input: { file_path: 'C:\\p\\n.txt', content: 'x' } },
    { type: 'permission-denied', id: 'b2', tool: 'Write', reason: 'workingDir' },
    { type: 'result', ok: true, text: 'done' },
  ]);
  const approvals = s.messages.filter((m) => m.role === 'approval');
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].status, 'pending');
  assert.equal(blockedItems(s.messages, s.turn.id).length, 2);
  const s2 = resolvePermission(s, approvals[0].id, 'allowed');
  assert.equal(s2.messages.find((m) => m.role === 'approval').status, 'allowed');
});

test('blockedItems also lists orphan permission messages (denied without a tool card)', () => {
  const s = run([{ type: 'permission-denied', id: 'z', tool: 'Write', reason: 'workingDir', message: 'm' }, { type: 'result', ok: true, text: 'x' }]);
  const items = blockedItems(s.messages, s.turn.id);
  assert.equal(items.length, 1);
  assert.deepEqual([items[0].tool, items[0].kind, items[0].source], ['Write', 'write', 'permission']);
  assert.equal(s.messages.some((m) => m.role === 'approval'), true);
});

test('ruleFor: exact command for shells, exact path for file tools, null otherwise', () => {
  assert.deepEqual(ruleFor({ tool: 'PowerShell', input: { command: 'python hello.py' } }), { tool: 'PowerShell', pattern: 'python hello.py' });
  assert.deepEqual(ruleFor({ tool: 'Bash', input: { command: ' python hello.py ' } }), { tool: 'Bash', pattern: 'python hello.py' });
  assert.deepEqual(ruleFor({ tool: 'Write', input: { file_path: 'C:\\p\\hello.py' } }), { tool: 'Write', pattern: 'C:\\p\\hello.py' });
  assert.deepEqual(ruleFor({ tool: 'Edit', input: { file_path: 'a/b.js' } }), { tool: 'Edit', pattern: 'a/b.js' });
  assert.equal(ruleFor({ tool: 'WebFetch', input: { url: 'https://x' } }), null); // no valid host (no dot)
  assert.deepEqual(ruleFor({ tool: 'WebFetch', input: { url: 'https://Docs.Example.com/a?b=1' } }), { tool: 'WebFetch', pattern: 'domain:docs.example.com' });
  assert.equal(ruleFor({ tool: 'WebFetch', input: { url: 'file:///C:/x' } }), null);
  assert.deepEqual(ruleFor({ tool: 'WebSearch', input: { query: 'cats' } }), { tool: 'WebSearch', pattern: '' });
  assert.equal(ruleFor({ tool: 'Bash', input: { command: 'echo hi > b.txt' } }), null); // redirect writes ignore command rules
  assert.equal(ruleFor({ tool: 'Bash', input: { command: 'echo (whoami)' } }), null);
  assert.equal(ruleFor({ tool: 'Bash', input: { command: 'rm -rf *' } }), null);
  assert.equal(ruleFor({ tool: 'Bash', input: { command: 'a\nb' } }), null);
  assert.equal(ruleFor({ tool: 'Bash', input: {} }), null);
  assert.equal(validPattern('x'.repeat(301)), false);
});

test('every rule ruleFor builds is accepted by the main-process sanitizer', () => {
  const rules = [ruleFor({ tool: 'PowerShell', input: { command: 'python hello.py' } }), ruleFor({ tool: 'Write', input: { file_path: 'C:\\p\\a.txt' } })];
  // Write(...) rules never match in claude; file tools are emitted as Edit(...) (verified on claude 2.1.330)
  rules.push(ruleFor({ tool: 'WebFetch', input: { url: 'https://example.com/x' } }), ruleFor({ tool: 'WebSearch', input: { query: 'q' } }));
  assert.deepEqual(sanitizeAllow(rules), ['PowerShell(python hello.py)', 'Edit(C:\\p\\a.txt)', 'WebFetch(domain:example.com)', 'WebSearch']);
});

test('allowPlan: once for claude when all selected are narrowable; switch otherwise; none when empty', () => {
  const cmd = { id: 'a', tool: 'PowerShell', input: { command: 'python hello.py' } };
  const wr = { id: 'b', tool: 'Write', input: { file_path: 'C:\\p\\n.txt' } };
  const web = { id: 'c', tool: 'WebFetch', input: { url: 'https://x' } };
  assert.deepEqual(allowPlan([cmd], null, 'claude'), { mode: 'once', rules: [{ tool: 'PowerShell', pattern: 'python hello.py' }] });
  assert.equal(allowPlan([cmd, wr], null, 'claude').rules.length, 2);
  assert.deepEqual(allowPlan([cmd, wr], new Set(['b']), 'claude').rules, [{ tool: 'Write', pattern: 'C:\\p\\n.txt' }]);
  assert.equal(allowPlan([cmd, web], null, 'claude').mode, 'switch');
  assert.equal(allowPlan([cmd, web], new Set(['a']), 'claude').mode, 'once');
  assert.equal(allowPlan([cmd], null, 'agy').mode, 'switch');
  assert.equal(allowPlan([cmd], new Set(), 'claude').mode, 'none');
  assert.equal(allowPlan([], null, 'claude').mode, 'none');
});

test('allowPlan dedupes identical rules and refuses more than 5', () => {
  const same = [{ id: 'a', tool: 'Bash', input: { command: 'ls' } }, { id: 'b', tool: 'Bash', input: { command: 'ls' } }];
  assert.equal(allowPlan(same, null, 'claude').rules.length, 1);
  const six = Array.from({ length: 6 }, (_, i) => ({ id: 'i' + i, tool: 'Bash', input: { command: 'echo ' + i } }));
  assert.equal(allowPlan(six, null, 'claude').mode, 'switch');
});

test('describeItem and itemCommand give plain wording', () => {
  assert.equal(describeItem({ kind: 'command', tool: 'Bash', input: { command: 'x' } }, 'C:\\p').key, 'approval.wants.run');
  const w = describeItem({ kind: 'write', tool: 'Write', input: { file_path: 'C:\\p\\hello.py', content: 'x' }, msg: null }, 'C:\\p');
  assert.deepEqual([w.key, w.vars.file], ['approval.wants.create', 'hello.py']);
  assert.equal(describeItem({ kind: 'edit', tool: 'Edit', input: { file_path: 'a/b.js' }, msg: null }, '').key, 'approval.wants.edit');
  assert.equal(describeItem({ kind: 'other', tool: 'WebFetch', input: {} }, '').key, 'approval.wants.use');
  assert.equal(itemCommand({ kind: 'command', input: { command: 'python hello.py' }, msg: null }), 'python hello.py');
  assert.equal(itemCommand({ kind: 'write', input: {} }), '');
});

test('retry note is stripped before a second retry', () => {
  const once = 'make hello\n\n' + RETRY_NOTE;
  assert.equal(stripRetryNote(once), 'make hello');
  assert.equal(stripRetryNote('plain'), 'plain');
});

test('web items: plain-language description, kinds, project mode', () => {
  const fetchItem = { id: 'w1', tool: 'WebFetch', kind: 'web', input: { url: 'https://docs.example.com/x' }, msg: null };
  assert.deepEqual(describeItem(fetchItem, ''), { key: 'approval.wants.fetch', vars: { site: 'docs.example.com' } });
  assert.deepEqual(describeItem({ id: 'w2', tool: 'WebSearch', kind: 'web', input: { query: 'q' }, msg: null }, ''), { key: 'approval.wants.search', vars: {} });
  assert.equal(describeItem({ id: 'w3', tool: 'WebFetch', kind: 'web', input: { url: 'nonsense' }, msg: null }, '').key, 'approval.wants.fetchNoSite');
  assert.equal(projectModeFor([{ id: 'a', kind: 'write' }, { id: 'b', kind: 'edit' }], null), 'acceptEdits');
  assert.equal(projectModeFor([{ id: 'a', kind: 'write' }, { id: 'b', kind: 'command' }], null), 'auto');
  assert.equal(projectModeFor([fetchItem], null), 'auto');
  assert.equal(allowPlan([fetchItem], null, 'claude').mode, 'once');
});
