import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MENU, flattenMenu } from '../../src/shared/menu.js';
import { CH } from '../../src/shared/ipc.js';
import { buildModel, buildTemplate, createMenu, recentItems, isSafeMenuUrl, MAX_RECENT } from '../../src/main/svc/menu.js';
import { LABELS, labelFor } from '../../src/main/svc/menu-labels.js';
import { validateBounds, splashSteps, createQuitFlow, createWindowState, createSplash, createBoot, bootInfo } from '../../src/main/svc/boot.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fs-mb-'));

// ---- menu -------------------------------------------------------------------------------------------------------------------
const projs = Array.from({ length: 11 }, (_, i) => ({ id: `id${i}`, name: `Proj ${i}`, lastOpened: new Date(2026, 0, i + 1).toISOString() }));

test('menu model: File/Edit/View/Help, recents most-recent-first max 8, devOnly hidden when packaged, state', () => {
  const m = buildModel({ projects: projs, settings: { developerMode: false, theme: 'gold' }, platform: 'win32', packaged: false });
  assert.deepEqual(m.items.map((i) => i.id), ['file', 'edit', 'view', 'help']);
  const recent = m.items[0].submenu.find((i) => i.dynamic === 'recent');
  assert.equal(recent.submenu.length, MAX_RECENT);
  assert.deepEqual(recent.submenu.map((r) => r.id).slice(0, 2), ['file.recent:id10', 'file.recent:id9']);
  assert.equal(recent.submenu[0].label, 'Proj 10'); assert.equal(recent.submenu[0].literal, true); assert.equal(recent.submenu[0].handler, 'renderer');
  assert.deepEqual(m.state, { developerMode: false, theme: 'gold', platform: 'win32', packaged: false });
  assert.ok(flattenMenu(m.items).some((i) => i.id === 'view.devtools'));
  const pk = buildModel({ projects: [], settings: {}, packaged: true });
  assert.ok(!flattenMenu(pk.items).some((i) => i.id === 'view.devtools'));
  assert.equal(pk.items[0].submenu.find((i) => i.dynamic === 'recent').enabled, false);
  assert.equal(pk.state.developerMode, true);
  assert.ok(MENU.find((i) => i.id === 'file').submenu.find((i) => i.dynamic === 'recent').submenu.length === 0, 'shared MENU is not mutated');
  assert.equal(recentItems([]).length, 0);
});

test('menu labels: every key has EN and ES text', () => {
  const keys = new Set();
  const walk = (items) => { for (const it of items) { if (it.label) keys.add(it.label); if (it.submenu) walk(it.submenu); } };
  walk(MENU);
  for (const k of keys) { assert.ok(LABELS.en[k], `en ${k}`); assert.ok(LABELS.es[k], `es ${k}`); }
  assert.equal(labelFor('es', 'menu.file'), 'Archivo'); assert.equal(labelFor('xx', 'menu.file'), 'File'); assert.equal(labelFor('en', 'menu.nope'), 'menu.nope');
});

test('native template: translated labels, roles, accelerators, checked radios, recents, darwin app menu and no duplicate Quit', () => {
  const m = buildModel({ projects: projs.slice(0, 2), settings: { developerMode: true, theme: 'light' } });
  const clicks = [];
  const tpl = buildTemplate(m, { lang: 'es', platform: 'win32', onClick: (it) => clicks.push(it.id) });
  assert.deepEqual(tpl.map((t) => t.label), ['Archivo', 'Edicion', 'Ver', 'Ayuda']);
  const file = tpl[0].submenu;
  assert.equal(file.find((x) => x.label === 'Guardar estado').accelerator, 'CmdOrCtrl+S');
  file.find((x) => x.label === 'Guardar estado').click();
  file.find((x) => x.label === 'Salir').click(); // file.quit is a click action (the flow handles quit), not role:quit
  assert.deepEqual(clicks, ['file.saveState', 'file.quit']);
  const recent = file.find((x) => x.label === 'Abrir reciente');
  assert.deepEqual(recent.submenu.map((r) => r.label), ['Proj 1', 'Proj 0']);
  recent.submenu[0].click(); assert.equal(clicks.at(-1), 'file.recent:id1');
  const edit = tpl[1].submenu;
  assert.equal(edit.find((x) => x.role === 'undo').accelerator, 'CmdOrCtrl+Z');
  const view = tpl[2].submenu;
  assert.equal(view.find((x) => x.label === 'Modo desarrollador').checked, true);
  const theme = view.find((x) => x.label === 'Tema').submenu;
  assert.deepEqual(theme.map((x) => [x.label, x.checked, x.type]), [['Oscuro', false, 'radio'], ['Claro', true, 'radio'], ['Dorado', false, 'radio']]);
  const empty = buildTemplate(buildModel({ projects: [], settings: {} }), { lang: 'en', platform: 'win32' })[0].submenu.find((x) => x.label === 'Open recent');
  assert.deepEqual(empty.submenu, [{ label: 'No recent projects', enabled: false }]);
  const mac = buildTemplate(m, { lang: 'en', platform: 'darwin' });
  assert.deepEqual(mac[0], { role: 'appMenu' });
  assert.ok(!JSON.stringify(mac[1].submenu.map((x) => x.label)).includes('Quit'));
});

