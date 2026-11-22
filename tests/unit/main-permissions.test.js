import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeAllow, allowArgs, MAX_RULES } from '../../src/main/permissions.js';
import { ClaudeAdapter } from '../../src/main/agents/claude.js';
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
    [{ tool: 'WebFetch', pattern: 'https://x' }], [{ tool: '*', pattern: 'x' }], [{ tool: 'Read', pattern: 'x' }], [{ pattern: 'x' }],
    ['Bash(ls)'], [null], 'Bash(ls)', { tool: 'Bash', pattern: 'ls' },
    Array.from({ length: MAX_RULES + 1 }, (_, i) => ({ tool: 'Bash', pattern: `cmd${i}` })),
  ];
  for (const b of bad) assert.throws(() => sanitizeAllow(b), TypeError, JSON.stringify(b).slice(0, 80));
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
