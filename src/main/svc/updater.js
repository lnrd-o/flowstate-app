// Auto-update from GitHub Releases (electron-updater). Packaged Windows (NSIS install) and Linux (AppImage) builds only: the portable
// exe, macOS (needs a signed + notarized app) and dev runs never update themselves.
//   - checks 20 s after start and every 6 hours, downloads in the background;
//   - when the download is ready and "Install updates automatically" is on (default), it waits until nothing is running (no agent turn,
//     no methodology run), shows a 15 s countdown (Cancel / Update now) and then restarts and installs silently;
//   - otherwise (or after Cancel) it shows "Restart to update"; the update is also installed when the app is closed.
import { CH } from '../../shared/ipc.js';

const CHECK_EVERY = 6 * 3600 * 1000;

export async function create({ electron, push = () => {}, settings, agents, runner, updaterImpl = null, idleMs = 20000, countdownMs = 15000, firstCheckMs = 20000 }) {
  const app = electron?.app;
  let state = { status: 'idle', version: null, error: null, supported: false };
  const set = (patch) => { state = { ...state, ...patch }; push(CH.evUpdate, { ...state }); };

  const portable = !!process.env.PORTABLE_EXECUTABLE_DIR;
  const supported = !!updaterImpl || (!!app?.isPackaged && !portable && (process.platform === 'win32' || (process.platform === 'linux' && !!process.env.APPIMAGE)));
  state.supported = supported;
  const none = { status: () => ({ ...state }), check: async () => ({ ...state }), install: () => false, cancel: () => false, dispose() {} };
  if (!supported) return none;

  let autoUpdater = updaterImpl;
  if (!autoUpdater) {
    try {
      const mod = await import('electron-updater'); // CommonJS package: named export or under default
      autoUpdater = mod.autoUpdater ?? mod.default?.autoUpdater;
      if (!autoUpdater) throw new Error('electron-updater not available');
    } catch (e) {
      state = { ...state, supported: false, error: String(e?.message ?? e) };
      return none;
    }
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;

  let idleTimer = null;
  let countdownTimer = null;
  let declined = null; // version whose automatic install the user cancelled
  const isIdle = () => !(agents?.listRunning?.() ?? []).length && !(runner?.listActive?.() ?? []).length;
  const autoOn = () => settings?.get?.().autoInstallUpdates !== false;
  const stopTimers = () => { clearInterval(idleTimer); clearTimeout(countdownTimer); idleTimer = null; countdownTimer = null; };

  const doInstall = () => { stopTimers(); setImmediate(() => autoUpdater.quitAndInstall(true, true)); };

  /** Ready: wait for an idle moment, then count down and install. */
  function armAutoInstall() {
    stopTimers();
    if (!autoOn() || declined === state.version) return;
    idleTimer = setInterval(() => {
      if (state.status !== 'ready' || !autoOn() || declined === state.version) { stopTimers(); return; }
      if (!isIdle()) return;
      clearInterval(idleTimer); idleTimer = null;
      set({ status: 'installing', at: Date.now() + countdownMs });
      countdownTimer = setTimeout(() => {
        if (state.status !== 'installing') return;
        if (!isIdle()) { set({ status: 'ready', at: null }); armAutoInstall(); return; } // something started meanwhile: wait again
        doInstall();
      }, countdownMs);
      countdownTimer.unref?.();
    }, idleMs);
    idleTimer.unref?.();
  }

  autoUpdater.on('checking-for-update', () => set({ status: 'checking', error: null }));
  autoUpdater.on('update-available', (i) => set({ status: 'downloading', version: i?.version ?? null, percent: 0 }));
  autoUpdater.on('update-not-available', () => set({ status: 'current' }));
  autoUpdater.on('download-progress', (p) => set({ status: 'downloading', percent: Math.round(p?.percent ?? 0) }));
  autoUpdater.on('update-downloaded', (i) => { set({ status: 'ready', version: i?.version ?? state.version, at: null }); armAutoInstall(); });
  autoUpdater.on('error', (e) => set({ status: 'error', error: String(e?.message ?? e).slice(0, 300) }));

  const check = async () => {
    if (settings?.get?.().autoUpdate === false) return { ...state };
    try { await autoUpdater.checkForUpdates(); } catch (e) { set({ status: 'error', error: String(e?.message ?? e).slice(0, 300) }); }
    return { ...state };
  };
  const first = setTimeout(check, firstCheckMs); first.unref?.();
  const timer = setInterval(check, CHECK_EVERY); timer.unref?.();

  return {
    status: () => ({ ...state }),
    check,
    /** Quit and install a downloaded update now ("Restart to update" / "Update now"). */
    install() { if (state.status !== 'ready' && state.status !== 'installing') return false; doInstall(); return true; },
    /** Stop the automatic install of this version (it is still installed when the app is closed, or on "Restart to update"). */
    cancel() { if (state.status !== 'installing') return false; stopTimers(); declined = state.version; set({ status: 'ready', at: null }); return true; },
    dispose() { stopTimers(); clearTimeout(first); clearInterval(timer); },
  };
}
