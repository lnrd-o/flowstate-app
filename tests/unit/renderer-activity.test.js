import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChatState, reduceEvent, addUserMessage } from '../../src/renderer/lib/events.js';
import { replayHistory } from '../../src/renderer/lib/history.js';
import {
  lineDiff, splitLines, makeUnifiedDiff, parseUnifiedDiff, diffFromInput, newFileDiff,
} from '../../src/renderer/lib/diff.js';
import {
  stripAnsi, formatDuration, toolTitle, turnStats, turnMessages, buildTimeline, commandList, changeOf, elapsedSeconds,
} from '../../src/renderer/lib/activity.js';

const run = (events, start = createChatState()) => events.reduce((s, e) => reduceEvent(s, e), start);

test('thinking rows merge consecutive events and accumulate time and tokens', () => {
  let s = run([
    { type: 'thinking', id: 'a', durationMs: 1000, tokens: 100 },
    { type: 'thinking', id: 'b', durationMs: 2500, tokens: 50, outputTokens: 7 },
  ]);
  assert.equal(s.messages.length, 1);
  assert.equal(s.messages[0].role, 'thinking');
  assert.equal(s.messages[0].durationMs, 3500);
  assert.equal(s.messages[0].tokens, 150);
  assert.equal(s.messages[0].steps, 2);
  s = run([{ type: 'thinking', text: 'first' }, { type: 'thinking', text: 'second' }]);
  assert.equal(s.messages[0].text, 'first\n\nsecond');
  s = run([{ type: 'thinking', durationMs: 5 }, { type: 'tool-use', id: 't', name: 'Read', input: {} }, { type: 'thinking', durationMs: 5 }]);
  assert.deepEqual(s.messages.map((m) => m.role), ['thinking', 'tool', 'thinking']);
});

test('a full text after streamed deltas still replaces when a thinking row sits between', () => {
  const s = run([{ type: 'text-delta', text: 'Hi' }, { type: 'thinking', durationMs: 10 }, { type: 'text', text: 'Hi there' }]);
  assert.deepEqual(s.messages.map((m) => m.role), ['assistant', 'thinking']);
  assert.equal(s.messages[0].text, 'Hi there');
});

test('tool-use gets a kind; tool-result enriches with duration, exit code and command output', () => {
  let s = run([
    { type: 'tool-use', id: 'c', name: 'run_command', kind: 'command', input: { CommandLine: 'python hello.py' } },
  ]);
  assert.equal(s.messages[0].kind, 'command');
  assert.equal(s.messages[0].summary, 'python hello.py');
  s = reduceEvent(s, { type: 'tool-result', id: 'c', kind: 'command', output: 'raw', durationMs: 420, exitCode: 0, commandOutput: 'hi' });
  const m = s.messages[0];
  assert.equal(m.status, 'done');
  assert.equal(m.durationMs, 420);
  assert.equal(m.exitCode, 0);
  assert.equal(m.commandOutput, 'hi');
  // non-zero exit is an error state even without isError
  s = run([
    { type: 'tool-use', id: 'd', name: 'run_command', input: { CommandLine: 'bad' } },
    { type: 'tool-result', id: 'd', output: 'x', exitCode: 1, commandOutput: 'boom' },
  ]);
  assert.equal(s.messages[0].kind, 'command');
  assert.equal(s.messages[0].status, 'error');
});

test('file-change attaches to the tool card with the same id, or creates a standalone card', () => {
  const change = { type: 'file-change', id: 'w', path: 'hello.py', op: 'create', added: 3, removed: 0, diff: '@@ -0,0 +1,3 @@\n+a\n+b\n+c', truncated: false };
  let s = run([{ type: 'tool-use', id: 'w', name: 'write_file', input: { TargetFile: 'hello.py' } }, change]);
  assert.equal(s.messages.length, 1);
  assert.equal(s.messages[0].change.added, 3);
  assert.equal(s.messages[0].change.op, 'create');
  assert.equal(s.messages[0].status, 'running');
  s = run([change]);
  assert.equal(s.messages.length, 1);
  assert.equal(s.messages[0].role, 'tool');
  assert.equal(s.messages[0].kind, 'write');
  assert.equal(s.messages[0].status, 'done');
  // tool-use arriving later keeps the change
  s = reduceEvent(s, { type: 'tool-use', id: 'w', name: 'write_file', input: { TargetFile: 'hello.py' } });
  assert.equal(s.messages.length, 1);
  assert.equal(s.messages[0].change.path, 'hello.py');
  assert.equal(reduceEvent(s, { type: 'file-change', id: 'z' }), s);
});

