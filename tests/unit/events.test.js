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
  assert.deepEqual(use[0], { type: 'tool-use', id: 'c1:2', name: 'write_file', kind: 'write', input: { Path: 'a' } });
  const res = normalizeAgy({ event: 'step_update', step_update: { conversation_id: 'c1', step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'write_file', tool_info: { output: '1 lines' } } });
  assert.equal(res[0].id, 'c1:2'); // same id links use and result
  assert.equal(normalizeAgy({ event: 'result', result: { status: 'SUCCESS', response: 'x', duration_seconds: 2 } })[0].ok, true);
});

// ---- rich activity events (shapes copied from a real agy 'rich' capture: write_file, run_command, edit_file) ----
import { classifyTool, toolPaths, parseAgyCommandOutput } from '../../src/shared/events.js';

test('classifyTool covers claude and agy tool names', () => {
  for (const [n, k] of [['Bash', 'command'], ['PowerShell', 'command'], ['run_command', 'command'], ['Edit', 'edit'], ['MultiEdit', 'edit'],
    ['edit_file', 'edit'], ['replace_file_content', 'edit'], ['multi_replace_file_content', 'edit'], ['Write', 'write'], ['write_file', 'write'],
    ['Read', 'read'], ['view_file', 'read'], ['Grep', 'search'], ['grep_search', 'search'], ['find_by_name', 'search'], ['list_dir', 'list'], ['LS', 'list'],
    ['browser_click_element', 'other'], ['', 'other'], [undefined, 'other']]) assert.equal(classifyTool('x', n), k, String(n));
});

test('toolPaths finds the path key of either agent', () => {
  assert.deepEqual(toolPaths({ file_path: 'C:/p/a.py' }), ['C:/p/a.py']);
  assert.deepEqual(toolPaths({ Path: 'C:/p/b.py' }), ['C:/p/b.py']);
  assert.deepEqual(toolPaths({ TargetFile: 'x.js', Other: 'no' }), ['x.js']);
  assert.deepEqual(toolPaths({ CommandLine: 'ls' }), []);
  assert.deepEqual(toolPaths(null), []);
});

test('agy run_command output is parsed into exit code and body (real shape)', () => {
  const raw = 'Created At: 2026-11-21T18:15:30-06:00\nCompleted At: 2026-11-21T18:15:32-06:00\nCommand exited with code 0.\n\nCommand output:\n1\r\n2\r\n3\r\n';
  assert.deepEqual(parseAgyCommandOutput(raw), { exitCode: 0, commandOutput: '1\n2\n3' });
  assert.deepEqual(parseAgyCommandOutput('Command exited with code 1.\n\nCommand output:\nboom'), { exitCode: 1, commandOutput: 'boom' });
  assert.deepEqual(parseAgyCommandOutput(undefined), { exitCode: null, commandOutput: '' });
});

test('agy: tool events carry kind, duration and parsed command result; thinking steps surface timing + tokens', () => {
  const use = normalizeAgy({ event: 'step_update', step_update: { conversation_id: 'c', step_index: 4, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'python hello.py' } } } });
  assert.deepEqual(use, [{ type: 'tool-use', id: 'c:4', name: 'run_command', kind: 'command', input: { CommandLine: 'python hello.py' } }]);
  const res = normalizeAgy({ event: 'step_update', step_update: { conversation_id: 'c', step_index: 4, state: 'DONE', step_type: 'tool', tool_name: 'run_command', duration_seconds: 1.0826, tool_info: { output: 'Command exited with code 0.\n\nCommand output:\n1\r\n' } } });
  assert.equal(res[0].kind, 'command'); assert.equal(res[0].durationMs, 1083); assert.equal(res[0].exitCode, 0); assert.equal(res[0].commandOutput, '1');
  const think = normalizeAgy({ event: 'step_update', step_update: { conversation_id: 'c', step_index: 6, state: 'DONE', step_type: 'agent_response', duration_seconds: 17.31, usage: { thinking_tokens: 1600, output_tokens: 1700 } } });
  assert.deepEqual(think, [{ type: 'thinking', id: 'c:6', durationMs: 17310, tokens: 1600, outputTokens: 1700 }]);
  // a trivial step (no thinking, < 1 s) stays silent; user_input / system_message carry nothing
  assert.deepEqual(normalizeAgy({ event: 'step_update', step_update: { conversation_id: 'c', step_index: 9, state: 'DONE', step_type: 'agent_response', duration_seconds: 0.2, usage: { thinking_tokens: 0 } } }), []);
  assert.deepEqual(normalizeAgy({ event: 'step_update', step_update: { conversation_id: 'c', step_index: 5, state: 'DONE', step_type: 'system_message' } }), []);
  // the final answer step still streams its text AND reports its thinking time
  const last = normalizeAgy({ event: 'step_update', step_update: { conversation_id: 'c', step_index: 11, state: 'DONE', step_type: 'agent_response', text_delta: '\n', duration_seconds: 10.2, usage: { thinking_tokens: 589 } } });
  assert.deepEqual(last.map((e) => e.type), ['thinking']);
});

test('claude: tool-use has kind; thinking blocks become thinking events', () => {
  const evs = normalizeClaude({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'plan: edit then test' }, { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'a.py', old_string: 'x', new_string: 'y' } }] } });
  assert.deepEqual(evs.map((e) => e.type), ['thinking', 'tool-use']);
  assert.equal(evs[0].text, 'plan: edit then test'); assert.equal(evs[1].kind, 'edit');
});

