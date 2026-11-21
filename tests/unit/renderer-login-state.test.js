import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLoginView, startLogin, startResult, cancelLogin, reduceLoginEvent, appendBuffer, MAX_BUFFER, statusChip,
  createSignedIn, applyStatus, applyHealth, applyLoginEvent, errorKey,
} from '../../src/renderer/lib/login-state.js';

const run = (events, v = startResult(startLogin(createLoginView()), { ok: true, mode: 'pipe' })) => events.reduce(reduceLoginEvent, v);

test('start moves idle -> starting -> waiting', () => {
  const s = startLogin(createLoginView());
  assert.equal(s.phase, 'starting');
  assert.equal(startResult(s, { ok: true, mode: 'pty' }).phase, 'waiting');
  assert.equal(startResult(s, { ok: true, mode: 'pty' }).mode, 'pty');
  const bad = startResult(s, { ok: false, error: 'terminal-unavailable' });
  assert.equal(bad.phase, 'error');
  assert.equal(bad.error, 'terminal-unavailable');
});

test('a late start result does not downgrade a finished session', () => {
  let s = startLogin(createLoginView());
  s = reduceLoginEvent(s, { kind: 'done', ok: true, loggedIn: true });
  assert.equal(startResult(s, { ok: true }).phase, 'success');
});

test('claude flow: url -> prompt -> done ok', () => {
  let v = run([{ kind: 'url', url: 'https://claude.ai/x' }]);
  assert.equal(v.url, 'https://claude.ai/x');
  assert.equal(v.prompt, false);
  v = reduceLoginEvent(v, { kind: 'prompt', text: 'Paste code here' });
  assert.equal(v.prompt, true);
  v = reduceLoginEvent(v, { kind: 'done', ok: true, loggedIn: true });
  assert.equal(v.phase, 'success');
  assert.equal(v.loggedIn, true);
});

test('events that arrive while still starting are kept', () => {
  const v = reduceLoginEvent(startLogin(createLoginView()), { kind: 'url', url: 'https://claude.ai/y' });
  assert.equal(v.url, 'https://claude.ai/y');
  assert.equal(v.phase, 'waiting');
});

test('idle view ignores stray events', () => {
  const idle = createLoginView();
  assert.equal(reduceLoginEvent(idle, { kind: 'url', url: 'https://x' }), idle);
  assert.equal(reduceLoginEvent(idle, { kind: 'prompt' }), idle);
  assert.equal(reduceLoginEvent(idle, { kind: 'done', ok: false }), idle);
});

test('status loggedIn=true while active is a success; false only records the flag', () => {
  assert.equal(run([{ kind: 'status', loggedIn: true }]).phase, 'success');
  const v = run([{ kind: 'status', loggedIn: false }]);
  assert.equal(v.phase, 'waiting');
  assert.equal(v.loggedIn, false);
});

test('done not ok -> error with a default reason; explicit error text wins', () => {
  assert.equal(run([{ kind: 'done', ok: false, loggedIn: false }]).error, 'not-signed-in');
  const v = run([{ kind: 'error', text: 'boom' }, { kind: 'done', ok: false }]);
  assert.equal(v.phase, 'error');
  assert.equal(v.error, 'boom');
});

test('done after success never flips to error', () => {
  const v = run([{ kind: 'done', ok: true, loggedIn: true }, { kind: 'done', ok: false }]);
  assert.equal(v.phase, 'success');
});

test('data only wakes starting; malformed events are ignored', () => {
  const s = startLogin(createLoginView());
  assert.equal(reduceLoginEvent(s, { kind: 'data', data: 'x' }).phase, 'waiting');
  assert.equal(reduceLoginEvent(s, null), s);
  assert.equal(reduceLoginEvent(s, { kind: 'wat' }), s);
});

test('cancel resets but keeps the known signed-in flag', () => {
  const v = cancelLogin({ ...run([{ kind: 'url', url: 'https://a' }]), loggedIn: false });
  assert.equal(v.phase, 'idle');
  assert.equal(v.url, null);
  assert.equal(v.loggedIn, false);
});

test('replay buffer keeps the tail', () => {
  const b = appendBuffer('a'.repeat(MAX_BUFFER), 'XYZ');
  assert.equal(b.length, MAX_BUFFER);
  assert.equal(b.slice(-3), 'XYZ');
});

test('status chip mapping', () => {
  assert.deepEqual(statusChip(true), { tone: 'green', key: 'login.signedIn' });
  assert.deepEqual(statusChip(false), { tone: 'amber', key: 'login.signedOut' });
  assert.deepEqual(statusChip(null), { tone: 'muted', key: 'login.unknown' });
  assert.equal(statusChip(undefined).key, 'login.unknown');
});

test('signed-in map merges status, health and events without churn', () => {
  let m = createSignedIn();
  m = applyStatus(m, { claude: { loggedIn: true }, agy: { loggedIn: false } });
  assert.deepEqual(m, { claude: true, agy: false });
  assert.equal(applyStatus(m, { claude: { loggedIn: true }, agy: { loggedIn: false } }), m);
  assert.equal(applyHealth(m, { claude: { loggedIn: null }, agy: {} }), m);
  assert.deepEqual(applyHealth(m, { claude: { loggedIn: false }, agy: { loggedIn: true } }), { claude: false, agy: true });
  assert.deepEqual(applyLoginEvent(m, { agent: 'agy', kind: 'done', ok: true, loggedIn: true }), { claude: true, agy: true });
  assert.equal(applyLoginEvent(m, { agent: 'agy', kind: 'url', url: 'https://x' }), m);
  assert.equal(applyLoginEvent(m, { agent: 'nope', kind: 'status', loggedIn: true }), m);
});

test('error keys', () => {
  assert.equal(errorKey('terminal-unavailable'), 'login.err.terminalUnavailable');
  assert.equal(errorKey('something else'), null);
});