function mkMenuEnv({ packaged = false, win } = {}) {
  const calls = []; const pushes = []; const opened = [];
  const w = win ?? {
    isDestroyed: () => false, isVisible: () => true, isFullScreen: () => false, setFullScreen: (v) => calls.push(['fullscreen', v]),
    webContents: { undo: () => calls.push('undo'), copy: () => calls.push('copy'), getZoomLevel: () => 1, setZoomLevel: (v) => calls.push(['zoom', v]), toggleDevTools: () => calls.push('devtools') },
  };
  let settingsNow = { language: 'en', theme: 'dark', developerMode: true };
  let list = projs.slice(0, 2);
  const built = [];
  const Menu = { buildFromTemplate: (t) => ({ tpl: t }), setApplicationMenu: (m) => built.push(m) };
  const services = { store: { saveAll: () => calls.push('saveAll') } };
  let tick = null;
  const menu = createMenu({
    app: { isPackaged: packaged, quit: () => calls.push('quit') }, Menu, shell: { openExternal: (u) => opened.push(u) }, getWindow: () => w,
    settings: { get: () => settingsNow }, projects: { list: () => list }, services, push: (ch, p) => pushes.push([ch, p]), platform: 'win32',
    setIntervalFn: (fn) => { tick = fn; return { unref() {} }; },
  });
  return { menu, calls, pushes, opened, built, setSettings: (s) => { settingsNow = { ...settingsNow, ...s }; }, setList: (l) => { list = l; }, tick: () => tick() };
}

test('menu service: invoke runs main actions, ignores renderer ids, https+repo-only URLs, native click pushes ev:menu, rebuild on change', () => {
  const e = mkMenuEnv();
  assert.equal(e.built.length, 1, 'native menu set on create');
  assert.deepEqual(e.menu.invoke('file.saveState'), { ok: true });
  assert.deepEqual(e.menu.invoke('file.quit'), { ok: true });
  assert.deepEqual(e.menu.invoke('edit.undo'), { ok: true });
  assert.deepEqual(e.menu.invoke('view.zoomIn'), { ok: true });
  assert.deepEqual(e.menu.invoke('view.fullscreen'), { ok: true });
  assert.deepEqual(e.menu.invoke('view.devtools'), { ok: true });
  assert.deepEqual(e.calls, ['saveAll', 'quit', 'undo', ['zoom', 1.5], ['fullscreen', true], 'devtools']);
  assert.deepEqual(e.menu.invoke('help.docs'), { ok: true });
  assert.deepEqual(e.opened, ['https://github.com/lnrd-o/flowstate-app#readme']);
  for (const id of ['file.newProject', 'file.recent:id1', 'view.devMode', 'help.about', 'nope', 'file.recent']) assert.deepEqual(e.menu.invoke(id), { ok: false }, id);
  assert.deepEqual(e.menu.invoke(42), { ok: false });
  assert.ok(isSafeMenuUrl('https://github.com/lnrd-o/flowstate-app/issues/new'));
  for (const u of ['http://github.com/lnrd-o/flowstate-app', 'https://github.com/evil/x', 'https://github.com.evil.com/lnrd-o/flowstate-app', 'https://github.com/lnrd-o/flowstate-app-evil', 'file:///c:/x']) assert.ok(!isSafeMenuUrl(u), u);
  // native click for a renderer-handled item
  const tpl = e.built[0].tpl;
  tpl[0].submenu.find((x) => x.label === 'Open folder...').click();
  assert.deepEqual(e.pushes.at(-1), [CH.evMenu, { id: 'file.openFolder' }]);
  // rebuild only when language/theme/devMode/recents change
  e.tick(); assert.equal(e.built.length, 1);
  e.setSettings({ theme: 'gold' }); e.tick(); assert.equal(e.built.length, 2);
  e.setList(projs.slice(0, 3)); e.tick(); assert.equal(e.built.length, 3);
  e.setSettings({ language: 'es' }); e.tick(); assert.equal(e.built.length, 4);
  assert.equal(e.built[3].tpl[0].label, 'Archivo');
  e.setSettings({ developerMode: false }); e.tick(); assert.equal(e.built.length, 5);
  assert.deepEqual(e.menu.model().state, { developerMode: false, theme: 'gold', platform: 'win32', packaged: false });
  const pk = mkMenuEnv({ packaged: true });
  assert.deepEqual(pk.menu.invoke('view.devtools'), { ok: false });
});

