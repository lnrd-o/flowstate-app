import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createLoginManager, buildClaudeLoginArgs, isValidEmail } from '../../src/main/login.js';

function fakeChild() {
  const c = new EventEmitter();
  c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
  c.written = [];
  c.stdin = { write: (s) => c.written.push(s), on() {} };
  c.exitCode = null; c.pid = 4242;
  return c;
}
function fakePty() {
  const p = { written: [], killed: 0, size: null, dataCbs: [], exitCbs: [] };
  p.onData = (cb) => p.dataCbs.push(cb);
  p.onExit = (cb) => p.exitCbs.push(cb);
  p.write = (d) => p.written.push(d);
  p.kill = () => { p.killed++; };
  p.resize = (c, r) => { p.size = [c, r]; };
  p.emitData = (d) => p.dataCbs.forEach((f) => f(d));
  p.emitExit = () => p.exitCbs.forEach((f) => f({ exitCode: 0 }));
  return p;
}
function fakeTimers() {
  let id = 0; const t = new Map();
  return {
    setIntervalFn: (fn, ms) => { t.set(++id, { fn, ms, repeat: true }); return id; },
    clearIntervalFn: (i) => t.delete(i),
    setTimeoutFn: (fn, ms) => { t.set(++id, { fn, ms, repeat: false }); return id; },
    clearTimeoutFn: (i) => t.delete(i),
    fire: async (ms, repeatOnly = false) => {
      for (const [i, e] of [...t]) if (e.ms === ms && (!repeatOnly || e.repeat)) { if (!e.repeat) t.delete(i); await e.fn(); }
    },
    count: () => t.size,
  };
}
const tick = () => new Promise((r) => setImmediate(r));

