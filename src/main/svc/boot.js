// Boot / lifecycle: splash window, main-window state (userData/window-state.json), show-on-ready, quit flow, about info.
// Pure helpers (validateBounds, splashSteps, createQuitFlow) are unit-tested with fakes; Electron objects are injected.
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic, readJson } from '../settings.js';

export const MIN_SIZE = Object.freeze({ width: 1000, height: 650 });
export const DEFAULT_SIZE = Object.freeze({ width: 1280, height: 800 });
export const MIN_SPLASH_MS = 700;
export const READY_FALLBACK_MS = 10000;
export const FLUSH_WAIT_MS = 2000;

const isInt = (v) => Number.isFinite(v) && Math.abs(v) < 100000;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Validate saved window bounds against the current displays (screen.getAllDisplays()).
 * -> {width, height, x?, y?, maximized} always safe to hand to BrowserWindow. x/y are dropped (window centred by the OS) when the saved
 * position is not meaningfully visible on any display (monitor unplugged, resolution change). Fullscreen is never restored.
 */
export function validateBounds(saved, displays, defaults = DEFAULT_SIZE) {
  const list = Array.isArray(displays) ? displays.map((d) => d?.workArea ?? d?.bounds).filter((r) => r && r.width > 0 && r.height > 0) : [];
  const primary = list[0] ?? { x: 0, y: 0, width: defaults.width, height: defaults.height };
  const s = saved && typeof saved === 'object' ? saved : {};
  const maxW = Math.max(MIN_SIZE.width, primary.width);
  const maxH = Math.max(MIN_SIZE.height, primary.height);
  const fit = (v, lo, hi, dflt) => clamp(isInt(v) ? Math.round(v) : dflt, lo, hi);
  const out = { width: fit(s.width, MIN_SIZE.width, maxW, defaults.width), height: fit(s.height, MIN_SIZE.height, maxH, defaults.height), maximized: s.maximized === true };
  if (isInt(s.x) && isInt(s.y) && list.length) {
    const visible = list.some((d) => {
      const w = Math.min(s.x + out.width, d.x + d.width) - Math.max(s.x, d.x);
      const h = Math.min(s.y + out.height, d.y + d.height) - Math.max(s.y, d.y);
      return w >= 120 && h >= 60 && s.y >= d.y - 8; // title bar must be reachable
    });
    if (visible) { out.x = Math.round(s.x); out.y = Math.round(s.y); }
  }
  return out;
}

export function createWindowState({ dir, fsx = fs, screen = null, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, debounceMs = 500 } = {}) {
  const file = path.join(dir, 'window-state.json');
  return {
    file,
    /** -> validated options for `new BrowserWindow` (+ maximized flag). */
    load() {
      const saved = readJson(file, null, fsx);
      let displays = [];
      try { displays = screen?.getAllDisplays?.() ?? []; } catch { displays = []; }
      return validateBounds(saved, displays);
    },
    save(win) {
      try {
        if (!win || win.isDestroyed?.() || win.isMinimized?.() || win.isFullScreen?.()) return;
        const b = win.getNormalBounds?.() ?? win.getBounds();
        writeJsonAtomic(file, { x: b.x, y: b.y, width: b.width, height: b.height, maximized: !!win.isMaximized?.() }, fsx);
      } catch { /* best effort */ }
    },
    /** Debounced save on move/resize/maximize + immediate save on close. */
    track(win) {
      let t = null;
      const later = () => { if (t) clearTimeoutFn(t); t = setTimeoutFn(() => { t = null; this.save(win); }, debounceMs); t?.unref?.(); };
      for (const e of ['resize', 'move', 'maximize', 'unmaximize']) win.on(e, later);
      win.on('close', () => { if (t) { clearTimeoutFn(t); t = null; } this.save(win); });
    },
  };
}

const STEP_LABELS = {
  en: { modules: 'Loading modules', settings: 'Reading settings', projects: (n) => `Restoring projects (${n})`, resume: (name) => `Resuming ${name}`, services: 'Starting services', tools: 'Checking tools', open: 'Opening FlowState' },
  es: { modules: 'Cargando modulos', settings: 'Leyendo ajustes', projects: (n) => `Restaurando proyectos (${n})`, resume: (name) => `Retomando ${name}`, services: 'Iniciando servicios', tools: 'Comprobando herramientas', open: 'Abriendo FlowState' },
};