// ---- boot -------------------------------------------------------------------------------------------------------------------
const D1 = { workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
const D2 = { workArea: { x: 1920, y: 0, width: 1280, height: 1024 } };

test('validateBounds: keeps good bounds, drops off-screen / missing-display positions, clamps sizes, never restores fullscreen', () => {
  assert.deepEqual(validateBounds({ x: 100, y: 80, width: 1400, height: 900, maximized: true }, [D1]), { x: 100, y: 80, width: 1400, height: 900, maximized: true });
  assert.deepEqual(validateBounds({ x: 2000, y: 100, width: 1100, height: 700 }, [D1, D2]), { x: 2000, y: 100, width: 1100, height: 700, maximized: false });
  // the second monitor was unplugged: position dropped (OS centres it), size kept
  assert.deepEqual(validateBounds({ x: 2000, y: 100, width: 1100, height: 700 }, [D1]), { width: 1100, height: 700, maximized: false });
  assert.deepEqual(validateBounds({ x: -5000, y: -5000, width: 1100, height: 700 }, [D1]), { width: 1100, height: 700, maximized: false });
  assert.equal(validateBounds({ x: 1900, y: 100, width: 1100, height: 700 }, [D1]).x, undefined, 'only 20 px visible: not reachable');
  assert.equal(validateBounds({ x: 100, y: -300, width: 1100, height: 700 }, [D1]).x, undefined, 'title bar above the screen');
  // sizes: min enforced, larger than the display clamped, junk -> defaults
  assert.deepEqual(validateBounds({ width: 200, height: 100 }, [D1]), { width: 1000, height: 650, maximized: false });
  assert.deepEqual(validateBounds({ width: 9999, height: 9999 }, [D1]), { width: 1920, height: 1040, maximized: false });
  assert.deepEqual(validateBounds({ x: 'a', y: null, width: 'big', height: NaN, fullscreen: true }, [D1]), { width: 1280, height: 800, maximized: false });
  assert.deepEqual(validateBounds(null, []), { width: 1280, height: 800, maximized: false });
  assert.deepEqual(validateBounds(undefined, undefined), { width: 1280, height: 800, maximized: false });
  assert.deepEqual(validateBounds({ x: 10, y: 10, width: 1100, height: 700 }, []), { width: 1100, height: 700, maximized: false }, 'no displays known: no position');
});

test('window state: save uses normal bounds, skips minimized/fullscreen, load validates, track debounces and saves on close', () => {
  const dir = tmp();
  let timers = [];
  const ws = createWindowState({ dir, screen: { getAllDisplays: () => [D1] }, setTimeoutFn: (fn) => { timers.push(fn); return { unref() {} }; }, clearTimeoutFn: () => { timers = []; } });
  assert.deepEqual(ws.load(), { width: 1280, height: 800, maximized: false });
  const handlers = {};
  const win = {
    isDestroyed: () => false, isMinimized: () => false, isFullScreen: () => false, isMaximized: () => true,
    getNormalBounds: () => ({ x: 50, y: 60, width: 1300, height: 820 }), on: (e, fn) => { handlers[e] = fn; },
  };
  ws.track(win);
  handlers.move(); handlers.resize();
  assert.ok(!fs.existsSync(ws.file), 'debounced');
  timers.at(-1)();
  assert.deepEqual(JSON.parse(fs.readFileSync(ws.file, 'utf8')), { x: 50, y: 60, width: 1300, height: 820, maximized: true });
  assert.deepEqual(ws.load(), { x: 50, y: 60, width: 1300, height: 820, maximized: true });
  fs.rmSync(ws.file);
  ws.save({ ...win, isFullScreen: () => true }); assert.ok(!fs.existsSync(ws.file), 'fullscreen is never saved');
  ws.save({ ...win, isMinimized: () => true }); assert.ok(!fs.existsSync(ws.file));
  handlers.close(); assert.ok(fs.existsSync(ws.file), 'saved immediately on close');
  fs.writeFileSync(ws.file, '{broken');
  assert.deepEqual(ws.load(), { width: 1280, height: 800, maximized: false });
  assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith('.tmp')));
});

