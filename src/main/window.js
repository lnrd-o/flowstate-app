// Custom title bar + window controller (pure of Electron imports so it is unit-testable).
import { CH } from '../shared/ipc.js';

/**
 * Space (CSS px) the renderer must keep free for the native window controls, per platform.
 *  win32/linux: titleBarOverlay draws the min/max/close buttons at the top-right; ~140 px covers them at 100-200% scaling.
 *  darwin: titleBarStyle 'hiddenInset' puts the traffic lights at the top-left; ~80 px covers them.
 */
export const CONTROLS_INSET = Object.freeze({
  win32: Object.freeze({ left: 0, right: 140 }),
  linux: Object.freeze({ left: 0, right: 140 }),
  darwin: Object.freeze({ left: 80, right: 0 }),
});
export const TITLEBAR = Object.freeze({ color: '#141417', symbolColor: '#ececf1', height: 40 });
export const WINDOW_ACTIONS = Object.freeze(['minimize', 'toggle-maximize', 'close']);
const HEX = /^#[0-9a-fA-F]{6}$/;

/** BrowserWindow options for a platform (hardening kept identical on every platform). */
export function buildWindowOptions(platform, { preload } = {}) {
  const opts = {
    width: 1280, height: 800, minWidth: 1000, minHeight: 650, title: 'FlowState', backgroundColor: '#17171a',
    autoHideMenuBar: true,
    webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false },
  };
  if (platform === 'darwin') {
    opts.titleBarStyle = 'hiddenInset';
    opts.trafficLightPosition = { x: 16, y: 14 };
  } else {
    opts.titleBarStyle = 'hidden';
    opts.titleBarOverlay = { ...TITLEBAR };
  }
  return opts;
}

export function createWindowController(win, { platform = process.platform, push = () => {} } = {}) {
  const overlay = platform === 'win32' || platform === 'linux';
  const state = () => ({ maximized: !!win.isMaximized?.(), fullscreen: !!win.isFullScreen?.() });
  const notify = () => { try { push(CH.evWindow, state()); } catch { /* ignore */ } };
  for (const ev of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) win.on?.(ev, notify);

  return {
    windowInfo: () => ({
      platform, ...state(), overlay, controlsInset: { ...(CONTROLS_INSET[platform] ?? CONTROLS_INSET.linux) },
    }),
    setTheme(theme) {
      const { color, symbolColor, height } = theme ?? {};
      if (typeof color !== 'string' || !HEX.test(color)) throw new TypeError('invalid color');
      if (typeof symbolColor !== 'string' || !HEX.test(symbolColor)) throw new TypeError('invalid symbolColor');
      if (!Number.isInteger(height) || height < 24 || height > 64) throw new TypeError('invalid height');
      if (!overlay || typeof win.setTitleBarOverlay !== 'function') return;
      try { win.setTitleBarOverlay({ color, symbolColor, height }); } catch { /* not supported on this window */ }
    },
    action(name) {
      if (!WINDOW_ACTIONS.includes(name)) throw new TypeError('invalid action');
      if (name === 'minimize') win.minimize();
      else if (name === 'close') win.close();
      else if (win.isMaximized()) win.unmaximize();
      else win.maximize();
    },
  };
}
