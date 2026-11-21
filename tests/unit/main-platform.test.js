// Cross-platform behaviour (macOS / Linux / Windows) exercised from any host with injected platform/env/fs/runners.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { fakeFs } from '../fixtures/fake-fs.js';
import {
  createHealth, parseScutilNcList, parseIfconfigVpn, parseIpLinkUp, parseNmcliActive, augmentedEnv,
} from '../../src/main/health.js';
import { searchPathDirs, isExecutableFile, nvmBinDirs, findOnPath } from '../../src/main/platform.js';
import { buildInstall, createPrereq, probeTools, wingetArgs, BREW_PACKAGES, LINUX_PACKAGES } from '../../src/main/prereq.js';
import { terminalAttempts, openTerminal, validateExecutablePath, shellCommandLine, appleScriptEscape } from '../../src/main/terminal.js';
import { killTree } from '../../src/main/agents/base.js';
import { venvPythonPath, pythonCandidates } from '../../src/main/dashboards.js';
import { openRefusal, REFUSED_OPEN_POSIX } from '../../src/main/files.js';
import { buildLoginCommand } from '../../src/main/auth.js';

const none = async () => ({ code: 1, stdout: '', stderr: '' });

// ---------------------------------------------------------------------------------------------- PATH augmentation
test('searchPathDirs / augmentedEnv: GUI-launched mac app gets the common dirs appended once', () => {
  const env = { HOME: '/Users/ana', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
  const fsx = fakeFs([['/Users/ana/.nvm/versions/node/v20.11.0/bin/node'], ['/Users/ana/.nvm/versions/node/v22.3.0/bin/node']]);
  const dirs = searchPathDirs(env, 'darwin', fsx);
  assert.deepEqual(dirs.slice(0, 4), ['/usr/bin', '/bin', '/usr/sbin', '/sbin']);
  for (const d of ['/usr/local/bin', '/opt/homebrew/bin', '/Users/ana/.local/bin', '/Users/ana/.npm-global/bin', '/Users/ana/.volta/bin', '/Users/ana/.cargo/bin']) assert.ok(dirs.includes(d), d);
  assert.ok(dirs.includes('/Users/ana/.nvm/versions/node/v22.3.0/bin'));
  assert.equal(new Set(dirs).size, dirs.length, 'no duplicates');
  const e = augmentedEnv(env, 'darwin', fsx);
  assert.equal(e.HOME, '/Users/ana');
  assert.ok(e.PATH.startsWith('/usr/bin:/bin:'));
  assert.equal(env.PATH, '/usr/bin:/bin:/usr/sbin:/sbin', 'input not mutated');
  // win32 is left alone
  assert.equal(augmentedEnv({ PATH: 'C:\\a' }, 'win32').PATH, 'C:\\a');
});

test('nvmBinDirs honours the default alias, else the newest version', () => {
  const fsx = fakeFs([
    ['/h/.nvm/versions/node/v18.19.0/bin/node'], ['/h/.nvm/versions/node/v20.11.0/bin/node'], ['/h/.nvm/versions/node/v22.3.0/bin/node'],
    ['/h/.nvm/alias/default', 0o644, '20\n'],
  ]);
  assert.deepEqual(nvmBinDirs({ HOME: '/h' }, 'linux', fsx), ['/h/.nvm/versions/node/v20.11.0/bin']);
  const noAlias = fakeFs([['/h/.nvm/versions/node/v18.19.0/bin/node'], ['/h/.nvm/versions/node/v22.3.0/bin/node']]);
  assert.deepEqual(nvmBinDirs({ HOME: '/h' }, 'linux', noAlias), ['/h/.nvm/versions/node/v22.3.0/bin']);
  assert.deepEqual(nvmBinDirs({ HOME: '/h' }, 'win32', noAlias), []);
  assert.deepEqual(nvmBinDirs({ HOME: '/h' }, 'linux', fakeFs(['/x'])), []);
});

test('isExecutableFile: posix needs an exec bit, win32 only .exe (never .cmd/.bat)', () => {
  const fsx = fakeFs([['/b/tool', 0o755], ['/b/data', 0o644], '/b/dir/inner']);
  assert.equal(isExecutableFile(fsx, '/b/tool', 'linux'), true);
  assert.equal(isExecutableFile(fsx, '/b/data', 'linux'), false);
  assert.equal(isExecutableFile(fsx, '/b/dir', 'linux'), false);
  assert.equal(isExecutableFile(fsx, '/b/missing', 'darwin'), false);
  const w = fakeFs(['C:\\x\\a.exe', 'C:\\x\\b.cmd', 'C:\\x\\c.BAT'], 'win32');
  assert.equal(isExecutableFile(w, 'C:\\x\\a.exe', 'win32'), true);
  assert.equal(isExecutableFile(w, 'C:\\x\\b.cmd', 'win32'), false);
  assert.equal(isExecutableFile(w, 'C:\\x\\c.BAT', 'win32'), false);
});

test('findOnPath returns executables only, in PATH order', () => {
  const fsx = fakeFs([['/opt/a/claude', 0o644], ['/opt/b/claude', 0o755], ['/usr/local/bin/claude', 0o755]]);
  assert.deepEqual(findOnPath('claude', { HOME: '/h', PATH: '/opt/a:/opt/b' }, 'linux', fsx), ['/opt/b/claude', '/usr/local/bin/claude']);
});

// ---------------------------------------------------------------------------------------------- discovery
const mac = (files, extra = {}) => createHealth({
  run: none, fsx: fakeFs(files), env: { HOME: '/Users/ana', PATH: '/usr/bin:/bin' }, platform: 'darwin', getSettings: () => ({}), reachable: async () => true, ...extra,
});

test('darwin claude discovery: PATH (augmented) before fixed paths; non-executables skipped', async () => {
  // /opt/homebrew/bin is in the augmented PATH, so it is found by the PATH walk before ~/.local/bin
  assert.equal(await mac(['/Users/ana/.local/bin/claude', '/opt/homebrew/bin/claude']).findClaude(), '/opt/homebrew/bin/claude');
  assert.equal(await mac(['/Users/ana/.local/bin/claude']).findClaude(), '/Users/ana/.local/bin/claude');
  assert.equal(await mac([['/Users/ana/.local/bin/claude', 0o644]]).findClaude(), null);
  assert.equal(await mac(['/Users/ana/.claude/local/claude']).findClaude(), '/Users/ana/.claude/local/claude');
  assert.equal(await mac(['/Users/ana/.volta/bin/claude']).findClaude(), '/Users/ana/.volta/bin/claude');
  assert.equal(await mac([]).findClaude(), null);
});

test('darwin claude discovery: settings override, then desktop app bundles newest first', async () => {
  const bundled = ['/Users/ana/Library/Application Support/Claude/claude-code/2.1.9/claude', '/Users/ana/Library/Application Support/Claude/claude-code/2.1.328/claude', '/Users/ana/Library/Application Support/Claude/claude-code/2.1.100/claude'];
  assert.equal(await mac(bundled).findClaude(), '/Users/ana/Library/Application Support/Claude/claude-code/2.1.328/claude');
  assert.equal(await mac([...bundled, '/Users/ana/custom/claude'], { getSettings: () => ({ claudePath: '/Users/ana/custom/claude' }) }).findClaude(), '/Users/ana/custom/claude');
  // nested app-bundle layout and the /Applications copy
  assert.equal(await mac(['/Users/ana/Library/Application Support/Claude/claude-code/2.0.0/claude.app/Contents/MacOS/claude']).findClaude(), '/Users/ana/Library/Application Support/Claude/claude-code/2.0.0/claude.app/Contents/MacOS/claude');
  assert.equal(await mac(['/Applications/Claude.app/Contents/Resources/app/claude-code/claude']).findClaude(), '/Applications/Claude.app/Contents/Resources/app/claude-code/claude');
});

test('darwin agy discovery', async () => {
  assert.equal(await mac(['/Users/ana/.agy/bin/agy']).findAgy(), '/Users/ana/.agy/bin/agy');
  assert.equal(await mac(['/Users/ana/.local/bin/agy']).findAgy(), '/Users/ana/.local/bin/agy');
  assert.equal(await mac([['/Users/ana/.agy/bin/agy', 0o600]]).findAgy(), null);
});

const lin = (files, extra = {}) => createHealth({
  run: none, fsx: fakeFs(files), env: { HOME: '/home/ana', PATH: '/usr/bin:/bin' }, platform: 'linux', getSettings: () => ({}), reachable: async () => true, ...extra,
});

test('linux claude/agy discovery', async () => {
  assert.equal(await lin(['/home/ana/.local/bin/claude']).findClaude(), '/home/ana/.local/bin/claude');
  assert.equal(await lin(['/home/ana/.npm-global/bin/claude']).findClaude(), '/home/ana/.npm-global/bin/claude');
  assert.equal(await lin(['/home/ana/.config/Claude/claude-code/2.1.5/claude', '/home/ana/.config/Claude/claude-code/2.1.50/hash/claude']).findClaude(), '/home/ana/.config/Claude/claude-code/2.1.50/hash/claude');
  assert.equal(await lin(['/home/ana/.local/bin/agy']).findAgy(), '/home/ana/.local/bin/agy');
  assert.equal(await lin(['/usr/local/bin/agy']).findAgy(), '/usr/local/bin/agy');
  assert.equal(await lin([]).findAgy(), null);
});

// ---------------------------------------------------------------------------------------------- agy.loggedIn
test('check(): agy.loggedIn from `agy models`, null keeps the previous known value', async () => {
  const agy = '/home/ana/.local/bin/agy';
  let modelsOut = { code: 0, stdout: 'gemini-3-pro\tGemini 3 Pro\ngemini-3-flash\tGemini 3 Flash\n', stderr: '' };
  const seen = [];
  const run = async (cmd, args, opts) => {
    seen.push([cmd, args, opts]);
    if (cmd === agy && args[0] === '--version') return { code: 0, stdout: '1.5.14\n', stderr: '' };
    if (cmd === agy && args[0] === 'models') return modelsOut;
    return { code: 1, stdout: '', stderr: '' };
  };
  const h = createHealth({ run, fsx: fakeFs([agy]), env: { HOME: '/home/ana', PATH: '/usr/bin' }, platform: 'linux', reachable: async () => true });
  assert.equal((await h.check()).agy.loggedIn, true);
  assert.equal(seen.find((s) => s[1][0] === 'models')[2].timeout, 15000);
  modelsOut = { code: 1, stdout: '', stderr: 'Please sign in to view available models...' };
  assert.equal((await h.check()).agy.loggedIn, false);
  modelsOut = { code: 1, stdout: '', stderr: 'dial tcp: i/o timeout' }; // inconclusive
  assert.equal((await h.check()).agy.loggedIn, false, 'previous value kept');
  // fresh instance with an inconclusive first answer -> null
  const h2 = createHealth({ run: async (c, a) => (a[0] === 'models' ? { code: 1, stdout: '', stderr: '' } : run(c, a)), fsx: fakeFs([agy]), env: { HOME: '/home/ana', PATH: '/usr/bin' }, platform: 'linux', reachable: async () => true });
  assert.equal((await h2.check()).agy.loggedIn, null);
  // dynamic() never runs `agy models`
  seen.length = 0;
  await h.dynamic();
  assert.ok(!seen.some((s) => s[1][0] === 'models'));
});

// ---------------------------------------------------------------------------------------------- VPN
const SCUTIL = `Available network connection services in the current set (*=enabled):
* (Disconnected)   0F1D8B8A-1B2C-4D3E-9F10-AAAAAAAAAAAA PPP --> L2TP         "Office L2TP"  [PPP:L2TP]
* (Connected)      3F2A9C10-6A4B-4E7B-8C21-BBBBBBBBBBBB VPN (com.cisco.anyconnect) "Cisco AnyConnect"  [VPN:com.cisco.anyconnect]
`;
const IFCONFIG_PLAIN = `lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384
\tinet 127.0.0.1 netmask 0xff000000
en0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
\tether a4:83:e7:00:11:22
\tinet 192.168.1.20 netmask 0xffffff00 broadcast 192.168.1.255
utun0: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST> mtu 1380
\tinet6 fe80::1%utun0 prefixlen 64 scopeid 0xe
utun3: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST> mtu 1380
\tinet 10.9.0.2 --> 10.9.0.2 netmask 0xffffffff
`;
const IFCONFIG_WG = `${IFCONFIG_PLAIN}tun0: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST> mtu 1500
\tinet 10.8.0.6 --> 10.8.0.5 netmask 0xffffffff
ppp0: flags=8010<POINTOPOINT,MULTICAST> mtu 1500
\tinet 10.1.1.1 --> 10.1.1.2 netmask 0xffffff00
`;

test('darwin VPN parsers: scutil connected services only; utun alone never counts', () => {
  assert.deepEqual(parseScutilNcList(SCUTIL), ['Cisco AnyConnect']);
  assert.deepEqual(parseScutilNcList(''), []);
  assert.deepEqual(parseIfconfigVpn(IFCONFIG_PLAIN), []);
  assert.deepEqual(parseIfconfigVpn(IFCONFIG_WG), ['tun0']); // ppp0 has no UP flag
});

test('darwin detectVpn via injected runners', async () => {
  const mk = (nc, ifc) => createHealth({
    run: async (cmd) => (cmd === 'scutil' ? { code: 0, stdout: nc, stderr: '' } : cmd === 'ifconfig' ? { code: 0, stdout: ifc, stderr: '' } : { code: 1, stdout: '', stderr: '' }),
    fsx: fakeFs([]), env: { HOME: '/h' }, platform: 'darwin',
  });
  assert.deepEqual(await mk(SCUTIL, IFCONFIG_PLAIN).detectVpn(), { active: true, adapters: ['Cisco AnyConnect'] });
  assert.deepEqual(await mk('Available network connection services in the current set (*=enabled):\n', IFCONFIG_PLAIN).detectVpn(), { active: false, adapters: [] });
  assert.deepEqual(await mk('', IFCONFIG_WG).detectVpn(), { active: true, adapters: ['tun0'] });
});

const IP_LINK = `1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN mode DEFAULT group default qlen 1000\\    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00
2: enp3s0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc fq_codel state UP mode DEFAULT group default qlen 1000\\    link/ether 3c:ec:ef:00:11:22 brd ff:ff:ff:ff:ff:ff
3: docker0: <NO-CARRIER,BROADCAST,MULTICAST,UP> mtu 1500 qdisc noqueue state DOWN mode DEFAULT group default\\    link/ether 02:42:ac:11:00:01 brd ff:ff:ff:ff:ff:ff
7: tun0: <POINTOPOINT,MULTICAST,NOARP,UP,LOWER_UP> mtu 1500 qdisc fq_codel state UNKNOWN mode DEFAULT group default qlen 500\\    link/none
9: wg0: <POINTOPOINT,NOARP,UP,LOWER_UP> mtu 1420 qdisc noqueue state UNKNOWN mode DEFAULT group default qlen 1000\\    link/none
11: nordlynx: <POINTOPOINT,NOARP,UP,LOWER_UP> mtu 1420 qdisc noqueue state UNKNOWN mode DEFAULT group default qlen 1000\\    link/none
12: veth1a2b@if11: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue master docker0 state UP mode DEFAULT group default\\    link/ether 6e:11:22:33:44:55 brd ff:ff:ff:ff:ff:ff link-netnsid 0
`;
const NMCLI = `802-3-ethernet:activated:Wired connection 1
vpn:activated:Work\\: VPN
wireguard:activated:wg-home
tun:deactivating:old-tun
loopback:activated:lo
`;

test('linux VPN parsers (ip link / nmcli terse)', () => {
  assert.deepEqual(parseIpLinkUp(IP_LINK), ['tun0', 'wg0', 'nordlynx']);
  assert.deepEqual(parseIpLinkUp('2: eth0: <UP> mtu 1500\n'), []);
  assert.deepEqual(parseNmcliActive(NMCLI), ['Work: VPN', 'wg-home']);
  assert.deepEqual(parseNmcliActive(''), []);
});

test('linux detectVpn merges ip + nmcli and tolerates missing tools', async () => {
  const calls = [];
  const h = createHealth({
    run: async (cmd, args) => { calls.push([cmd, ...args].join(' ')); return cmd === 'ip' ? { code: 0, stdout: IP_LINK, stderr: '' } : cmd === 'nmcli' ? { code: 0, stdout: NMCLI, stderr: '' } : none(); },
    fsx: fakeFs([]), env: { HOME: '/h' }, platform: 'linux',
  });
  const r = await h.detectVpn();
  assert.equal(r.active, true);
  assert.deepEqual(r.adapters, ['tun0', 'wg0', 'nordlynx', 'Work: VPN', 'wg-home']);
  assert.ok(calls.includes('ip -o link show up'));
  assert.ok(calls.includes('nmcli -t -f TYPE,STATE,NAME connection show --active'));
  const missing = createHealth({ run: none, fsx: fakeFs([]), env: { HOME: '/h' }, platform: 'linux' });
  assert.deepEqual(await missing.detectVpn(), { active: false, adapters: [] });
});

// ---------------------------------------------------------------------------------------------- prereq
test('prereq buildInstall: fixed allow-list per platform', () => {
  assert.deepEqual(buildInstall('git', 'win32').args, wingetArgs('git'));
  assert.equal(buildInstall('git', 'win32').command, 'winget');
  assert.deepEqual(BREW_PACKAGES, { git: 'git', node: 'node', python: 'python@3.12' });
  assert.deepEqual(buildInstall('python', 'darwin', { brew: '/opt/homebrew/bin/brew' }), { command: '/opt/homebrew/bin/brew', args: ['install', 'python@3.12'], display: 'brew install python@3.12' });
  const noBrew = buildInstall('node', 'darwin', {});
  assert.match(noBrew.error, /Homebrew is not installed/);
  assert.match(noBrew.error, /https:\/\/brew\.sh/);
  assert.doesNotMatch(noBrew.error, /curl/);
  const apt = buildInstall('python', 'linux', { pm: 'apt', pkexec: '/usr/bin/pkexec', display: true });
  assert.deepEqual(apt, { command: '/usr/bin/pkexec', args: ['apt-get', 'install', '-y', 'python3', 'python3-venv'], display: 'sudo apt-get install -y python3 python3-venv' });
  assert.deepEqual(buildInstall('git', 'linux', { pm: 'dnf', pkexec: 'pkexec', display: true }).args, ['dnf', 'install', '-y', 'git']);
  assert.deepEqual(buildInstall('node', 'linux', { pm: 'pacman', pkexec: 'pkexec', display: true }).args, ['pacman', '-S', '--noconfirm', '--needed', 'nodejs', 'npm']);
  assert.deepEqual(buildInstall('python', 'linux', { pm: 'zypper', pkexec: 'pkexec', display: true }).args, ['zypper', '--non-interactive', 'install', 'python3']);
  // no pkexec or no display: exact manual command in the message
  const manual = buildInstall('git', 'linux', { pm: 'apt', pkexec: null, display: true });
  assert.equal(manual.manual, 'sudo apt-get install -y git');
  assert.match(manual.error, /sudo apt-get install -y git/);
  assert.equal(buildInstall('git', 'linux', { pm: 'apt', pkexec: 'pkexec', display: false }).manual, 'sudo apt-get install -y git');
  assert.match(buildInstall('git', 'linux', { pm: null }).error, /No supported package manager/);
  assert.match(buildInstall('git', 'freebsd', {}).error, /not supported/);
  for (const bad of ['calc', 'git; calc', '__proto__', '', 'git ']) assert.throws(() => buildInstall(bad, 'linux', { pm: 'apt', pkexec: 'pkexec', display: true }), /Unknown/);
  for (const pm of Object.keys(LINUX_PACKAGES)) for (const id of ['git', 'node', 'python']) assert.ok(LINUX_PACKAGES[pm][id].length);
});

test('probeTools finds brew / package manager / pkexec through the augmented PATH', () => {
  const fsx = fakeFs(['/opt/homebrew/bin/brew', '/usr/bin/dnf', '/usr/bin/pkexec']);
  assert.deepEqual(probeTools({ platform: 'darwin', env: { HOME: '/Users/a', PATH: '/usr/bin' }, fsx }), { brew: '/opt/homebrew/bin/brew' });
  assert.deepEqual(probeTools({ platform: 'linux', env: { HOME: '/h', PATH: '/usr/bin', WAYLAND_DISPLAY: 'wayland-0' }, fsx }), { pm: 'dnf', pkexec: '/usr/bin/pkexec', display: true });
  assert.equal(probeTools({ platform: 'linux', env: { HOME: '/h', PATH: '/usr/bin' }, fsx }).display, false);
});

function fakeChild() {
  const c = new EventEmitter();
  c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = new EventEmitter();
  c.pid = 99; c.exitCode = null; c.unref = () => {};
  return c;
}

test('createPrereq per platform with a fake spawn (no real installs)', async () => {
  // darwin
  const seen = []; const ev = [];
  const child = fakeChild();
  const p = createPrereq({ platform: 'darwin', probe: () => ({ brew: '/opt/homebrew/bin/brew' }), spawn: (c, a, o) => { seen.push([c, a, o]); return child; }, push: (e) => ev.push(e) });
  const run = p.install('git');
  await new Promise((r) => setImmediate(r));
  child.stdout.emit('data', '==> Pouring git\n');
  child.emit('close', 0);
  assert.equal((await run).ok, true);
  assert.deepEqual(seen[0].slice(0, 2), ['/opt/homebrew/bin/brew', ['install', 'git']]);
  assert.equal(seen[0][2].shell, false);
  assert.equal(ev.at(-1).kind, 'done');
  // darwin without brew: nothing is spawned
  let spawned = 0;
  const nb = createPrereq({ platform: 'darwin', probe: () => ({}), spawn: () => { spawned++; return fakeChild(); }, push: (e) => ev.push(e) });
  const r1 = await nb.install('node');
  assert.equal(r1.ok, false);
  assert.equal(r1.manualCommand, 'brew install node');
  assert.equal(spawned, 0);
  assert.equal(ev.at(-1).kind, 'error');
  // linux with pkexec
  const c3 = fakeChild(); const s3 = [];
  const lp = createPrereq({ platform: 'linux', probe: () => ({ pm: 'apt', pkexec: '/usr/bin/pkexec', display: true }), spawn: (c, a) => { s3.push([c, a]); return c3; } });
  const l = lp.install('python');
  await new Promise((r) => setImmediate(r));
  c3.emit('close', 0);
  assert.equal((await l).ok, true);
  assert.deepEqual(s3[0], ['/usr/bin/pkexec', ['apt-get', 'install', '-y', 'python3', 'python3-venv']]);
  // linux without a GUI privilege prompt
  const lm = createPrereq({ platform: 'linux', probe: () => ({ pm: 'apt', pkexec: null, display: false }), spawn: () => { throw new Error('must not spawn'); } });
  const r2 = await lm.install('git');
  assert.equal(r2.ok, false);
  assert.match(r2.log, /sudo apt-get install -y git/);
  await assert.rejects(lm.install('evil'), /Unknown/);
});

// ---------------------------------------------------------------------------------------------- terminals
test('terminalAttempts: win32', () => {
  assert.deepEqual(terminalAttempts({ platform: 'win32', exe: 'C:\\x\\claude.exe', args: ['auth', 'login'], title: 'T' }),
    [{ command: 'cmd.exe', args: ['/c', 'start', 'T', 'C:\\x\\claude.exe', 'auth', 'login'] }]);
  // cmd metacharacters in args are neutralised
  assert.deepEqual(terminalAttempts({ platform: 'win32', exe: 'C:\\x\\claude.exe', args: ['--name', 'a&calc|b'], title: 'T' })[0].args.slice(-1), ['a_calc_b']);
  for (const bad of ['C:\\x\\claude.cmd', 'C:\\x\\a&b.exe', 'C:\\x"y.exe', 'C:\\x\\a.exe\n']) assert.throws(() => terminalAttempts({ platform: 'win32', exe: bad }), /not valid/);
});

test('terminalAttempts: darwin builds a quoted AppleScript do script', () => {
  const [a] = terminalAttempts({ platform: 'darwin', exe: '/Users/ana/.local/bin/claude', args: ['auth', 'login'], title: 'x' });
  assert.equal(a.command, 'osascript');
  assert.deepEqual(a.args, ['-e', 'tell application "Terminal"', '-e', 'activate', '-e', "do script \"'/Users/ana/.local/bin/claude' 'auth' 'login'\"", '-e', 'end tell']);
  // hostile project name: single-quote and double-quote layers both escape
  const hostile = terminalAttempts({ platform: 'darwin', exe: '/b/claude', args: ['--name', `x'; rm -rf ~; "y\\`] })[0].args[5];
  assert.equal(hostile, "do script \"'/b/claude' '--name' 'x'\\\\''; rm -rf ~; \\\"y\\\\'\"");
  assert.equal(shellCommandLine('/b/c', ["it's"]), "'/b/c' 'it'\\''s'");
  assert.equal(appleScriptEscape('a"b\\c'), 'a\\"b\\\\c');
  for (const bad of ['claude', '/a/b"c', "/a/b'c", '/a/b\\c', '/a/b\nc', '/a/`x`', '/a/$HOME/c', '']) assert.throws(() => terminalAttempts({ platform: 'darwin', exe: bad }), /not valid/, JSON.stringify(bad));
});

test('terminalAttempts: linux tries the emulators in order with their own syntax', () => {
  const at = terminalAttempts({ platform: 'linux', exe: '/home/a/.local/bin/claude', args: ['auth', 'login'] });
  assert.deepEqual(at.map((x) => x.command), ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xfce4-terminal', 'kitty', 'alacritty']);
  const x = '/home/a/.local/bin/claude';
  assert.deepEqual(at[0].args, ['-e', x, 'auth', 'login']);
  assert.deepEqual(at[1].args, ['--', x, 'auth', 'login']);
  assert.deepEqual(at[2].args, ['-e', x, 'auth', 'login']);
  assert.deepEqual(at[3].args, ['-x', x, 'auth', 'login']);
  assert.deepEqual(at[4].args, [x, 'auth', 'login']);
  assert.deepEqual(at[5].args, ['-e', x, 'auth', 'login']);
  assert.throws(() => terminalAttempts({ platform: 'linux', exe: 'relative/claude' }), /not valid/);
  assert.throws(() => terminalAttempts({ platform: 'freebsd', exe: '/a' }), /not supported/);
});

test('openTerminal falls through missing emulators and reports the manual command when none exist', async () => {
  const tried = [];
  const spawn = (cmd) => {
    tried.push(cmd);
    const c = fakeChild();
    setImmediate(() => (cmd === 'konsole' ? c.emit('spawn') : c.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))));
    return c;
  };
  const r = await openTerminal({ platform: 'linux', exe: '/h/claude', args: ['auth', 'login'], spawn });
  assert.equal(r.command, 'konsole');
  assert.deepEqual(tried, ['x-terminal-emulator', 'gnome-terminal', 'konsole']);
  const allFail = (cmd) => { const c = fakeChild(); setImmediate(() => c.emit('error', new Error('ENOENT'))); return c; };
  await assert.rejects(openTerminal({ platform: 'linux', exe: '/h/claude', args: ['auth', 'login'], spawn: allFail }), /Run this in a terminal: '\/h\/claude' 'auth' 'login'/);
  assert.equal(validateExecutablePath('/ok/claude', 'linux'), '/ok/claude');
});