/** Ordered splash steps [{key,label}] for the language and the registry. */
export function splashSteps(lang, { projectCount = 0, lastProjectName = null } = {}) {
  const L = STEP_LABELS[lang] ?? STEP_LABELS.en;
  const steps = [{ key: 'modules', label: L.modules }, { key: 'settings', label: L.settings }, { key: 'projects', label: L.projects(projectCount) }];
  if (lastProjectName) steps.push({ key: 'resume', label: L.resume(String(lastProjectName).slice(0, 60)) });
  steps.push({ key: 'services', label: L.services }, { key: 'tools', label: L.tools }, { key: 'open', label: L.open });
  return steps;
}

/** The splash BrowserWindow. Steps are pushed with executeJavaScript using JSON-stringified constants only. */
export function createSplash({
  BrowserWindow, file, name = 'FlowState', version = '', lang = 'en', now = Date.now, setTimeoutFn = setTimeout, minMs = MIN_SPLASH_MS,
} = {}) {
  let win = null;
  let loaded = null;
  let shownAt = 0;
  let closed = false;
  const run = async (code) => { if (win && !win.isDestroyed()) { try { await win.webContents.executeJavaScript(code); } catch { /* splash is cosmetic */ } } };
  return {
    open() {
      try {
        win = new BrowserWindow({
          width: 440, height: 320, frame: false, transparent: true, backgroundColor: '#00000000', resizable: false, maximizable: false,
          minimizable: false, fullscreenable: false, alwaysOnTop: true, skipTaskbar: true, show: false, center: true, hasShadow: true,
          webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false, devTools: false },
        });
        win.setMenu?.(null);
        win.once('ready-to-show', () => { if (win && !win.isDestroyed()) { win.show(); shownAt = now(); } });
        loaded = new Promise((res) => { win.webContents.once('did-finish-load', res); win.webContents.once('did-fail-load', res); });
        win.on('closed', () => { win = null; });
        win.loadFile(file);
        loaded = loaded.then(() => run(`window.__splash.init(${JSON.stringify(name)}, ${JSON.stringify(version)}, ${JSON.stringify(lang)})`));
      } catch { win = null; }
    },
    async step(key, label) {
      if (!loaded) return;
      await loaded;
      await run(`window.__splash.step(${JSON.stringify(key)}, ${JSON.stringify(label)})`);
    },
    isOpen: () => !!win && !closed,
    /** Close after the minimum visible time. */
    close() {
      if (closed) return Promise.resolve();
      closed = true;
      return new Promise((resolve) => {
        const done = () => { try { if (win && !win.isDestroyed()) win.close(); } catch { /* ignore */ } win = null; resolve(); };
        const left = shownAt ? shownAt + minMs - now() : 0;
        run('window.__splash.finish()').then(() => { if (left > 0) setTimeoutFn(done, left); else done(); });
      });
    },
  };
}

/**
 * Ordered quit flow. Deps are injected so the ordering is testable:
 *  pushBeforeQuit() -> true when a renderer window received ev:before-quit (then we wait for app:flushed, max waitMs)
 *  saveAll(), flushUsage(), stopAll(), quit()
 */
export function createQuitFlow({ pushBeforeQuit, saveAll, flushUsage, stopAll, quit, waitMs = FLUSH_WAIT_MS, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, log = [] } = {}) {
  let running = null;
  let done = false;
  let flushedResolve = null;
  const flushedP = new Promise((r) => { flushedResolve = r; });
  const step = (name, fn) => { log.push(name); try { return fn?.(); } catch { return undefined; } };
  return {
    get done() { return done; },
    get running() { return !!running; },
    flushed() { flushedResolve(); },
    /** Idempotent: a second call returns the same promise (guards double quit). */
    run() {
      if (running) return running;
      running = (async () => {
        const sent = step('before-quit', pushBeforeQuit);
        if (sent) {
          let timer;
          await Promise.race([flushedP, new Promise((r) => { timer = setTimeoutFn(r, waitMs); timer?.unref?.(); })]);
          clearTimeoutFn(timer);
          log.push('flushed-or-timeout');
        }
        step('save-projects', saveAll);
        step('flush-usage', flushUsage);
        step('stop-services', stopAll);
        done = true;
        step('quit', quit);
      })();
      return running;
    },
  };
}

