import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWindowOptions, createWindowController, CONTROLS_INSET } from '../../src/main/window.js';
import { registerIpc } from '../../src/main/ipc.js';
import { isAllowedExternal } from '../../src/main/security.js';
import { CH } from '../../src/shared/ipc.js';

function fakeWin() {
  const w = { calls: [], handlers: {}, max: false, full: false };
  w.on = (ev, fn) => { w.handlers[ev] = fn; };
  w.isMaximized = () => w.max; w.isFullScreen = () => w.full;
  w.maximize = () => { w.max = true; w.calls.push('maximize'); };
  w.unmaximize = () => { w.max = false; w.calls.push('unmaximize'); };
  w.minimize = () => w.calls.push('minimize'); w.close = () => w.calls.push('close');
  w.setTitleBarOverlay = (o) => w.calls.push(['overlay', o]);
  return w;
}

test('buildWindowOptions per platform keeps hardening', () => {
  for (const p of ['win32', 'darwin', 'linux']) {
    const o = buildWindowOptions(p, { preload: 'x.cjs' });
    assert.deepEqual(o.webPreferences, { preload: 'x.cjs', contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false });
  }
  const w = buildWindowOptions('win32');
  assert.equal(w.titleBarStyle, 'hidden');
  assert.deepEqual(w.titleBarOverlay, { color: '#141417', symbolColor: '#ececf1', height: 40 });
  const l = buildWindowOptions('linux');
  assert.equal(l.titleBarStyle, 'hidden'); assert.equal(l.titleBarOverlay.height, 40);
  const d = buildWindowOptions('darwin');
  assert.equal(d.titleBarStyle, 'hiddenInset'); assert.deepEqual(d.trafficLightPosition, { x: 16, y: 14 });
  assert.equal(d.titleBarOverlay, undefined);
});

test('windowInfo, controls inset and pushes', () => {
  const pushed = [];
  const w = fakeWin();
  const c = createWindowController(w, { platform: 'win32', push: (ch, p) => pushed.push([ch, p]) });
  assert.deepEqual(c.windowInfo(), { platform: 'win32', maximized: false, fullscreen: false, overlay: true, controlsInset: CONTROLS_INSET.win32 });
  w.max = true; w.handlers.maximize();
  assert.deepEqual(pushed[0], [CH.evWindow, { maximized: true, fullscreen: false }]);
  for (const ev of ['unmaximize', 'enter-full-screen', 'leave-full-screen']) assert.equal(typeof w.handlers[ev], 'function');
  const mac = createWindowController(fakeWin(), { platform: 'darwin' }).windowInfo();
  assert.equal(mac.overlay, false); assert.deepEqual(mac.controlsInset, { left: 80, right: 0 });
});

test('setTheme validates colours/height and only applies on overlay platforms', () => {
  const w = fakeWin();
  const c = createWindowController(w, { platform: 'win32' });
  c.setTheme({ color: '#112233', symbolColor: '#FFFFFF', height: 40 });
  assert.deepEqual(w.calls[0], ['overlay', { color: '#112233', symbolColor: '#FFFFFF', height: 40 }]);
  for (const bad of [{ color: 'red', symbolColor: '#ffffff', height: 40 }, { color: '#fff', symbolColor: '#ffffff', height: 40 },
    { color: '#112233', symbolColor: '#ffffffff', height: 40 }, { color: '#112233', symbolColor: '#ffffff', height: 23 },
    { color: '#112233', symbolColor: '#ffffff', height: 65 }, { color: '#112233', symbolColor: '#ffffff', height: 40.5 }, null]) {
    assert.throws(() => c.setTheme(bad), TypeError);
  }
  const mw = fakeWin();
  createWindowController(mw, { platform: 'darwin' }).setTheme({ color: '#112233', symbolColor: '#ffffff', height: 40 });
  assert.equal(mw.calls.length, 0);
  const thrower = fakeWin(); thrower.setTitleBarOverlay = () => { throw new Error('unsupported'); };
  createWindowController(thrower, { platform: 'linux' }).setTheme({ color: '#112233', symbolColor: '#ffffff', height: 40 });
});

test('window action allow-list', () => {
  const w = fakeWin();
  const c = createWindowController(w, { platform: 'win32' });
  c.action('minimize'); c.action('toggle-maximize'); c.action('toggle-maximize'); c.action('close');
  assert.deepEqual(w.calls, ['minimize', 'maximize', 'unmaximize', 'close']);
  assert.throws(() => c.action('destroy'), TypeError);
  assert.throws(() => c.action(undefined), TypeError);
});

test('login/window IPC handlers validate arguments', async () => {
  const handlers = {}; const calls = [];
  const mk = (n) => new Proxy({}, { get: (_t, m) => (...a) => { calls.push([n, String(m), ...a]); } });
  registerIpc({ ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } }, getWindow: () => null, login: mk('login'), windowCtl: mk('win') });
  const bad = (fn, re) => assert.rejects(async () => fn(), re);
  await bad(() => handlers[CH.loginStart]({}, 'rm'), /invalid agent/);
  await bad(() => handlers[CH.loginStart]({}, 'claude', 'x'), /options must be an object/);
  await bad(() => handlers[CH.loginStart]({}, 'claude', { kind: 'evil' }), /invalid kind/);
  await bad(() => handlers[CH.loginStart]({}, 'claude', { email: 5 }), /invalid email/);
  await bad(() => handlers[CH.loginStart]({}, 'claude', { email: 'a'.repeat(300) }), /invalid email/);
  await bad(() => handlers[CH.loginStart]({}, 'agy', { cols: 1.5 }), /invalid cols/);
  await bad(() => handlers[CH.loginStart]({}, 'agy', { rows: 1000 }), /invalid rows/);
  await bad(() => handlers[CH.loginInput]({}, 'agy', 5), /data must be a string/);
  await bad(() => handlers[CH.loginInput]({}, 'agy', 'x'.repeat(8193)), /data too long/);
  await bad(() => handlers[CH.loginResize]({}, 'agy', '80', 24), /integers/);
  await bad(() => handlers[CH.loginCancel]({}, 'x'), /invalid agent/);
  await bad(() => handlers[CH.loginLogout]({}, 'x'), /invalid agent/);
  await bad(() => handlers[CH.windowSetTheme]({}, 'x'), /theme required/);
  await bad(() => handlers[CH.windowAction]({}, 'quit'), /invalid action/);
  await handlers[CH.loginStart]({}, 'claude', { kind: 'sso', email: 'a@b.co', evil: 1 });
  assert.deepEqual(calls.at(-1), ['login', 'start', 'claude', { kind: 'sso', email: 'a@b.co', cols: undefined, rows: undefined }]);
  await handlers[CH.loginInput]({}, 'agy', 'hi');
  await handlers[CH.windowAction]({}, 'minimize');
  assert.deepEqual(calls.at(-1), ['win', 'action', 'minimize']);
});

test('external allow-list accepts sign-in hosts over https only', () => {
  assert.ok(isAllowedExternal('https://claude.com/cai/oauth/authorize?x=1'));
  assert.ok(isAllowedExternal('https://accounts.google.com/o/oauth2/v2/auth'));
  assert.ok(!isAllowedExternal('http://claude.com/x'));
  assert.ok(!isAllowedExternal('https://claude.com.evil.io/x'));
  assert.ok(!isAllowedExternal('https://user:pw@claude.com/x'));
});
