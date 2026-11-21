import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replayHistory, dedupeLive } from '../../src/renderer/lib/history.js';
import { createChatState, reduceEvent } from '../../src/renderer/lib/events.js';

const records = [
  { ts: 1, t: 'user', text: 'Fix the bug' },
  { ts: 2, t: 'event', event: { type: 'session', sessionId: 's1' } },
  { ts: 3, t: 'event', event: { type: 'tool-use', id: 'a', name: 'Edit', input: { file_path: 'x.js' } } },
  { ts: 4, t: 'event', event: { type: 'tool-result', id: 'a', output: 'ok' } },
  { ts: 5, t: 'event', event: { type: 'text', text: 'Done.' } },
  { ts: 6, t: 'event', event: { type: 'result', ok: true } },
  { ts: 7, t: 'user', text: 'Thanks' },
];

test('replay builds user and assistant messages in order and stops running', () => {
  const s = replayHistory(records);
  assert.deepEqual(s.messages.map((m) => m.role), ['user', 'tool', 'assistant', 'user']);
  assert.equal(s.messages[0].text, 'Fix the bug');
  assert.equal(s.messages[1].status, 'done');
  assert.equal(s.messages[2].text, 'Done.');
  assert.equal(s.running, false);
  assert.equal(s.lastPrompt, 'Thanks');
});

test('replay ignores junk records and tolerates non-arrays', () => {
  assert.equal(replayHistory(null).messages.length, 0);
  assert.equal(replayHistory([null, 5, { t: 'user' }, { t: 'event' }, { t: 'x' }]).messages.length, 0);
});

test('replay then live events continue the same state', () => {
  const s = replayHistory(records);
  const live = reduceEvent(s, { type: 'text-delta', text: 'more' });
  assert.equal(live.messages.length, s.messages.length + 1);
  assert.equal(live.messages.at(-1).text, 'more');
});

test('replay can start from an existing state', () => {
  const base = reduceEvent(createChatState(), { type: 'text', text: 'hi' });
  assert.equal(replayHistory([{ t: 'user', text: 'u' }], base).messages.length, 2);
});

test('dedupeLive drops buffered events already persisted, keeps others', () => {
  const live = [
    { type: 'tool-result', id: 'a', output: 'ok' },
    { type: 'text-delta', text: 'x' },
    { type: 'tool-use', id: 'new', name: 'Bash', input: {} },
  ];
  const out = dedupeLive(records, live);
  assert.deepEqual(out.map((e) => e.type), ['text-delta', 'tool-use']);
  assert.equal(dedupeLive(null, live).length, 3);
});
