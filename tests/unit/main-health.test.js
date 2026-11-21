import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { matchVpnAdapters, createHealth, createHealthPoller } from '../../src/main/health.js';

test('VPN adapter matcher (array, single object, configurable pattern)', () => {
  const list = [
    { Name: 'Ethernet', InterfaceDescription: 'Intel(R) Ethernet' },
    { Name: 'Cisco AnyConnect', InterfaceDescription: 'Cisco AnyConnect Secure Mobility Client Virtual Miniport Adapter' },
    { Name: 'Local Area Connection 2', InterfaceDescription: 'TAP-Windows Adapter V9' },
    { Name: 'Wi-Fi', InterfaceDescription: 'Intel Wi-Fi 6' },
  ];
  assert.deepEqual(matchVpnAdapters(list), ['Cisco AnyConnect', 'Local Area Connection 2']);
  assert.deepEqual(matchVpnAdapters({ Name: 'WireGuard Tunnel', InterfaceDescription: 'WireGuard Tunnel' }), ['WireGuard Tunnel']);
  assert.deepEqual(matchVpnAdapters([]), []);
  assert.deepEqual(matchVpnAdapters(list, /wi-fi/i), ['Wi-Fi']);
});

function fakeFs(files) {
  const norm = (p) => path.normalize(p).toLowerCase();
  const set = new Set(files.map(norm));
  const all = [...set];
  return {
    existsSync: (p) => { const n = norm(p); return set.has(n) || all.some((f) => f.startsWith(n + path.sep)); },
    readdirSync: (p) => {
      const n = norm(p) + path.sep;
      const kids = new Set(all.filter((f) => f.startsWith(n)).map((f) => f.slice(n.length).split(path.sep)[0]));
      if (!kids.size) throw new Error('ENOENT');
      return [...kids];
    },
  };
}
const noWhere = async () => ({ code: 1, stdout: '', stderr: '' });
const env = { LOCALAPPDATA: 'C:\\L', USERPROFILE: 'C:\\U', APPDATA: 'C:\\A' };

test('claude discovery: newest Claude-Data version wins', async () => {
  const files = ['C:\\L\\Claude-Data\\x1\\claude-code\\2.1.9\\aaa\\claude.exe', 'C:\\L\\Claude-Data\\x1\\claude-code\\2.1.328\\bbb\\claude.exe', 'C:\\L\\Claude-Data\\x1\\claude-code\\2.1.100\\ccc\\claude.exe'];
  const h = createHealth({ run: noWhere, fsx: fakeFs(files), env, platform: 'win32' });
  assert.equal(await h.findClaude(), path.join('C:\\L', 'Claude-Data', 'x1', 'claude-code', '2.1.328', 'bbb', 'claude.exe'));
});

test('claude discovery order: settings > PATH > ~/.local/bin > Claude-Data > npm', async () => {
  const local = 'C:\\U\\.local\\bin\\claude.exe';
  const cd = 'C:\\L\\Claude-Data\\x\\claude-code\\1.0.0\\h\\claude.exe';
  const npm = 'C:\\A\\npm\\claude.cmd';
  const mk = (files, run = noWhere, settings = {}) => createHealth({ run, fsx: fakeFs(files), env, platform: 'win32', getSettings: () => settings });
  assert.equal(await mk([local, cd], noWhere, { claudePath: cd }).findClaude(), cd);
  const onPath = async () => ({ code: 0, stdout: 'C:\\tools\\claude.exe\r\n', stderr: '' });
  assert.equal(await mk([local, cd], onPath).findClaude(), 'C:\\tools\\claude.exe');
  assert.equal(await mk([local, cd]).findClaude(), local);
  assert.equal(await mk([cd, npm]).findClaude(), path.join('C:\\L', 'Claude-Data', 'x', 'claude-code', '1.0.0', 'h', 'claude.exe'));
  assert.equal(await mk([npm]).findClaude(), npm);
  assert.equal(await mk([]).findClaude(), null);
});

test('check(): versions, auth, vpn, reachability via injected runner', async () => {
  const exe = 'C:\\U\\.local\\bin\\claude.exe';
  const run = async (cmd, args) => {
    if (cmd === 'where') return { code: 1, stdout: '', stderr: '' };
    if (cmd === exe && args[0] === '--version') return { code: 0, stdout: '2.1.328 (Claude Code)\n', stderr: '' };
    if (cmd === exe && args[0] === 'auth') return { code: 0, stdout: '{"loggedIn":true}', stderr: '' };
    if (cmd === 'powershell') return { code: 0, stdout: '{"Name":"OpenVPN TAP","InterfaceDescription":"TAP-Windows"}', stderr: '' };
    if (cmd === 'node') return { code: 0, stdout: 'v24.0.0\n', stderr: '' };
    return { code: 1, stdout: '', stderr: 'nope' };
  };
  const h = createHealth({ run, fsx: fakeFs([exe]), env, platform: 'win32', reachable: async () => true });
  const r = await h.check();
  assert.deepEqual(r.claude, { found: true, path: exe, version: '2.1.328 (Claude Code)', loggedIn: true });
  assert.equal(r.agy.found, false);
  assert.deepEqual(r.node, { found: true, version: 'v24.0.0' });
  assert.equal(r.git.found, false);
  assert.deepEqual(r.vpn, { active: true, adapters: ['OpenVPN TAP'] });
  assert.equal(r.anthropicReachable, true);
});

test('poller pushes only on change', async () => {
  let vpn = false; let full = 0;
  const health = {
    check: async () => { full++; return { a: 1, vpn }; },
    dynamic: async () => ({ vpn }),
  };
  const seen = [];
  const p = createHealthPoller({ health, onChange: (h) => seen.push(h), fullEvery: 100 });
  await p.poll(); await p.poll(); await p.poll();
  assert.equal(seen.length, 1);
  vpn = true;
  await p.poll();
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[1], { a: 1, vpn: true });
  assert.equal(full, 1);
});
