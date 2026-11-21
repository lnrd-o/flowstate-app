import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeClaude, normalizeAgy, createNdjsonParser } from '../../src/shared/events.js';

// Shapes below are trimmed from real captures (claude 2.1.328, agy) — see docs/spikes.md.

test('claude: init -> session', () => {
  const [e] = normalizeClaude({ type: 'system', subtype: 'init', session_id: 's1', model: 'm', permissionMode: 'default', tools: ['Bash'] });
  assert.deepEqual(e, { type: 'session', sessionId: 's1', model: 'm', permissionMode: 'default', tools: ['Bash'] });
});

test('claude: authentication_failed -> error/auth (real capture when OAuth expired)', () => {
  const evs = normalizeClaude({
    type: 'assistant', error: 'authentication_failed',
    message: { content: [{ type: 'text', text: 'Failed to authenticate: OAuth session expired and could not be refreshed' }] },
  });
  assert.equal(evs.length, 1);
  assert.equal(evs[0].type, 'error');
  assert.equal(evs[0].kind, 'auth');
});

test('claude: assistant text + tool_use, user tool_result', () => {
  const a = normalizeClaude({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } });
  assert.deepEqual(a.map((e) => e.type), ['text', 'tool-use']);
  const r = normalizeClaude({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } });
  assert.deepEqual(r[0], { type: 'tool-result', id: 't1', output: 'ok', isError: false });
});

test('claude: permission_denied and rate_limit_event (real captures)', () => {
  const d = normalizeClaude({ type: 'system', subtype: 'permission_denied', tool_name: 'Write', tool_use_id: 't9', decision_reason_type: 'workingDir', message: 'm' });
  assert.deepEqual(d[0], { type: 'permission-denied', id: 't9', tool: 'Write', reason: 'workingDir', message: 'm' });
  const r = normalizeClaude({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.15 } } } });
  assert.equal(r[0].type, 'rate-limit');
});

test('claude: result maps ok from is_error', () => {
  assert.equal(normalizeClaude({ type: 'result', is_error: true, result: 'x' })[0].ok, false);
  assert.equal(normalizeClaude({ type: 'result', is_error: false, result: 'x', total_cost_usd: 0.01 })[0].costUsd, 0.01);
});

test('agy: init, streamed text, tool use/result, result', () => {
  assert.equal(normalizeAgy({ event: 'init', conversation_id: 'c1', init: { permission_mode: 'always-proceed', tools: [] } })[0].sessionId, 'c1');
  assert.deepEqual(
    normalizeAgy({ event: 'step_update', step_update: { conversation_id: 'c1', step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'hello' } }),
    [{ type: 'text-delta', text: 'hello' }],
  );
  // DONE newline is dropped to avoid duplicating text.
  assert.deepEqual(normalizeAgy({ event: 'step_update', step_update: { conversation_id: 'c1', step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: '\n' } }), []);
  const use = normalizeAgy({ event: 'step_update', step_update: { conversation_id: 'c1', step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'write_file', tool_info: { parameters: { Path: 'a' } } } });
  assert.deepEqual(use[0], { type: 'tool-use', id: 'c1:2', name: 'write_file', input: { Path: 'a' } });
  const res = normalizeAgy({ event: 'step_update', step_update: { conversation_id: 'c1', step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'write_file', tool_info: { output: '1 lines' } } });
  assert.equal(res[0].id, 'c1:2'); // same id links use and result
  assert.equal(normalizeAgy({ event: 'result', result: { status: 'SUCCESS', response: 'x', duration_seconds: 2 } })[0].ok, true);
});

test('ndjson parser handles split chunks and bad lines', () => {
  const objs = []; const bad = [];
  const feed = createNdjsonParser((o) => objs.push(o), (l) => bad.push(l));
  feed('{"a":1}\n{"b"'); feed(':2}\nnot json\n');
  assert.deepEqual(objs, [{ a: 1 }, { b: 2 }]);
  assert.deepEqual(bad, ['not json']);
});