// ---- Phase 7: limits, todos, subagents ----
import { looksLikeLimitText, parseResetFromText } from '../../src/shared/events.js';

test('looksLikeLimitText recognises real-world limit phrasings and ignores normal text', () => {
  for (const t of ["You've hit your limit - resets 3pm", 'Claude AI usage limit reached|1795306200', 'Usage limit reached', 'out of quota until 2026-11-22T10:00:00Z',
    'RESOURCE_EXHAUSTED: quota', 'rate limit exceeded, try again in 5 minutes', 'QUOTA_EXHAUSTED']) assert.equal(looksLikeLimitText(t), true, t);
  for (const t of ['Created hello.py', 'The loop prints squares', '', undefined]) assert.equal(looksLikeLimitText(t), false, String(t));
});

test('parseResetFromText handles ISO, legacy epoch and relative hints', () => {
  assert.equal(parseResetFromText('out of quota until 2026-11-22T10:00:00Z'), Date.parse('2026-11-22T10:00:00Z'));
  assert.equal(parseResetFromText('Claude AI usage limit reached|1795306200'), 1795306200 * 1000);
  assert.equal(parseResetFromText('try again in 2h 30m', 1000), 1000 + 150 * 60000);
  assert.equal(parseResetFromText('resets in 45 minutes', 0), 45 * 60000);
  assert.equal(parseResetFromText('nothing here'), undefined);
});

test('claude: rate_limit_event keeps windows and adds a limit event only when not simply allowed (real capture shape)', () => {
  const allowed = normalizeClaude({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1795306200, rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 0.15, resetsAt: 1795306200, status: 'allowed' } } } });
  assert.deepEqual(allowed.map((e) => e.type), ['rate-limit']);
  const hit = normalizeClaude({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1795306200, rateLimitType: 'seven_day', utilization: 1 } });
  assert.deepEqual(hit.map((e) => e.type), ['rate-limit', 'limit']);
  assert.deepEqual(hit[1], { type: 'limit', agent: 'claude', kind: 'seven_day', status: 'rejected', resetsAt: 1795306200000, utilization: 1 });
  const warn = normalizeClaude({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.9 } });
  assert.equal(warn[1].status, 'warning'); assert.equal(warn[1].kind, 'five_hour');
});

test('claude: assistant API-error with limit text keeps the CLI message verbatim', () => {
  const evs = normalizeClaude({ type: 'assistant', error: 'rate_limit', is_api_error_message: true, message: { content: [{ type: 'text', text: "You've hit your limit - resets 3pm (America/Chicago)" }] } });
  assert.equal(evs.length, 1); assert.equal(evs[0].type, 'limit'); assert.equal(evs[0].message, "You've hit your limit - resets 3pm (America/Chicago)"); assert.equal(evs[0].status, 'rejected');
  // other API errors are not limits and normal assistant text is untouched
  assert.deepEqual(normalizeClaude({ type: 'assistant', error: 'server_error', is_api_error_message: true, message: { content: [{ type: 'text', text: 'Overloaded' }] } }).map((e) => e.type), ['text']);
});

test('claude: TodoWrite becomes a todos event; Task becomes a subagent event', () => {
  const evs = normalizeClaude({ type: 'assistant', message: { content: [
    { type: 'tool_use', id: 't1', name: 'TodoWrite', input: { todos: [{ content: 'Write code', status: 'in_progress', activeForm: 'Writing' }, { content: 'Test', status: 'weird' }] } },
    { type: 'tool_use', id: 't2', name: 'Task', input: { subagent_type: 'Explore', description: 'Find usages' } }] } });
  assert.deepEqual(evs.map((e) => e.type), ['tool-use', 'todos', 'tool-use', 'subagent']);
  assert.deepEqual(evs[1].items, [{ content: 'Write code', status: 'in_progress' }, { content: 'Test', status: 'pending' }]);
  assert.deepEqual(evs[3], { type: 'subagent', id: 't2', name: 'Explore', description: 'Find usages', state: 'running' });
});

test('agy: failed result with quota text yields a limit event; invoke_subagent yields a subagent event', () => {
  const evs = normalizeAgy({ event: 'result', result: { status: 'FAILED', response: 'Usage limit reached. You are out of quota until 2026-11-22T10:00:00Z' } });
  assert.deepEqual(evs.map((e) => e.type), ['limit', 'result']);
  assert.equal(evs[0].agent, 'agy'); assert.equal(evs[0].resetsAt, Date.parse('2026-11-22T10:00:00Z')); assert.match(evs[0].message, /Usage limit reached/);
  assert.deepEqual(normalizeAgy({ event: 'result', result: { status: 'SUCCESS', response: 'done' } }).map((e) => e.type), ['result']);
  const sub = normalizeAgy({ event: 'step_update', step_update: { conversation_id: 'c', step_index: 3, state: 'ACTIVE', step_type: 'tool', tool_name: 'invoke_subagent', tool_info: { parameters: { Name: 'reviewer', Task: 'Review the diff' } } } });
  assert.deepEqual(sub.map((e) => e.type), ['tool-use', 'subagent']); assert.equal(sub[1].name, 'reviewer');
});

test('ndjson parser handles split chunks and bad lines', () => {
  const objs = []; const bad = [];
  const feed = createNdjsonParser((o) => objs.push(o), (l) => bad.push(l));
  feed('{"a":1}\n{"b"'); feed(':2}\nnot json\n');
  assert.deepEqual(objs, [{ a: 1 }, { b: 2 }]);
  assert.deepEqual(bad, ['not json']);
});