test('turn tracks agent and timestamps; messages are labelled with their turn agent', () => {
  let s = addUserMessage(createChatState(), 'go', { agent: 'agy', now: 1000 });
  s = reduceEvent(s, { type: 'tool-use', id: 't', name: 'run_command', input: { CommandLine: 'ls' } }, { now: 1500 });
  s = reduceEvent(s, { type: 'tool-result', id: 't', output: 'a', exitCode: 0, commandOutput: 'a' }, { now: 2700 });
  s = reduceEvent(s, { type: 'text-delta', text: 'ok' }, { now: 2800 });
  assert.equal(s.turn.agent, 'agy');
  assert.equal(s.turn.startedAt, 1000);
  assert.equal(s.turn.lastEventAt, 2800);
  assert.ok(s.messages.every((m) => m.turn === 1 && m.agent === 'agy'));
  assert.equal(s.messages[1].at, 1500);
  assert.equal(s.messages[1].durationMs, 1200); // derived from timestamps when the event has none
  s = addUserMessage(s, 'again', { agent: 'claude', now: 5000 });
  s = reduceEvent(s, { type: 'text', text: 'x' });
  assert.equal(s.messages.at(-1).agent, 'claude');
  assert.equal(s.messages[2].agent, 'agy');
  assert.equal(s.turn.id, 2);
});

test('result appends a summary marker only when the turn did something', () => {
  const quiet = run([{ type: 'text', text: 'hi' }, { type: 'result', ok: true }], addUserMessage(createChatState(), 'x'));
  assert.ok(!quiet.messages.some((m) => m.role === 'summary'));
  const busy = run([
    { type: 'tool-use', id: 'c', name: 'Bash', input: { command: 'npm test' } },
    { type: 'tool-result', id: 'c', output: 'ok' },
    { type: 'text', text: 'done' },
    { type: 'result', ok: true },
  ], addUserMessage(createChatState(), 'x'));
  assert.equal(busy.messages.at(-1).role, 'summary');
  assert.equal(busy.running, false);
});

test('unknown future event types are harmless', () => {
  const s0 = createChatState();
  assert.equal(reduceEvent(s0, { type: 'hologram', x: 1 }), s0);
  assert.equal(reduceEvent(s0, { type: 'thinking' }).messages.length, 1);
});

test('turnStats counts files, lines, commands, thinking (claude derived diffs included)', () => {
  const s = run([
    { type: 'thinking', durationMs: 2000, tokens: 300 },
    { type: 'tool-use', id: 'e', name: 'Edit', input: { file_path: 'a.js', old_string: 'x', new_string: 'y\nz' } },
    { type: 'tool-result', id: 'e', output: 'ok' },
    { type: 'tool-use', id: 'w', name: 'write_file', input: { TargetFile: 'b.py' } },
    { type: 'file-change', id: 'w', path: 'b.py', op: 'create', added: 3, removed: 0, diff: '@@ -0,0 +1,3 @@\n+1\n+2\n+3' },
    { type: 'tool-result', id: 'w', output: 'ok' },
    { type: 'tool-use', id: 'c', name: 'run_command', input: { CommandLine: 'x' } },
    { type: 'tool-result', id: 'c', output: 'e', exitCode: 2 },
  ]);
  const st = turnStats(turnMessages(s.messages, 0));
  assert.equal(st.files.length, 2);
  assert.equal(st.added, 5);
  assert.equal(st.removed, 1);
  assert.equal(st.commands, 1);
  assert.equal(st.failed, 1);
  assert.equal(st.thinkingMs, 2000);
  assert.equal(st.thinkingTokens, 300);
  const rows = buildTimeline(s.messages, s.turn, 'C:\\proj');
  assert.equal(rows.length, 4);
  assert.equal(rows[0].type, 'thinking');
  assert.equal(commandList(s.messages)[0].exitCode, 2);
});