test('buildLoginCommand per platform', () => {
  assert.equal(buildLoginCommand('claude', '/h/claude', 'darwin').command, 'osascript');
  assert.equal(buildLoginCommand('agy', '/h/agy', 'linux').command, 'x-terminal-emulator');
  assert.throws(() => buildLoginCommand('claude', '/h/claude', 'win32'));
});

// ---------------------------------------------------------------------------------------------- kill tree
test('killTree posix: SIGTERM to the group, SIGKILL after grace, falls back to the pid', () => {
  const sent = []; const timers = [];
  const child = Object.assign(new EventEmitter(), { pid: 4321, exitCode: null, signalCode: null, kill: (s) => sent.push(['pid', s]) });
  const kill = (pid, sig) => sent.push([pid, sig]);
  killTree(child, { platform: 'linux', kill, setTimeoutFn: (f, ms) => { timers.push([f, ms]); return { unref() {} }; }, clearTimeoutFn: () => {} });
  assert.deepEqual(sent, [[-4321, 'SIGTERM']]);
  assert.equal(timers[0][1], 2000);
  timers[0][0]();
  assert.deepEqual(sent, [[-4321, 'SIGTERM'], [-4321, 'SIGKILL']]);
  // child gone before the timer fires: no SIGKILL
  sent.length = 0; timers.length = 0;
  const c2 = Object.assign(new EventEmitter(), { pid: 5, exitCode: null, signalCode: null, kill() {} });
  killTree(c2, { platform: 'darwin', kill, setTimeoutFn: (f) => { timers.push(f); return {}; }, clearTimeoutFn: () => {} });
  c2.exitCode = 0;
  timers[0]();
  assert.deepEqual(sent, [[-5, 'SIGTERM']]);
  // group does not exist (child not detached): fall back to the pid
  sent.length = 0;
  const c3 = Object.assign(new EventEmitter(), { pid: 6, exitCode: null, signalCode: null, kill: (s) => sent.push(['pid', s]) });
  killTree(c3, { platform: 'linux', kill: () => { throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }); }, setTimeoutFn: () => ({}), clearTimeoutFn: () => {} });
  assert.deepEqual(sent, [['pid', 'SIGTERM']]);
  // already exited / no pid: nothing
  sent.length = 0;
  killTree({ pid: 7, exitCode: 0, kill: () => sent.push('x') }, { platform: 'linux', kill });
  killTree(null, { platform: 'linux', kill });
  assert.deepEqual(sent, []);
});

