import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createDeepseek, mapBalance, ORIGIN } from '../../src/main/svc/deepseek.js';
import { sniffMime, imageSize, displayName, create as createAttachments, loadAttachmentImages } from '../../src/main/svc/attachments.js';
import { createTasks } from '../../src/main/svc/tasks.js';
import { ClaudeAdapter } from '../../src/main/agents/claude.js';
import { AgyAdapter } from '../../src/main/agents/agy.js';
import { createAgentManager } from '../../src/main/agents/manager.js';
import { createHistory } from '../../src/main/history.js';
import { CH } from '../../src/shared/ipc.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fs-dat-'));
const KEY = 'sk-test-0123456789abcdef';

// fake safeStorage: "encryption" = reversed bytes with a prefix, so the file never contains the plain key
const fakeSafe = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from(`ENC:${[...s].reverse().join('')}`),
  decryptString: (b) => [...b.toString().slice(4)].reverse().join(''),
});
const BAL = { is_available: true, balance_infos: [{ currency: 'USD', total_balance: '12.34', granted_balance: '2.00', topped_up_balance: '10.34' }] };
const MODELS = { object: 'list', data: [{ id: 'deepseek-chat', object: 'model', owned_by: 'deepseek' }, { id: 'deepseek-reasoner', owned_by: 'deepseek' }] };
const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function mkDeepseek({ enabled = true, safe = fakeSafe(), fetchFn, now } = {}) {
  const dir = tmp();
  const calls = [];
  const settings = { get: () => ({ deepseekEnabled: enabled }) };
  const f = fetchFn ?? (async (url) => resp(200, url.endsWith('/user/balance') ? BAL : MODELS));
  const wrapped = async (url, opts) => { calls.push({ url, opts }); return f(url, opts); };
  return { dir, calls, svc: createDeepseek({ dir, settings, safeStorage: safe, fetchFn: wrapped, now }) };
}
const everything = (dir) => fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');

test('deepseek: success maps balance and models; key stored only encrypted; Bearer header; fixed origin', async () => {
  const { dir, calls, svc } = mkDeepseek();
  assert.deepEqual(svc.setKey(KEY), { ok: true });
  assert.ok(!everything(dir).includes(KEY), 'plain key must not be on disk');
  assert.ok(!everything(dir).includes([...KEY].reverse().join('')), 'not even the fake-encrypted plain text');
  const st = await svc.status(true);
  assert.deepEqual(st.balance, { available: true, currency: 'USD', total: '12.34', granted: '2.00', toppedUp: '10.34' });
  assert.deepEqual(st.models, [{ id: 'deepseek-chat', ownedBy: 'deepseek' }, { id: 'deepseek-reasoner', ownedBy: 'deepseek' }]);
  assert.equal(st.configured, true); assert.equal(st.enabled, true); assert.equal(st.error, undefined);
  assert.deepEqual(calls.map((c) => c.url).sort(), [`${ORIGIN}/models`, `${ORIGIN}/user/balance`]);
  assert.ok(calls.every((c) => c.opts.headers.Authorization === `Bearer ${KEY}` && c.opts.method === 'GET'));
  assert.ok(!JSON.stringify(st).includes(KEY));
  // cache 60 s; force bypasses
  await svc.status(); assert.equal(calls.length, 2);
  await svc.status(true); assert.equal(calls.length, 4);
});

test('deepseek: cache expires after 60 s', async () => {
  let t = 0;
  const { calls, svc } = mkDeepseek({ now: () => t });
  svc.setKey(KEY);
  await svc.status(); t += 59000; await svc.status(); assert.equal(calls.length, 2);
  t += 2000; await svc.status(); assert.equal(calls.length, 4);
});

test('deepseek: 401/403 -> invalid-key, other -> http-<status>, network/timeout -> offline; the key never leaks into the result', async () => {
  for (const [status, code] of [[401, 'invalid-key'], [403, 'invalid-key'], [500, 'http-500'], [429, 'http-429']]) {
    const { svc } = mkDeepseek({ fetchFn: async () => resp(status, {}) });
    svc.setKey(KEY);
    const st = await svc.status(true);
    assert.equal(st.error, code);
    assert.ok(!JSON.stringify(st).includes(KEY));
  }
  const off = mkDeepseek({ fetchFn: async () => { throw new Error(`connect ECONNREFUSED with ${KEY}`); } });
  off.svc.setKey(KEY);
  const st = await off.svc.status(true);
  assert.equal(st.error, 'offline'); assert.ok(!JSON.stringify(st).includes(KEY));
  const hang = createDeepseek({ dir: tmp(), settings: { get: () => ({ deepseekEnabled: true }) }, safeStorage: fakeSafe(), timeoutMs: 20, fetchFn: (_u, o) => new Promise((_r, rej) => o.signal.addEventListener('abort', () => rej(new Error('aborted')))) });
  hang.setKey(KEY);
  assert.equal((await hang.status(true)).error, 'offline');
});