test('splash steps: model, EN/ES, resume step only when a last project is known', () => {
  assert.deepEqual(splashSteps('en', { projectCount: 3, lastProjectName: 'Alpha' }).map((s) => s.label), ['Loading modules', 'Reading settings', 'Restoring projects (3)', 'Resuming Alpha', 'Starting services', 'Checking tools', 'Opening FlowState']);
  assert.deepEqual(splashSteps('en', {}).map((s) => s.key), ['modules', 'settings', 'projects', 'services', 'tools', 'open']);
  assert.equal(splashSteps('es', { projectCount: 0 })[2].label, 'Restaurando proyectos (0)');
  assert.equal(splashSteps('fr', {})[0].label, 'Loading modules');
  assert.equal(splashSteps('en', { lastProjectName: 'x'.repeat(100) }).find((s) => s.key === 'resume').label.length, 'Resuming '.length + 60);
});

function fakeBrowserWindow() {
  const wins = [];
  class W {
    constructor(opts) { this.opts = opts; this.js = []; this.listeners = {}; this.closed = false; this.webContents = { once: (e, fn) => { this.listeners[e] = fn; }, executeJavaScript: async (c) => { this.js.push(c); } }; wins.push(this); }
    setMenu() {} once(e, fn) { this.listeners[e] = fn; } on(e, fn) { this.listeners[e] = fn; }
    loadFile(f) { this.file = f; Promise.resolve().then(() => { this.shown ||= false; this.listeners['did-finish-load']?.(); this.listeners['ready-to-show']?.(); }); }
    show() { this.shown = true; } isDestroyed() { return this.closed; } close() { this.closed = true; this.listeners.closed?.(); }
  }
  return { W, wins };
}