test('replay labels turns with the given agent and keeps new event types', () => {
  const s = replayHistory([
    { ts: 10, t: 'user', text: 'go' },
    { ts: 11, t: 'event', event: { type: 'thinking', durationMs: 900 } },
    { ts: 12, t: 'event', event: { type: 'tool-use', id: 'w', name: 'write_file', input: { TargetFile: 'a.txt' } } },
    { ts: 13, t: 'event', event: { type: 'file-change', id: 'w', path: 'a.txt', op: 'create', added: 1, removed: 0, diff: '@@ -0,0 +1 @@\n+hi' } },
    { ts: 14, t: 'event', event: { type: 'tool-result', id: 'w', output: 'ok' } },
  ], undefined, { agent: 'agy' });
  assert.deepEqual(s.messages.map((m) => m.role), ['user', 'thinking', 'tool']);
  assert.ok(s.messages.every((m) => m.agent === 'agy'));
  assert.equal(s.messages[2].change.added, 1);
  assert.equal(s.messages[2].durationMs, 2);
});

test('lineDiff and unified diff round trip', () => {
  const ops = lineDiff(['a', 'b', 'c'], ['a', 'B', 'c', 'd']);
  assert.deepEqual(ops.map((o) => o.t), ['ctx', 'del', 'add', 'ctx', 'add']);
  assert.deepEqual(splitLines('a\r\nb\n'), ['a', 'b']);
  assert.deepEqual(splitLines(''), []);
  const d = makeUnifiedDiff('one\ntwo\nthree\n', 'one\n2\nthree\n');
  assert.equal(d, '@@ -1,3 +1,3 @@\n one\n-two\n+2\n three');
  const p = parseUnifiedDiff(d);
  assert.equal(p.added, 1);
  assert.equal(p.removed, 1);
  assert.deepEqual(p.hunks[0].lines.map((l) => [l.type, l.oldNo, l.newNo]), [['ctx', 1, 1], ['del', 2, null], ['add', null, 2], ['ctx', 3, 3]]);
  assert.equal(makeUnifiedDiff('same', 'same'), '');
});

test('parseUnifiedDiff skips file headers and handles no-newline markers', () => {
  const p = parseUnifiedDiff('diff --git a/x b/x\nindex 1..2\n--- a/x\n+++ b/x\n@@ -5,2 +5,2 @@\n a\n-b\n+c\n\\ No newline at end of file\n');
  assert.equal(p.hunks.length, 1);
  assert.equal(p.hunks[0].lines[0].oldNo, 5);
  assert.equal(p.hunks[0].lines.at(-1).type, 'meta');
  assert.equal(parseUnifiedDiff('').hunks.length, 0);
});

test('far apart changes produce separate hunks', () => {
  const a = Array.from({ length: 30 }, (_, i) => 'l' + i).join('\n');
  const b = a.replace('l2\n', 'X\n').replace('l27\n', 'Y\n');
  assert.equal(parseUnifiedDiff(makeUnifiedDiff(a, b)).hunks.length, 2);
});

test('diffFromInput derives claude Edit / MultiEdit / Write diffs and ignores path-only inputs', () => {
  const e = diffFromInput('edit', { file_path: 'a.js', old_string: 'a == b', new_string: 'a === b' });
  assert.equal(e.added, 1);
  assert.equal(e.removed, 1);
  assert.equal(e.derived, true);
  const me = diffFromInput('edit', { file_path: 'a.js', edits: [{ old_string: 'x', new_string: 'y' }, { old_string: 'p', new_string: 'q' }] });
  assert.equal(me.added, 2);
  const w = diffFromInput('write', { file_path: 'n.md', content: 'l1\nl2\n' });
  assert.equal(w.op, 'create');
  assert.equal(w.added, 2);
  assert.equal(diffFromInput('write', { TargetFile: 'x' }), null);
  assert.equal(diffFromInput('read', { file_path: 'x' }), null);
  assert.equal(diffFromInput('write', null), null);
  const big = diffFromInput('write', { file_path: 'b', content: 'x\n'.repeat(1000) });
  assert.equal(big.truncated, true);
  assert.equal(newFileDiff('a\nb'), '@@ -0,0 +1,2 @@\n+a\n+b');
});