test('deepseek: disabled, no key, encryption unavailable (nothing stored), removal, invalid key', async () => {
  const d = mkDeepseek({ enabled: false });
  d.svc.setKey(KEY);
  assert.deepEqual(await d.svc.status(), { configured: true, enabled: false });
  assert.equal(d.calls.length, 0, 'disabled: no network');
  const n = mkDeepseek();
  assert.deepEqual(await n.svc.status(), { configured: false, enabled: true });
  assert.equal(n.calls.length, 0, 'no key: no network');
  const u = mkDeepseek({ safe: fakeSafe(false) });
  assert.deepEqual(u.svc.setKey(KEY), { ok: false, error: 'encryption-unavailable' });
  assert.deepEqual(fs.readdirSync(u.dir), [], 'NOTHING stored when encryption is unavailable');
  assert.deepEqual((await u.svc.status()).configured, false);
  assert.equal(n.svc.setKey('short').ok, false);
  assert.equal(n.svc.setKey('has space in key').ok, false);
  n.svc.setKey(KEY); assert.equal((await n.svc.status()).configured, true);
  assert.deepEqual(n.svc.setKey(null), { ok: true });
  assert.equal((await n.svc.status()).configured, false);
  assert.equal(mapBalance({}), null);
});

test('deepseek: no log line ever contains the key', async () => {
  const lines = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = (...a) => lines.push(a.join(' '));
  try {
    const { svc } = mkDeepseek({ fetchFn: async () => { throw new Error('boom'); } });
    svc.setKey(KEY); await svc.status(true); svc.setKey(null);
  } finally { Object.assign(console, orig); }
  assert.ok(!lines.join('\n').includes(KEY));
});

// ---- attachments ------------------------------------------------------------------------------------------------------------
function png(w, h, rgb = [255, 0, 0]) {
  const crc = (buf) => { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type, data) => { const t = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgb).flat())]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}
const GIF = Buffer.from('474946383961' + '0a00' + '1400' + '00'.repeat(10), 'hex');
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x30, 0x00, 0x40, 0x01, 0x01, 0x11, 0x00]), Buffer.alloc(8)]);
const webpHeader = (kind, w, h) => {
  const b = Buffer.alloc(40); b.write('RIFF', 0); b.write('WEBP', 8); b.write(kind, 12);
  if (kind === 'VP8 ') { b.writeUInt16LE(w, 26); b.writeUInt16LE(h, 28); } else if (kind === 'VP8L') { b.writeUInt32LE(((w - 1) | ((h - 1) << 14)) >>> 0, 21); } else { b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3); }
  return b;
};

