import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeAllow, allowArgs, validDomain, MAX_RULES } from '../../src/main/permissions.js';
import { ClaudeAdapter, claudeModeFor } from '../../src/main/agents/claude.js';
import { CATEGORIES } from '../../src/shared/protections.js';
import { AgyAdapter } from '../../src/main/agents/agy.js';
import { defaultSettings, createSettings } from '../../src/main/settings.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('sanitizeAllow builds exact Tool(pattern) rules and dedupes', () => {
  assert.deepEqual(sanitizeAllow([{ tool: 'PowerShell', pattern: 'python hello.py' }, { tool: 'Edit', pattern: 'src/a.js' }, { tool: 'PowerShell', pattern: 'python hello.py' }]),
    ['PowerShell(python hello.py)', 'Edit(src/a.js)']);
  assert.deepEqual(sanitizeAllow(undefined), []);
  assert.deepEqual(sanitizeAllow(null), []);
  assert.deepEqual(sanitizeAllow([{ tool: 'Bash', pattern: '  git status  ' }]), ['Bash(git status)']);
});

test('sanitizeAllow rejects anything that would widen or break a rule', () => {
  const bad = [
    [{ tool: 'Bash' }], // pattern required: no tool-wide allow
    [{ tool: 'Bash', pattern: '' }], [{ tool: 'Bash', pattern: '   ' }],
    [{ tool: 'Bash', pattern: 'rm -rf *' }], // wildcard
    [{ tool: 'Bash', pattern: 'echo (hi)' }], [{ tool: 'Bash', pattern: 'a)b' }], // parentheses
    [{ tool: 'Bash', pattern: 'a\nb' }], [{ tool: 'Bash', pattern: 'a\u0000b' }],
    [{ tool: 'Bash', pattern: 'x'.repeat(301) }],
    [{ tool: 'WebFetch', pattern: 'https://x' }], [{ tool: 'WebFetch', pattern: 'domain:*.com' }], [{ tool: 'WebFetch', pattern: 'domain:a.com/path' }],
    [{ tool: 'WebFetch', pattern: 'domain:evil.com:8080' }], [{ tool: 'WebFetch', pattern: 'localhost' }], [{ tool: 'WebFetch' }], [{ tool: 'WebFetch', pattern: 'domain:a.com)' }],
    [{ tool: '*', pattern: 'x' }], [{ tool: 'Grep', pattern: 'x' }], [{ pattern: 'x' }],
    ['Bash(ls)'], [null], 'Bash(ls)', { tool: 'Bash', pattern: 'ls' },
    Array.from({ length: MAX_RULES + 1 }, (_, i) => ({ tool: 'Bash', pattern: `cmd${i}` })),
  ];
  for (const b of bad) assert.throws(() => sanitizeAllow(b), TypeError, JSON.stringify(b).slice(0, 80));
});

test('file tools are emitted as Edit(path) (Write(...) rules do not match in claude), Windows paths kept as-is', () => {
  assert.deepEqual(sanitizeAllow([{ tool: 'Write', pattern: 'C:\\p\\a.txt' }, { tool: 'MultiEdit', pattern: 'C:\\p\\a.txt' }, { tool: 'NotebookEdit', pattern: 'n.ipynb' }]),
    ['Edit(C:\\p\\a.txt)', 'Edit(n.ipynb)']);
});

test('web rules: WebFetch by validated domain, WebSearch tool-wide (only tool allowed without a pattern)', () => {
  assert.deepEqual(sanitizeAllow([{ tool: 'WebFetch', pattern: 'domain:Example.com' }, { tool: 'WebFetch', pattern: 'docs.example.com' }, { tool: 'WebSearch' }, { tool: 'WebSearch', pattern: 'ignored' }]),
    ['WebFetch(domain:example.com)', 'WebFetch(domain:docs.example.com)', 'WebSearch']);
  assert.equal(validDomain('example.com'), true);
  assert.equal(validDomain('127.0.0.1'), true);
  for (const bad of ['', 'localhost', 'a..com', '-a.com', 'a.com.', 'a b.com', '999.1.1.1', 'a.c', 'exa_mple.com', 'a.com/x']) assert.equal(validDomain(bad), false, bad);
});

test('allowArgs repeats the variadic flag once per rule', () => {
  assert.deepEqual(allowArgs(['Bash(ls)', 'Edit(a.js)']), ['--allowedTools', 'Bash(ls)', '--allowedTools', 'Edit(a.js)']);
  assert.deepEqual(allowArgs([]), []);
  assert.deepEqual(allowArgs(undefined), []);
});

test('claude adapter adds per-turn rules after the permission mode; agy ignores them', () => {
  const project = { mode: 'default', sessionId: null, allow: ['PowerShell(python hello.py)'] };
  const args = new ClaudeAdapter().buildArgs(project);
  const i = args.indexOf('--permission-mode');
  assert.deepEqual(args.slice(i, i + 2), ['--permission-mode', 'default']);
  assert.deepEqual(args.slice(i + 2), ['--allowedTools', 'PowerShell(python hello.py)']);
  assert.ok(!new ClaudeAdapter().buildArgs({ mode: 'default' }).includes('--allowedTools'), 'no rules unless requested');
  assert.ok(!new AgyAdapter().buildArgs(project, 'hi').join(' ').includes('allowedTools'));
});

test('claude adapter maps mode auto to bypassPermissions; unknown modes fall back to default', () => {
  const mode = (m) => { const a = new ClaudeAdapter().buildArgs({ mode: m }); return a[a.indexOf('--permission-mode') + 1]; };
  assert.equal(claudeModeFor('auto'), 'bypassPermissions');
  // Auto with the default "always ask" protections runs as acceptEdits + broad allows + deny rules (see protections tests below);
  // with every protection off it is the plain bypassPermissions.
  const off = Object.fromEntries(CATEGORIES.map((c) => [c, false]));
  const a = new ClaudeAdapter().buildArgs({ mode: 'auto', protections: off });
  assert.equal(a[a.indexOf('--permission-mode') + 1], 'bypassPermissions');
  assert.ok(!a.includes('--disallowedTools') && !a.includes('--allowedTools'));
  assert.equal(mode('acceptEdits'), 'acceptEdits');
  assert.equal(mode('plan'), 'plan');
  assert.equal(mode('nope'), 'default');
});

test('developerMode setting: default true, boolean only, persisted', () => {
  assert.equal(defaultSettings('en').developerMode, true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-set-'));
  try {
    const s = createSettings({ dir });
    assert.equal(s.get().developerMode, true);
    assert.equal(s.set({ developerMode: false }).developerMode, false);
    assert.throws(() => s.set({ developerMode: 'yes' }), TypeError);
    assert.equal(createSettings({ dir }).get().developerMode, false, 'persisted across restarts');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