test('changeOf prefers the backend file-change over the derived diff', () => {
  const m = { role: 'tool', name: 'Edit', kind: 'edit', status: 'done', input: { file_path: 'a', old_string: 'x', new_string: 'y' }, change: { path: 'a', added: 9, removed: 0, diff: '', op: 'modify' } };
  assert.equal(changeOf(m).added, 9);
  assert.equal(changeOf({ ...m, change: undefined }).derived, true);
  assert.equal(changeOf({ ...m, change: undefined, status: 'error' }), null);
});

test('toolTitle builds human titles', () => {
  const T = (m) => toolTitle({ status: 'done', ...m }, 'C:\\proj');
  assert.deepEqual(T({ name: 'run_command', kind: 'command', input: { CommandLine: 'python hello.py' } }), { key: 'act.title.ran', vars: { cmd: 'python hello.py' } });
  assert.equal(T({ name: 'run_command', kind: 'command', status: 'running', input: { CommandLine: 'x' } }).key, 'act.title.running');
  assert.deepEqual(T({ name: 'Write', input: { file_path: 'C:\\proj\\src\\hello.py', content: 'x' } }), { key: 'act.title.created', vars: { file: 'hello.py' } });
  assert.equal(T({ name: 'Edit', input: { file_path: 'a.js', old_string: 'a', new_string: 'b' } }).key, 'act.title.edited');
  assert.equal(T({ name: 'Read', input: {} }).key, 'act.title.readNoFile');
  assert.equal(T({ name: 'Grep', input: { pattern: 'foo' } }).vars.query, 'foo');
  assert.equal(T({ name: 'list_dir', input: { DirectoryPath: 'C:\\proj\\src' } }).key, 'act.title.listed');
  assert.equal(T({ name: 'mystery_tool', input: {} }), null);
});

test('stripAnsi, formatDuration, elapsedSeconds', () => {
  assert.equal(stripAnsi('\u001b[31mred\u001b[0m ok'), 'red ok');
  assert.equal(stripAnsi('a\r\nb\rc'), 'a\nc');
  assert.equal(stripAnsi('\u001b]0;title\u0007x'), 'x');
  assert.equal(formatDuration(17300), '17.3 s');
  assert.equal(formatDuration(420), '420 ms');
  assert.equal(formatDuration(72000), '1 m 12 s');
  assert.equal(formatDuration(-1), '');
  assert.equal(elapsedSeconds(1000, 4500), 3);
  assert.equal(elapsedSeconds(null, 4500), 0);
});

test('livePhase reports thinking, the running tool and writing', async () => {
  const { livePhase } = await import('../../src/renderer/lib/activity.js');
  let s = addUserMessage(createChatState(), 'go', { now: 100 });
  assert.equal(livePhase(s).key, 'thinking');
  assert.equal(livePhase(s).since, 100);
  s = reduceEvent(s, { type: 'tool-use', id: 't', name: 'run_command', input: { CommandLine: 'ls' } }, { now: 200 });
  const p = livePhase(s, 'C:\proj');
  assert.equal(p.key, 'tool');
  assert.equal(p.since, 200);
  assert.equal(p.title.key, 'act.title.running');
  s = reduceEvent(s, { type: 'tool-result', id: 't', output: '' }, { now: 300 });
  assert.equal(livePhase(s).key, 'thinking');
  s = reduceEvent(s, { type: 'text-delta', text: 'a' }, { now: 400 });
  assert.equal(livePhase(s).key, 'writing');
});