test('attachments: magic bytes and header size parsers', () => {
  const p = png(64, 48);
  assert.equal(sniffMime(p), 'image/png'); assert.deepEqual(imageSize(p, 'image/png'), { width: 64, height: 48 });
  assert.equal(sniffMime(GIF), 'image/gif'); assert.deepEqual(imageSize(GIF, 'image/gif'), { width: 10, height: 20 });
  assert.equal(sniffMime(JPG), 'image/jpeg'); assert.deepEqual(imageSize(JPG, 'image/jpeg'), { width: 64, height: 48 });
  assert.deepEqual(imageSize(webpHeader('VP8 ', 30, 40), 'image/webp'), { width: 30, height: 40 });
  assert.deepEqual(imageSize(webpHeader('VP8L', 31, 41), 'image/webp'), { width: 31, height: 41 });
  assert.deepEqual(imageSize(webpHeader('VP8X', 100, 200), 'image/webp'), { width: 100, height: 200 });
  assert.equal(sniffMime(webpHeader('VP8 ', 1, 1)), 'image/webp');
  assert.equal(sniffMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
  assert.equal(imageSize(Buffer.alloc(30), 'image/png'), null);
  assert.equal(displayName('C:\\evil\\..\\..\\a<b>.png'), 'ab.png'); assert.equal(displayName(''), 'image'); assert.equal(displayName('x/y/z.png'), 'z.png');
});

function mkAttach(dirName = 'my project') {
  const root = tmp(); const proj = path.join(root, dirName); fs.mkdirSync(proj);
  const p = { id: 'p1', path: fs.realpathSync.native(proj), agent: 'claude' };
  const svc = createAttachments({ getProject: (id) => (id === 'p1' ? p : null), now: () => new Date(2026, 10, 21, 9, 5, 7), randomHex: () => 'abc123' });
  return { proj: p.path, svc, p };
}

test('attachments: save validates mime vs magic bytes, size; stores in .flowstate/attachments with gitignore; read returns dataUrl', () => {
  const { proj, svc } = mkAttach();
  const a = svc.save('p1', { name: 'C:\\x\\shot.png', mime: 'image/png', dataBase64: png(64, 64).toString('base64') });
  assert.equal(a.rel, '.flowstate/attachments/20261121-090507-abc123.png');
  assert.equal(a.name, 'shot.png'); assert.equal(a.mime, 'image/png'); assert.deepEqual([a.width, a.height], [64, 64]);
  assert.ok(fs.existsSync(path.join(proj, ...a.rel.split('/'))));
  assert.equal(fs.readFileSync(path.join(proj, '.flowstate', '.gitignore'), 'utf8'), 'state.json\nhistory.jsonl\nattachments/\n');
  assert.throws(() => svc.save('p1', { name: 'a', mime: 'image/jpeg', dataBase64: png(4, 4).toString('base64') }), /does not match/);
  assert.throws(() => svc.save('p1', { name: 'a', mime: 'image/png', dataBase64: Buffer.from('not an image at all').toString('base64') }), /does not match/);
  assert.throws(() => svc.save('p1', { name: 'a', mime: 'image/svg+xml', dataBase64: 'AAAA' }), /Unsupported/);
  assert.throws(() => svc.save('p1', { name: 'a', mime: 'image/png', dataBase64: '!!!' }), /Invalid image data/);
  assert.throws(() => svc.save('p1', { name: 'a', mime: 'image/png', dataBase64: Buffer.concat([png(2, 2), Buffer.alloc(8 * 1024 * 1024)]).toString('base64') }), /too large/);
  assert.throws(() => svc.save('nope', { name: 'a', mime: 'image/png', dataBase64: 'AAAA' }), /Unknown project/);
  const r = svc.read('p1', a.rel);
  assert.ok(r.dataUrl.startsWith('data:image/png;base64,'));
  assert.throws(() => svc.read('p1', '.flowstate/../secret.txt'), /traversal/i);
  assert.throws(() => svc.read('p1', 'package.json'), /Not an attachment|not exist|resolv/i);
  fs.writeFileSync(path.join(proj, '.flowstate', 'attachments', 'big.png'), Buffer.concat([png(2, 2), Buffer.alloc(6 * 1024 * 1024)]));
  assert.throws(() => svc.read('p1', '.flowstate/attachments/big.png'), /too large/);
});

test('attachments: loadAttachmentImages resolves inside the attachments dir only (max 5, must exist)', () => {
  const { proj, svc, p } = mkAttach();
  const a = svc.save('p1', { name: 'a.png', mime: 'image/png', dataBase64: png(8, 8).toString('base64') });
  const ok = loadAttachmentImages(p, [{ rel: a.rel }], { withData: true });
  assert.equal(ok[0].mime, 'image/png'); assert.ok(ok[0].dataBase64.length > 10); assert.ok(path.isAbsolute(ok[0].abs));
  assert.equal(loadAttachmentImages(p, [{ rel: a.rel }])[0].dataBase64, undefined);
  assert.deepEqual(loadAttachmentImages(p, undefined), []);
  assert.throws(() => loadAttachmentImages(p, Array.from({ length: 6 }, () => ({ rel: a.rel }))), /At most 5/);
  assert.throws(() => loadAttachmentImages(p, [{ rel: '.flowstate/attachments/missing.png' }]), /not found/);
  assert.throws(() => loadAttachmentImages(p, [{ rel: '.flowstate/attachments/../../x.png' }]), /traversal|Invalid/i);
  assert.throws(() => loadAttachmentImages(p, [{ rel: 'src/a.png' }]), /Invalid image path/);
  assert.throws(() => loadAttachmentImages(p, [{ rel: '.flowstate/attachments/sub/a.png' }]), /Invalid|not found/);
  fs.writeFileSync(path.join(proj, 'outside.png'), png(2, 2));
  assert.throws(() => loadAttachmentImages(p, [{ rel: '.flowstate/attachments/..\\..\\outside.png' }]), /traversal|Invalid/i);
});

test('claude stdin payload: image blocks BEFORE the text block; agy prompt gets one [Image attached: <abs>] line per image', () => {
  const c = new ClaudeAdapter();
  const msg = JSON.parse(c.stdinPayload('What colour?', [{ mime: 'image/png', dataBase64: 'QUJD' }, { mime: 'image/jpeg', dataBase64: 'REVG' }]));
  assert.deepEqual(msg.message.content.map((b) => b.type), ['image', 'image', 'text']);
  assert.deepEqual(msg.message.content[0], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } });
  assert.equal(msg.message.content[2].text, 'What colour?');
  assert.equal(JSON.parse(c.stdinPayload('hi')).message.content.length, 1);
  const a = new AgyAdapter();
  const t = a.prepareText('Describe it', [{ abs: 'C:\\my proj\\.flowstate\\attachments\\a.png' }, { abs: 'C:\\my proj\\.flowstate\\attachments\\b.png' }]);
  assert.equal(t, 'Describe it\n\n[Image attached: C:\\my proj\\.flowstate\\attachments\\a.png]\n[Image attached: C:\\my proj\\.flowstate\\attachments\\b.png]');
  assert.equal(a.prepareText('x', []), 'x');
});