test('killTree win32 still uses taskkill /T /F', () => {
  const calls = [];
  killTree({ pid: 12, exitCode: null, kill() {} }, { platform: 'win32', spawn: (c, a) => { calls.push([c, a]); return new EventEmitter(); } });
  assert.deepEqual(calls, [['taskkill', ['/pid', '12', '/T', '/F']]]);
});

// ---------------------------------------------------------------------------------------------- dashboards + files
test('venv python path and interpreter candidates per platform', () => {
  assert.equal(venvPythonPath('C:\\p', 'win32'), 'C:\\p\\.venv\\Scripts\\python.exe');
  assert.equal(venvPythonPath('/home/a/p', 'linux'), '/home/a/p/.venv/bin/python');
  assert.equal(venvPythonPath('/Users/a/p', 'darwin'), '/Users/a/p/.venv/bin/python');
  assert.deepEqual(pythonCandidates('linux').map((c) => c[0]), ['python3', 'python']);
  assert.deepEqual(pythonCandidates('darwin').map((c) => c[0]), ['python3', 'python']);
  assert.deepEqual(pythonCandidates('win32').map((c) => c[0]), ['py', 'python']);
});

test('open guard: windows extensions, posix scripts/bundles, and any executable bit', () => {
  const fsx = fakeFs([['/p/run.sh', 0o644], ['/p/notes.txt', 0o644], ['/p/tool', 0o755], ['/p/data/inner', 0o644], ['/p/a.AppImage', 0o644], ['/p/X.app/Contents/x', 0o644]]);
  for (const f of ['/p/run.sh', '/p/tool', '/p/a.AppImage', '/p/X.app']) assert.ok(openRefusal(f, { fsx, platform: 'linux' }), f);
  assert.equal(openRefusal('/p/notes.txt', { fsx, platform: 'linux' }), null);
  assert.equal(openRefusal('/p/data', { fsx, platform: 'darwin' }), null, 'plain directory');
  assert.equal(openRefusal('/p/missing.txt', { fsx, platform: 'linux' }), null);
  assert.match(openRefusal('/p/setup.exe', { fsx, platform: 'darwin' }), /not allowed/);
  // win32 does not look at mode bits (none exist), still refuses by extension
  assert.equal(openRefusal('C:\\p\\a.txt', { fsx: fakeFs([]), platform: 'win32' }), null);
  assert.ok(openRefusal('C:\\p\\a.bat', { fsx: fakeFs([]), platform: 'win32' }));
  for (const e of ['.sh', '.command', '.app', '.desktop', '.appimage', '.run', '.bin', '.pkg', '.dmg']) assert.ok(REFUSED_OPEN_POSIX.has(e), e);
});
