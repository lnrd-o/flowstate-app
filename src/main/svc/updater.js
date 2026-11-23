// Auto-update from GitHub Releases (electron-updater). Packaged Windows (NSIS install) and Linux (AppImage) builds only: the portable
// exe, macOS (needs a signed + notarized app) and dev runs never update themselves. Checks 20 s after start and then every 6 hours,
// downloads in the background and tells the renderer; the user picks "Restart to update". Nothing installs without that click.
import { CH } from '../../shared/ipc.js';

const CHECK_EVERY = 6 * 3600 * 1000;

export async function create({ electron, push = () => {}, settings }) {
  const app = electron?.app;
  let state = { status: 'idle', version: null, error: null, supported: false };
  const set = (patch) => { state = { ...state, ...patch }; push(CH.evUpdate, { ...state }); };

  const portable = !!process.env.PORTABLE_EXECUTABLE_DIR;
  const supported = !!app?.isPackaged && !portable && (process.platform === 'win32' || (process.platform === 'linux' && !!process.env.APPIMAGE));
  state.supported = supported;
  if (!supported) return { status: () => ({ ...state }), check: async () => ({ ...state }), install: () => false, dispose() {} };

  let autoUpdater;
  try {
    const mod = await import('electron-updater'); // CommonJS package: named export or under default
    autoUpdater = mod.autoUpdater ?? mod.default?.autoUpdater;
    if (!autoUpdater) throw new Error('electron-updater not available');
  } catch (e) {
    state = { ...state, supported: false, error: String(e?.message ?? e) };
    return { status: () => ({ ...state }), check: async () => ({ ...state }), install: () => false, dispose() {} };
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;
  autoUpdater.on('checking-for-update', () => set({ status: 'checking', error: null }));
  autoUpdater.on('update-available', (i) => set({ status: 'downloading', version: i?.version ?? null, percent: 0 }));
  autoUpdater.on('update-not-available', () => set({ status: 'current' }));
  autoUpdater.on('download-progress', (p) => set({ status: 'downloading', percent: Math.round(p?.percent ?? 0) }));
  autoUpdater.on('update-downloaded', (i) => set({ status: 'ready', version: i?.version ?? state.version }));
  autoUpdater.on('error', (e) => set({ status: 'error', error: String(e?.message ?? e).slice(0, 300) }));

  const check = async () => {
    if (settings?.get?.().autoUpdate === false) return { ...state };
    try { await autoUpdater.checkForUpdates(); } catch (e) { set({ status: 'error', error: String(e?.message ?? e).slice(0, 300) }); }
    return { ...state };
  };
  const first = setTimeout(check, 20000); first.unref?.();
  const timer = setInterval(check, CHECK_EVERY); timer.unref?.();

  return {
    status: () => ({ ...state }),
    check,
    /** Quit and install the downloaded update (only when ready). */
    install() { if (state.status !== 'ready') return false; setImmediate(() => autoUpdater.quitAndInstall(false, true)); return true; },
    dispose() { clearTimeout(first); clearInterval(timer); },
  };
}