test('manager.send with images: resolved before anything starts, recorded in history, listRunning shows the turn', async () => {
  const { svc, p, proj } = mkAttach();
  const a = svc.save('p1', { name: 'a.png', mime: 'image/png', dataBase64: png(8, 8).toString('base64') });
  const fake = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'fixtures', 'fake-agent.js');
  const events = []; const metas = [];
  const hist = createHistory({ dir: tmp(), storeDirOf: () => path.join(proj, '.flowstate') });
  const projects = { get: (id) => (id === 'p1' ? { ...p } : null), update() {} };
  const mgr = createAgentManager({
    projects, history: hist, emit: (id, ev, meta) => { events.push(ev); metas.push(meta); },
    resolveLauncher: async () => ({ command: process.execPath, baseArgs: [fake, '--style', 'claude'] }),
  });
  await assert.rejects(() => mgr.send({ projectId: 'p1', text: 'x', images: [{ rel: '.flowstate/attachments/none.png' }] }), /not found/);
  assert.deepEqual(mgr.listRunning(), []);
  await mgr.send({ projectId: 'p1', text: 'look', images: [{ rel: a.rel }] });
  const run = mgr.listRunning();
  assert.equal(run.length, 1); assert.equal(run[0].agent, 'claude'); assert.equal(run[0].state, 'running'); assert.ok(run[0].startedAt > 0);
  const t0 = Date.now();
  while (!events.some((e) => e.type === 'result') && Date.now() - t0 < 10000) await new Promise((r) => setTimeout(r, 50));
  assert.ok(events.some((e) => e.type === 'result'));
  assert.ok(metas.every((m) => m?.agent === 'claude'));
  const rec = hist.get('p1').find((r) => r.t === 'user');
  assert.deepEqual(rec.images, [a.rel]);
});