test('splash window: frameless 440x320, dark, always on top, hardened; steps use JSON-stringified constants; minimum visible time', async () => {
  const { W, wins } = fakeBrowserWindow();
  let t = 1000; const waits = [];
  const sp = createSplash({ BrowserWindow: W, file: '/x/splash.html', name: 'FlowState', version: 'v1', lang: 'es', now: () => t, setTimeoutFn: (fn, ms) => { waits.push(ms); t += ms; fn(); return {}; } });
  sp.open();
  const o = wins[0].opts;
  assert.deepEqual([o.width, o.height, o.frame, o.alwaysOnTop, o.transparent], [440, 320, false, true, true]);
  assert.deepEqual([o.webPreferences.contextIsolation, o.webPreferences.nodeIntegration, o.webPreferences.sandbox], [true, false, true]);
  await sp.step('modules', 'Loading "modules"');
  await sp.step('x', 'Restoring </script><b> (2)');
  const js = wins[0].js;
  assert.equal(js[0], 'window.__splash.init("FlowState", "v1", "es")');
  assert.equal(js[1], 'window.__splash.step("modules", "Loading \\"modules\\"")');
  assert.equal(js[2], 'window.__splash.step("x", "Restoring </script><b> (2)")');
  await sp.close();
  assert.equal(wins[0].closed, true);
  assert.deepEqual(waits, [700], 'kept visible for the minimum time');
  const again = await sp.close(); assert.equal(again, undefined);
  // the splash file itself: strict CSP, no inline script, no remote content
  const html = fs.readFileSync(path.join(process.cwd(), 'src', 'main', 'splash', 'splash.html'), 'utf8');
  assert.ok(/Content-Security-Policy/.test(html) && html.includes("default-src 'none'") && html.includes("script-src 'self'"));
  assert.ok(!/<script(?![^>]*\bsrc=)/.test(html) && !/https?:\/\//.test(html.replace('http://www.w3.org', '')));
  const css = fs.readFileSync(path.join(process.cwd(), 'src', 'main', 'splash', 'splash.css'), 'utf8');
  assert.ok(css.includes('prefers-reduced-motion'));
});

test('quit flow ordering: before-quit -> wait for flushed (max 2 s) -> save -> usage flush -> stop -> quit; double quit guarded', async () => {
  const log = []; let pushed = false; let quits = 0;
  const flow = createQuitFlow({
    pushBeforeQuit: () => { pushed = true; return true; }, saveAll: () => log.push('saveAll'), flushUsage: () => log.push('flushUsage'),
    stopAll: () => log.push('stopAll'), quit: () => { quits++; }, waitMs: 5000, log,
  });
  const p1 = flow.run(); const p2 = flow.run();
  assert.equal(p1, p2, 'second quit returns the same flow');
  await Promise.resolve();
  assert.ok(pushed); assert.ok(!log.includes('saveAll'), 'waits for the renderer first');
  assert.equal(flow.done, false);
  flow.flushed();
  await p1;
  assert.ok(log.indexOf('before-quit') < log.indexOf('flushed-or-timeout') && log.indexOf('flushed-or-timeout') < log.indexOf('save-projects'));
  assert.ok(log.indexOf('save-projects') < log.indexOf('flush-usage') && log.indexOf('flush-usage') < log.indexOf('stop-services') && log.indexOf('stop-services') < log.indexOf('quit'));
  assert.ok(log.indexOf('saveAll') < log.indexOf('flushUsage') && log.indexOf('flushUsage') < log.indexOf('stopAll'));
  assert.equal(quits, 1); assert.equal(flow.done, true);
  await flow.run(); assert.equal(quits, 1);
});

test('quit flow: timeout when the renderer never answers; no wait without a window; a throwing step does not stop the rest', async () => {
  let fire; let quits = 0; const log = [];
  const slow = createQuitFlow({ pushBeforeQuit: () => true, saveAll() {}, flushUsage() {}, stopAll() {}, quit: () => { quits++; }, setTimeoutFn: (fn, ms) => { assert.equal(ms, 2000); fire = fn; return {}; }, clearTimeoutFn() {}, log });
  const p = slow.run();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(quits, 0); fire(); await p;
  assert.equal(quits, 1); assert.ok(log.includes('flushed-or-timeout'));
  const log2 = [];
  const nowin = createQuitFlow({ pushBeforeQuit: () => false, saveAll: () => { throw new Error('disk'); }, flushUsage: () => log2.push('u'), stopAll: () => log2.push('s'), quit: () => log2.push('q'), log: log2 });
  await nowin.run();
  assert.ok(!log2.includes('flushed-or-timeout'));
  assert.deepEqual(log2.filter((x) => ['u', 's', 'q'].includes(x)), ['u', 's', 'q']);
});

test('boot controller: window options restore bounds with show:false; shown only after renderer ready AND the hold gate; 10 s fallback; info', async () => {
  const { W, wins } = fakeBrowserWindow();
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'window-state.json'), JSON.stringify({ x: 40, y: 50, width: 1500, height: 900, maximized: true }));
  const timers = [];
  const calls = [];
  const app = { getName: () => 'FlowState', getVersion: () => '9.9.9', getPath: () => dir, isPackaged: false };
  const boot = createBoot({
    app, BrowserWindow: W, screen: { getAllDisplays: () => [D1] }, dir, here: '/x', settings: { get: () => ({ language: 'en' }) },
    setTimeoutFn: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; }, clearTimeoutFn() {},
  });
  assert.deepEqual(Object.keys(boot.info()).sort(), ['arch', 'chrome', 'electron', 'name', 'node', 'packaged', 'platform', 'userData', 'version']);
  assert.equal(bootInfo({ app, versions: { electron: '45', chrome: '1', node: '2' }, platform: 'win32', arch: 'x64' }).version, '9.9.9');
  const opts = boot.windowOptions({ width: 1280, height: 800, title: 'FlowState' });
  assert.deepEqual([opts.x, opts.y, opts.width, opts.height, opts.show, opts.title, opts.maximized], [40, 50, 1500, 900, false, 'FlowState', undefined]);
  const win = {
    isDestroyed: () => false, on() {}, maximize: () => calls.push('maximize'), show: () => calls.push('show'), focus() {},
  };
  let release; boot.hold(new Promise((r) => { release = r; }));
  boot.attachWindow(win);
  assert.ok(timers.some((t) => t.ms === 10000), 'fallback timer armed');
  boot.ready();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, [], 'renderer ready but tools check still running: window stays hidden');
  release(); await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, ['maximize', 'show']);
  boot.ready(); await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, ['maximize', 'show'], 'idempotent');
  // fallback path
  const calls2 = []; const timers2 = [];
  const boot2 = createBoot({ app, BrowserWindow: W, screen: { getAllDisplays: () => [D1] }, dir: tmp(), here: '/x', settings: { get: () => ({ language: 'es' }) }, setTimeoutFn: (fn, ms) => { timers2.push({ fn, ms }); return { unref() {} }; }, clearTimeoutFn() {} });
  boot2.attachWindow({ isDestroyed: () => false, on() {}, maximize() {}, show: () => calls2.push('show'), focus() {} });
  timers2.find((t) => t.ms === 10000).fn();
  assert.deepEqual(calls2, ['show']);
  void wins;
});
