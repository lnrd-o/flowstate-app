import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTestCommand, plainStep, plainSteps, stepsState, summaryParts, openableFiles } from '../../src/renderer/lib/plain.js';
import { turnStats, turnMessages } from '../../src/renderer/lib/activity.js';

const ROOT = 'C:\\proj';
const tool = (over) => ({ id: 'm1', turn: 1, role: 'tool', name: 'Write', kind: 'write', input: { file_path: 'C:\\proj\\hello.py', content: 'print(1)\n' }, status: 'done', ...over });

test('isTestCommand recognises common test runners only', () => {
  for (const c of ['pytest -q', 'python -m pytest', 'npm test', 'npm run test', 'node --test', 'cargo test', 'go test ./...', 'yarn test']) assert.equal(isTestCommand(c), true, c);
  for (const c of ['python hello.py', 'npm install', 'ls -la', 'echo contest']) assert.equal(isTestCommand(c), false, c);
});

test('write / edit / read / search / list become plain sentences', () => {
  const created = plainStep(tool(), ROOT);
  assert.deepEqual([created.key, created.vars], ['plain.step.created', { file: 'hello.py' }]);
  const edit = tool({ name: 'Edit', kind: 'edit', input: { file_path: 'C:\\proj\\hello.py', old_string: 'a', new_string: 'b' } });
  assert.equal(plainStep(edit, ROOT).key, 'plain.step.changed');
  assert.equal(plainStep(tool({ name: 'Read', kind: 'read', input: { file_path: 'C:\\proj\\hello.py' } }), ROOT).key, 'plain.step.read');
  assert.equal(plainStep(tool({ name: 'Grep', kind: 'search', input: { pattern: 'x' } }), ROOT).key, 'plain.step.searched');
  assert.equal(plainStep(tool({ name: 'LS', kind: 'list', input: {} }), ROOT).key, 'plain.step.looked');
});

test('commands: tests get a pass/fail sentence, other commands a neutral one; failures use exit code', () => {
  const t1 = tool({ name: 'Bash', kind: 'command', input: { command: 'npm test' } });
  assert.equal(plainStep(t1, ROOT).key, 'plain.step.tested');
  assert.equal(plainStep({ ...t1, status: 'error', exitCode: 1 }, ROOT).key, 'plain.step.testFailed');
  const t2 = tool({ name: 'Bash', kind: 'command', input: { command: 'python hello.py' } });
  assert.equal(plainStep(t2, ROOT).key, 'plain.step.ran');
  assert.equal(plainStep({ ...t2, exitCode: 2 }, ROOT).key, 'plain.step.ranFailed');
});

test('running steps use the progressive sentence; blocked steps wait for the user', () => {
  assert.equal(plainStep(tool({ status: 'running' }), ROOT).key, 'plain.step.creating');
  assert.equal(plainStep(tool({ status: 'running' }), ROOT).state, 'running');
  const b = plainStep(tool({ name: 'PowerShell', kind: 'command', input: { command: 'python hello.py' }, status: 'blocked' }), ROOT);
  assert.deepEqual([b.key, b.state], ['plain.step.blockedRun', 'blocked']);
  const bf = plainStep(tool({ status: 'blocked' }), ROOT);
  assert.deepEqual([bf.key, bf.vars.file], ['plain.step.blockedFile', 'hello.py']);
});

test('steps never leak commands, paths, exit codes or tool names', () => {
  const steps = plainSteps([
    tool(), tool({ id: 'm2', name: 'Bash', kind: 'command', input: { command: 'python secret_script.py --flag' }, exitCode: 3, status: 'error' }),
  ], 1, ROOT);
  const text = JSON.stringify(steps);
  assert.equal(/secret_script|--flag|Bash|exit/i.test(text), false);
  assert.equal(stepsState(steps), 'failed');
});

test('stepsState priority: running > blocked > failed > done', () => {
  assert.equal(stepsState([{ state: 'done' }, { state: 'running' }, { state: 'failed' }]), 'running');
  assert.equal(stepsState([{ state: 'blocked' }, { state: 'failed' }]), 'blocked');
  assert.equal(stepsState([{ state: 'done' }]), 'done');
});

test('summary parts count created and changed files; blocked writes are not counted', () => {
  const msgs = [
    tool({ id: 'a', input: { file_path: 'C:\\proj\\hello.py', content: 'x\n' } }),
    tool({ id: 'b', name: 'Edit', kind: 'edit', input: { file_path: 'C:\\proj\\old.py', old_string: 'a', new_string: 'b' } }),
    tool({ id: 'c', input: { file_path: 'C:\\proj\\blocked.py', content: 'x\n' }, status: 'blocked' }),
  ];
  const stats = turnStats(turnMessages(msgs, 1), ROOT);
  assert.deepEqual(summaryParts(stats), [
    { key: 'plain.sum.createdOne', vars: { count: 1 } }, { key: 'plain.sum.changedOne', vars: { count: 1 } },
  ]);
  assert.deepEqual(openableFiles(stats).map((f) => f.path), ['hello.py', 'old.py']);
  assert.equal(summaryParts({ files: [] }).length, 0);
});

test('summary uses plural keys', () => {
  const stats = { files: [{ op: 'create', path: 'a' }, { op: 'create', path: 'b' }] };
  assert.deepEqual(summaryParts(stats), [{ key: 'plain.sum.createdMany', vars: { count: 2 } }]);
});