/** About info (also used by the e2e). */
export function bootInfo({ app, versions = process.versions, platform = process.platform, arch = process.arch } = {}) {
  return {
    name: app.getName?.() ?? 'FlowState', version: app.getVersion?.() ?? '', electron: versions.electron ?? '', chrome: versions.chrome ?? '', node: versions.node ?? '',
    platform, arch, userData: app.getPath?.('userData') ?? '', packaged: !!app.isPackaged,
  };
}

/**
 * Boot controller: splash + show-on-ready + window state + quit flow, created by main.js BEFORE the other services so the splash
 * appears as early as possible. The renderer calls app:ready (-> ready()) after its first render and app:flushed (-> flushed()).
 */
export function createBoot({
  app, BrowserWindow, screen, dir, here, settings, fsx = fs, now = Date.now, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout,
  readyFallbackMs = READY_FALLBACK_MS, quit = null,
} = {}) {
  const windowState = createWindowState({ dir, fsx, screen });
  const lang = () => settings?.get?.().language ?? 'en';
  const info = bootInfo({ app });
  const splash = createSplash({ BrowserWindow, file: path.join(here, 'splash', 'splash.html'), name: info.name, version: `v${info.version}`, lang: lang(), now, setTimeoutFn });
  let mainWin = null;
  let isReady = false;
  let shown = false;
  let fallback = null;
  let wantMaximized = false;
  let started = false;
  const steps = new Map();
  const announced = new Set();
  let gate = Promise.resolve();
  let stepChain = Promise.resolve();

  const show = () => {
    if (shown) return;
    shown = true;
    if (fallback) { clearTimeoutFn(fallback); fallback = null; }
    const w = mainWin;
    if (w && !w.isDestroyed()) {
      if (wantMaximized) w.maximize();
      w.show();
      w.focus?.();
    }
    stepChain = stepChain.then(() => splash.close());
  };

  const self = {
    windowState, splash, info: () => info,
    /** Window options (bounds restored) for the main window; show:false so it appears only when the renderer is ready. */
    windowOptions(base) {
      const b = windowState.load();
      wantMaximized = b.maximized;
      const { maximized, ...bounds } = b;
      return { ...base, ...bounds, show: false };
    },
    start({ projectCount = 0, lastProjectName = null } = {}) {
      if (started) return;
      started = true;
      for (const s of splashSteps(lang(), { projectCount, lastProjectName })) steps.set(s.key, s.label);
      splash.open();
    },
    /** Announce a boot step (only known keys; the label comes from the language table). */
    step(key) {
      const label = steps.get(key);
      if (!label || announced.has(key)) return;
      announced.add(key);
      stepChain = stepChain.then(() => splash.step(key, label));
    },
    attachWindow(w) {
      mainWin = w;
      shown = false; isReady = false; // a re-created window (macOS activate) goes through the same show-on-ready path
      windowState.track(w);
      fallback = setTimeoutFn(() => show(), readyFallbackMs);
      fallback?.unref?.();
    },
    /** app:ready from the renderer. */
    ready() {
      isReady = true;
      gate.then(() => { if (!isReady) return; self.step('open'); show(); });
    },
    /** The window is not shown before this promise settles (first health poll), even if the renderer is ready earlier. */
    hold(p) { gate = Promise.resolve(p).catch(() => {}); },
    isReady: () => isReady,
    flushed() { self.quitFlow?.flushed(); },
    quitFlow: null,
  };
  return self;
}

export function create(deps) {
  // main.js builds the boot controller early (before services) and registers it as services.boot; this keeps that instance.
  if (deps.services?.boot) return deps.services.boot;
  return createBoot({ app: deps.electron.app, BrowserWindow: deps.electron.BrowserWindow, screen: deps.electron.screen, dir: deps.dir, here: path.join(deps.dir), settings: deps.settings });
}