// ---- tasks ------------------------------------------------------------------------------------------------------------------
test('tasks: snapshot from fakes, todos/subagents from events, change-only push, stop dispatch', async () => {
  let t = 10000; const pushed = []; const stopped = [];
  const projects = { get: (id) => ({ p1: { name: 'Alpha' }, p2: { name: 'Beta' } })[id] ?? null };
  const svc = createTasks({
    projects, now: () => t, push: (ch, s) => pushed.push([ch, s]), setIntervalFn: () => ({ unref() {} }),
    agents: { listRunning: () => [{ projectId: 'p1', agent: 'claude', state: 'running', startedAt: 9000, pid: 42 }], stop: (id) => stopped.push(['agent', id]) },
    dashboards: { list: () => [{ projectId: 'p2', url: 'http://127.0.0.1:8501', app: 'app.py', startedAt: 8000 }], stop: (id) => stopped.push(['dashboard', id]) },
    remote: { list: () => [{ projectId: 'p1', agent: 'claude', startedAt: 7000 }], stop: async (id) => stopped.push(['remote', id]) },
    runner: { listActive: () => [{ runId: 'r1', projectId: 'p2', methodologyId: 'm', status: 'waiting', startedAt: 6000 }], stop: (id) => stopped.push(['methodology', id]) },
    login: { sessions: () => [{ agent: 'agy', startedAt: 5000 }], cancel: (a) => stopped.push(['login', a]) },
    files: { watching: () => [{ projectId: 'p1', startedAt: 4000 }], closeWatcher: (id) => stopped.push(['watcher', id]) },
  });
  const s = svc.list();
  assert.deepEqual(s.agents, [{ projectId: 'p1', projectName: 'Alpha', agent: 'claude', state: 'running', startedAt: 9000, elapsedMs: 1000, pid: 42 }]);
  assert.deepEqual(s.services.map((x) => [x.kind, x.id, x.state, x.stoppable]), [['dashboard', 'p2', 'running', true], ['remote', 'p1', 'running', true], ['methodology', 'r1', 'waiting', true], ['login', 'agy', 'waiting', true], ['watcher', 'p1', 'running', true]]);
  assert.equal(s.services[0].url, 'http://127.0.0.1:8501');
  svc.onAgentEvent('p1', { type: 'todos', items: [{ content: 'a', status: 'pending' }, { content: 'b', status: 'in_progress' }] });
  assert.equal(pushed.at(-1)[0], CH.evTasks);
  assert.equal(svc.list().todos.p1.length, 2);
  svc.onAgentEvent('p1', { type: 'subagent', id: 'tu1', name: 'Explore', description: 'look', state: 'running' });
  assert.deepEqual(svc.list().subagents.map((x) => [x.id, x.state, x.name]), [['tu1', 'running', 'Explore']]);
  svc.onAgentEvent('p1', { type: 'tool-result', id: 'tu1', output: 'x', isError: true });
  assert.equal(svc.list().subagents[0].state, 'error');
  svc.onAgentEvent('p1', { type: 'subagent', id: 'tu2', name: 'general', state: 'running' });
  svc.onAgentEvent('p1', { type: 'tool-result', id: 'tu2', output: 'ok' });
  assert.equal(svc.list().subagents[1].state, 'done');
  // change-only + max 2 per second
  t += 600; svc.tick(); // a change that was throttled earlier is delivered now
  const n = pushed.length;
  t += 600; svc.tick(); svc.tick(); assert.equal(pushed.length, n, 'elapsed time alone does not push');
  svc.onAgentEvent('p2', { type: 'todos', items: [{ content: 'z', status: 'pending' }] }); // within 500 ms of the last push?
  t += 10;
  const before = pushed.length; svc.onAgentEvent('p2', { type: 'todos', items: [] }); assert.ok(pushed.length - before <= 1);
  // stop
  for (const [kind, id] of [['agent', 'p1'], ['dashboard', 'p2'], ['remote', 'p1'], ['methodology', 'r1'], ['login', 'agy'], ['watcher', 'p1']]) assert.deepEqual(await svc.stop({ kind, id }), { ok: true });
  assert.deepEqual(stopped.map((x) => x[0]), ['agent', 'dashboard', 'remote', 'methodology', 'login', 'watcher']);
  assert.equal((await svc.stop({ kind: 'daemon', id: 'x' })).ok, false);
  const bad = createTasks({ projects, agents: { listRunning: () => [{ projectId: 'p1', agent: 'claude', state: 'running', startedAt: 1 }], stop() { throw new Error('nope'); } }, setIntervalFn: () => ({ unref() {} }) });
  assert.deepEqual(await bad.stop({ kind: 'agent', id: 'p1' }), { ok: false, error: 'nope' });
  assert.deepEqual(await bad.stop({ kind: 'dashboard', id: 'p1' }), { ok: false, error: 'not-running' });
});

test('tasks: a running agent turn shows up via the real manager', async () => {
  const fake = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'fixtures', 'fake-agent.js');
  const dir = tmp();
  const proj = { id: 'p1', path: fs.realpathSync.native(dir), agent: 'agy', mode: 'plan', name: 'N' };
  const mgr = createAgentManager({ projects: { get: () => ({ ...proj }), update() {} }, emit() {}, resolveLauncher: async () => ({ command: process.execPath, baseArgs: [fake, '--style', 'agy'] }) });
  const tasks = createTasks({ projects: { get: () => proj }, agents: mgr, setIntervalFn: () => ({ unref() {} }) });
  process.env.FAKE_DELAY = '150';
  try {
    await mgr.send({ projectId: 'p1', text: 'go' });
    const s = tasks.list();
    assert.equal(s.agents.length, 1); assert.equal(s.agents[0].agent, 'agy'); assert.ok(s.agents[0].pid > 0);
    mgr.stop('p1');
  } finally { delete process.env.FAKE_DELAY; }
  const t0 = Date.now();
  while (mgr.status('p1').running && Date.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 50));
  assert.equal(tasks.list().agents.length, 0);
});