function setup(over = {}) {
  const events = []; const spawned = []; const children = []; const ptys = []; const killed = []; const runs = [];
  const timers = fakeTimers();
  const status = { claude: '{"loggedIn":false}', agy: 'Please sign in to view available models' };
  const m = createLoginManager({
    resolveCli: async (a) => (over.missing === a ? null : `C:\\bin\\${a}.exe`),
    spawn: (cmd, args, opts) => { const c = fakeChild(); spawned.push({ cmd, args, opts }); children.push(c); return c; },
    ptySpawn: (cmd, args, opts) => { const p = fakePty(); ptys.push({ cmd, args, opts, p }); return p; },
    run: async (cmd, args) => {
      runs.push([cmd, ...args]);
      if (args[0] === 'auth' && args[1] === 'status') return { code: 0, stdout: status.claude, stderr: '' };
      if (args[0] === 'models') return { code: 0, stdout: status.agy, stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
    emit: (e) => events.push(e), killTree: (c) => killed.push(c), homedir: () => 'C:\\Users\\x', env: { A: '1' },
    ...timers, ...over.deps,
  });
  return { m, events, spawned, children, ptys, killed, runs, status, timers };
}

test('claude: flag mapping and email validation', () => {
  assert.deepEqual(buildClaudeLoginArgs({}), ['auth', 'login', '--claudeai']);
  assert.deepEqual(buildClaudeLoginArgs({ kind: 'console' }), ['auth', 'login', '--console']);
  assert.deepEqual(buildClaudeLoginArgs({ kind: 'sso', email: 'a.b@corp.example.com' }), ['auth', 'login', '--sso', '--email', 'a.b@corp.example.com']);
  assert.throws(() => buildClaudeLoginArgs({ kind: 'evil' }), /invalid kind/);
  assert.throws(() => buildClaudeLoginArgs({ kind: '__proto__' }), /invalid kind/);
  for (const bad of ['--x@y.com', 'a b@c.com', 'a@b', 'a@b.com --foo', 'a'.repeat(250) + '@b.com', 5]) assert.equal(isValidEmail(bad), false, String(bad));
  assert.throws(() => buildClaudeLoginArgs({ email: 'nope' }), /invalid email/);
});

test('claude: spawns with pipes, no shell, emits url + prompt (no trailing newline), dedupes', async () => {
  const { m, events, spawned, children } = setup();
  const r = await m.start('claude', { kind: 'sso', email: 'me@x.org' });
  assert.deepEqual(r, { ok: true, mode: 'pipe' });
  assert.deepEqual(spawned[0].args, ['auth', 'login', '--sso', '--email', 'me@x.org']);
  assert.equal(spawned[0].opts.shell, false); assert.equal(spawned[0].opts.windowsHide, true);
  assert.deepEqual(spawned[0].opts.stdio, ['pipe', 'pipe', 'pipe']);
  const c = children[0];
  c.stdout.emit('data', 'Opening browser to sign in...\nIf the browser didn\'t open, visit: https://claude.com/cai/oauth/authorize?code=true&x=1\nPaste code he');
  c.stdout.emit('data', 're if prompted > ');
  c.stderr.emit('data', 'visit: https://claude.com/cai/oauth/authorize?code=true&x=1\n');
  const urls = events.filter((e) => e.kind === 'url');
  assert.equal(urls.length, 1);
  assert.equal(urls[0].url, 'https://claude.com/cai/oauth/authorize?code=true&x=1');
  assert.equal(urls[0].agent, 'claude');
  const prompts = events.filter((e) => e.kind === 'prompt');
  assert.equal(prompts.length, 1);
  assert.match(prompts[0].text, /Paste code/);
});

test('claude: input strips newlines, caps length, only while open', async () => {
  const { m, children } = setup();
  m.input('claude', 'abc'); // no session: ignored
  await m.start('claude');
  const c = children[0];
  m.input('claude', 'ab\r\ncd\n');
  m.input('claude', '\n');
  m.input('claude', 'x'.repeat(5000));
  assert.equal(c.written[0], 'abcd\n');
  assert.equal(c.written.length, 2);
  assert.equal(c.written[1].length, 4097);
});

test('claude: exit triggers status recheck and done', async () => {
  const { m, events, children, status } = setup();
  await m.start('claude');
  status.claude = '{"loggedIn":true,"authMethod":"claude.ai"}';
  children[0].emit('close', 0);
  await tick();
  assert.deepEqual(events.at(-1), { agent: 'claude', kind: 'done', ok: true, loggedIn: true });
  assert.equal(m.isOpen('claude'), false);
  const s2 = setup();
  await s2.m.start('claude');
  s2.children[0].emit('close', 1);
  await tick();
  assert.deepEqual(s2.events.at(-1), { agent: 'claude', kind: 'done', ok: false, loggedIn: false });
});

test('claude: missing cli and spawn error', async () => {
  const a = setup({ missing: 'claude' });
  assert.equal((await a.m.start('claude')).ok, false);
  assert.deepEqual(a.events[0], { agent: 'claude', kind: 'error', text: 'not-found' });
  const b = setup();
  await b.m.start('claude');
  b.children[0].emit('error', new Error('boom'));
  assert.equal(b.events.at(-1).kind, 'error');
  assert.equal(b.m.isOpen('claude'), false);
  await assert.rejects(() => b.m.start('nope'), /invalid agent/);
});

test('cancel kills the tree, emits nothing; second start cancels the first', async () => {
  const { m, events, children, killed } = setup();
  await m.start('claude');
  m.cancel('claude');
  assert.equal(killed[0], children[0]);
  children[0].emit('close', 1);
  await tick();
  assert.equal(events.length, 0);
  await m.start('claude');
  await m.start('claude');
  assert.equal(killed.length, 2);
  assert.equal(killed[1], children[1]);
  m.cancelAll();
  assert.equal(killed.length, 3);
});

test('agy: pty options, data forwarding, url dedupe across chunks and ANSI', async () => {
  const { m, events, ptys } = setup();
  const r = await m.start('agy', { cols: 9999, rows: 2 });
  assert.deepEqual(r, { ok: true, mode: 'pty' });
  const { cmd, args, opts, p } = ptys[0];
  assert.equal(cmd, 'C:\\bin\\agy.exe'); assert.deepEqual(args, []);
  assert.equal(opts.cols, 300); assert.equal(opts.rows, 5);
  assert.equal(opts.cwd, 'C:\\Users\\x'); assert.equal(opts.name, 'xterm-256color');
  assert.equal(opts.env.TERM, 'xterm-256color'); assert.equal(opts.env.A, '1');
  p.emitData('Log in: \x1b[34mhttps://accounts.google.com/o/oauth2/v2/au');
  p.emitData('th?client=1\x1b[0m\r\n');
  p.emitData('again https://accounts.google.com/o/oauth2/v2/auth?client=1 \r\n');
  assert.equal(events.filter((e) => e.kind === 'data').length, 3);
  const urls = events.filter((e) => e.kind === 'url');
  assert.equal(urls.length, 1);
  assert.equal(urls[0].url, 'https://accounts.google.com/o/oauth2/v2/auth?client=1');
  m.input('agy', 'x'.repeat(9000));
  assert.equal(p.written[0].length, 8192);
  m.resize('agy', 5, 500);
  assert.deepEqual(p.size, [20, 100]);
});

test('agy: status flip -> status+done, pty killed 1 s later; skips while a check is in flight', async () => {
  const { m, events, ptys, status, timers } = setup();
  await m.start('agy');
  const p = ptys[0].p;
  await timers.fire(2000, true);
  assert.deepEqual(events.filter((e) => e.kind === 'status'), [{ agent: 'agy', kind: 'status', loggedIn: false }]);
  await timers.fire(2000, true); // unchanged: nothing new
  assert.equal(events.filter((e) => e.kind === 'status').length, 1);
  status.agy = 'gemini-2.5-pro\tGemini 2.5 Pro\n';
  await timers.fire(2000, true);
  assert.deepEqual(events.slice(-2), [{ agent: 'agy', kind: 'status', loggedIn: true }, { agent: 'agy', kind: 'done', ok: true, loggedIn: true }]);
  assert.equal(p.killed, 0);
  await timers.fire(1000);
  assert.equal(p.killed, 1);
  assert.equal(m.isOpen('agy'), false);
});

test('agy: inconclusive check keeps previous value; pty exit emits done with status', async () => {
  const { m, events, ptys, status, timers } = setup();
  await m.start('agy');
  status.agy = ''; // inconclusive
  await timers.fire(2000, true);
  assert.equal(events.filter((e) => e.kind === 'status').length, 0);
  ptys[0].p.emitExit();
  await tick();
  assert.deepEqual(events.at(-1), { agent: 'agy', kind: 'done', ok: false, loggedIn: false });
});

test('agy: 15 minute timeout closes the session; terminal-unavailable when node-pty fails', async () => {
  const { m, events, ptys, timers } = setup();
  await m.start('agy');
  await timers.fire(15 * 60 * 1000);
  assert.deepEqual(events.at(-1), { agent: 'agy', kind: 'error', text: 'timeout' });
  assert.equal(ptys[0].p.killed, 1);
  assert.equal(m.isOpen('agy'), false);
  const bad = setup({ deps: { ptySpawn: () => { throw new Error('no native'); } } });
  const r = await bad.m.start('agy');
  assert.equal(r.ok, false);
  assert.deepEqual(bad.events.at(-1), { agent: 'agy', kind: 'error', text: 'terminal-unavailable' });
});

test('agy: second start kills the first pty; cancel kills pty', async () => {
  const { m, ptys, events } = setup();
  await m.start('agy'); await m.start('agy');
  assert.equal(ptys[0].p.killed, 1);
  m.cancel('agy');
  assert.equal(ptys[1].p.killed, 1);
  assert.equal(events.length, 0);
});

test('status() and logout()', async () => {
  const { m, status, runs } = setup();
  status.claude = '{"loggedIn":true,"authMethod":"claude.ai","email":"a@b.co"}';
  status.agy = 'gemini\tx\n';
  assert.deepEqual(await m.status(), { claude: { loggedIn: true, authMethod: 'claude.ai', email: 'a@b.co' }, agy: { loggedIn: true }, opencode: { loggedIn: false } });
  status.agy = '';
  assert.equal((await m.status()).agy.loggedIn, true); // keeps previous
  assert.deepEqual(await m.logout('agy'), { ok: false, error: 'use-terminal' });
  assert.deepEqual(await m.logout('claude'), { ok: false, error: 'still-logged-in' });
  status.claude = '{"loggedIn":false}';
  assert.deepEqual(await m.logout('claude'), { ok: true });
  assert.ok(runs.some((r) => r[1] === 'auth' && r[2] === 'logout'));
  const miss = setup({ missing: 'agy' });
  assert.deepEqual((await miss.m.status()).agy, { loggedIn: false });
});

test('node-pty loads and echoes (skipped when the native module is unavailable)', async (t) => {
  let pty;
  try { pty = await import('@lydell/node-pty'); } catch { t.skip('node-pty unavailable'); return; }
  const spawn = pty.spawn ?? pty.default?.spawn;
  const out = await new Promise((resolve, reject) => {
    let buf = '';
    const p = spawn(process.execPath, ['-e', 'console.log("pty-ok")'], { name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env });
    const to = setTimeout(() => { try { p.kill(); } catch { /* ignore */ } reject(new Error('timeout')); }, 10000);
    p.onData((d) => { buf += d; });
    p.onExit(() => { clearTimeout(to); try { p.kill(); } catch { /* already gone */ } resolve(buf); });
  });
  assert.match(out, /pty-ok/);
});
