import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createChatState, reduceEvent, addUserMessage, resolvePermission, failTurn, summarizeTool,
} from '../../src/renderer/lib/events.js';

const run = (events, start = createChatState()) => events.reduce(reduceEvent, start);

test('text-delta appends to the current assistant message', () => {
  const s = run([{ type: 'text-delta', text: 'Hel' }, { type: 'text-delta', text: 'lo' }]);
  assert.equal(s.messages.length, 1);
  assert.equal(s.messages[0].role, 'assistant');
  assert.equal(s.messages[0].text, 'Hello');
  assert.equal(s.messages[0].open, true);
});

test('full text after deltas replaces instead of duplicating', () => {
  const s = run([{ type: 'text-delta', text: 'Hi' }, { type: 'text', text: 'Hi there' }]);
  assert.equal(s.messages.length, 1);
  assert.equal(s.messages[0].text, 'Hi there');
  assert.equal(s.messages[0].open, false);
});

test('text without deltas creates a closed message', () => {
  const s = run([{ type: 'text', text: 'Whole' }]);
  assert.equal(s.messages[0].text, 'Whole');
  assert.equal(s.messages[0].open, false);
});

test('tool-use creates a card that tool-result completes by id', () => {
  let s = run([
    { type: 'text-delta', text: 'Working' },
    { type: 'tool-use', id: 't1', name: 'Bash', input: { command: 'npm test' } },
  ]);
  assert.equal(s.messages[0].open, false);
  const card = s.messages[1];
  assert.equal(card.role, 'tool');
  assert.equal(card.status, 'running');
  assert.equal(card.summary, 'npm test');
  s = reduceEvent(s, { type: 'tool-result', id: 't1', output: 'ok' });
  assert.equal(s.messages.length, 2);
  assert.equal(s.messages[1].status, 'done');
  assert.equal(s.messages[1].output, 'ok');
  s = reduceEvent(s, { type: 'tool-use', id: 't2', name: 'Edit', input: { file_path: 'a.js' } });
  s = reduceEvent(s, { type: 'tool-result', id: 't2', output: 'boom', isError: true });
  assert.equal(s.messages[2].status, 'error');
});

test('tool-result with unknown id creates a completed card', () => {
  const s = run([{ type: 'tool-result', id: 'x', name: 'Read', output: 'data' }]);
  assert.equal(s.messages[0].role, 'tool');
  assert.equal(s.messages[0].status, 'done');
});

test('text after a tool call starts a new assistant message', () => {
  const s = run([
    { type: 'text-delta', text: 'A' },
    { type: 'tool-use', id: 't', name: 'Read', input: {} },
    { type: 'tool-result', id: 't', output: '' },
    { type: 'text-delta', text: 'B' },
  ]);
  assert.deepEqual(s.messages.map((m) => m.role), ['assistant', 'tool', 'assistant']);
  assert.equal(s.messages[2].text, 'B');
});

test('result closes the turn; stopped adds a Stopped marker', () => {
  let s = addUserMessage(createChatState(), 'go');
  assert.equal(s.running, true);
  assert.equal(s.lastPrompt, 'go');
  s = reduceEvent(s, { type: 'text-delta', text: 'partial' });
  s = reduceEvent(s, { type: 'result', ok: false, stopped: true });
  assert.equal(s.running, false);
  assert.equal(s.messages[1].open, false);
  const last = s.messages[s.messages.length - 1];
  assert.equal(last.role, 'system');
  assert.equal(last.key, 'chat.stopped');
});

test('result with text but no streamed text shows the text; failed result shows an error', () => {
  let s = run([{ type: 'result', ok: true, text: 'Done' }], addUserMessage(createChatState(), 'x'));
  assert.equal(s.messages[1].text, 'Done');
  s = run([{ type: 'result', ok: false, text: 'bad' }], addUserMessage(createChatState(), 'x'));
  assert.equal(s.messages[1].role, 'error');
  assert.equal(s.running, false);
});

test('errors create banners; auth sets needsAuth and stops the run', () => {
  let s = addUserMessage(createChatState(), 'x');
  s = reduceEvent(s, { type: 'error', kind: 'auth', message: 'Not logged in' });
  assert.equal(s.messages[1].role, 'error');
  assert.equal(s.messages[1].kind, 'auth');
  assert.equal(s.needsAuth, true);
  assert.equal(s.running, false);
  s = addUserMessage(s, 'again');
  assert.equal(s.needsAuth, false);
  s = reduceEvent(s, { type: 'error', kind: 'parse', message: 'bad line' });
  assert.equal(s.running, true);
});

test('permission-denied creates a pending card once and can be resolved', () => {
  let s = run([
    { type: 'permission-denied', id: 'p1', tool: 'Write', reason: 'workingDir', message: 'blocked' },
    { type: 'permission-denied', id: 'p1', tool: 'Write' },
  ]);
  assert.equal(s.messages.length, 1);
  assert.equal(s.messages[0].status, 'pending');
  s = resolvePermission(s, s.messages[0].id, 'approved');
  assert.equal(s.messages[0].status, 'approved');
});

test('session always-proceed warning and rate-limit flags', () => {
  let s = run([{ type: 'session', sessionId: 's', warning: 'always-proceed' }]);
  assert.equal(s.alwaysProceed, true);
  s = reduceEvent(s, { type: 'rate-limit', status: 'rejected' });
  assert.equal(s.rateLimited, true);
  s = reduceEvent(s, { type: 'rate-limit', status: 'allowed' });
  assert.equal(s.rateLimited, false);
});

test('reducer is pure and ignores junk', () => {
  const s0 = createChatState();
  const frozen = Object.freeze({ ...s0, messages: Object.freeze([]) });
  const s1 = reduceEvent(frozen, { type: 'text-delta', text: 'x' });
  assert.equal(frozen.messages.length, 0);
  assert.equal(s1.messages.length, 1);
  assert.equal(reduceEvent(s0, null), s0);
  assert.equal(reduceEvent(s0, { type: 'nope' }), s0);
});

test('failTurn and summarizeTool', () => {
  const s = failTurn(addUserMessage(createChatState(), 'x'), 'no agent');
  assert.equal(s.running, false);
  assert.equal(s.messages[1].role, 'error');
  assert.equal(summarizeTool('Edit', { file_path: 'src/a.js' }), 'src/a.js');
  assert.equal(summarizeTool('X', null), '');
  assert.ok(summarizeTool('Bash', { command: 'a'.repeat(300) }).length <= 140);
});
