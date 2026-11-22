// Application menu: one model (src/shared/menu.js) drives the NATIVE menu (accelerators on every platform, menu bar on macOS) and the
// HTML bar in the custom title bar (menu:model / menu:invoke). 'renderer' handlers are pushed as ev:menu {id}; 'main' handlers run here.
import { MENU, flattenMenu } from '../../shared/menu.js';
import { CH } from '../../shared/ipc.js';
import { labelFor } from './menu-labels.js';

export const MAX_RECENT = 8;
const SAFE_URL = /^https:\/\/github\.com\/lnrd-o\/flowstate-app(?:[/#?][^\s]*)?$/;
export const isSafeMenuUrl = (u) => typeof u === 'string' && SAFE_URL.test(u);

/** Most recent first, max 8. */
export function recentItems(projectList) {
  return [...projectList]
    .sort((a, b) => String(b.lastOpened ?? '').localeCompare(String(a.lastOpened ?? '')))
    .slice(0, MAX_RECENT)
    .map((p) => ({ id: `file.recent:${p.id}`, label: p.name, literal: true, handler: 'renderer' }));
}

/** Clone MENU, drop devOnly items when packaged, fill the dynamic 'recent' submenu. */
export function buildModel({ projects = [], settings = {}, platform = process.platform, packaged = false } = {}) {
  const fill = (items) => items
    .filter((it) => !(it.devOnly && packaged))
    .map((it) => {
      const out = { ...it };
      if (it.submenu) out.submenu = it.dynamic === 'recent' ? recentItems(projects) : fill(it.submenu);
      if (it.dynamic === 'recent') out.enabled = out.submenu.length > 0;
      return out;
    });
  return {
    items: fill(MENU),
    state: { developerMode: settings.developerMode !== false, theme: settings.theme ?? 'dark', platform, packaged: !!packaged },
  };
}

/** Electron template from the model. onClick(item) is called for every actionable item. Labels in `lang`. */
export function buildTemplate(model, { lang = 'en', platform = process.platform, onClick = () => {} } = {}) {
  const t = (k) => labelFor(lang, k);
  const conv = (it) => {
    if (it.type === 'separator') return { type: 'separator' };
    if (it.submenu) {
      const sub = it.submenu.map(conv).filter(Boolean);
      if (it.dynamic === 'recent') {
        return { label: t(it.label), submenu: sub.length ? sub : [{ label: t('menu.noRecent'), enabled: false }] };
      }
      return { label: t(it.label), submenu: sub };
    }
    if (platform === 'darwin' && it.id === 'file.quit') return null; // the standard app menu already has Quit
    const label = it.literal ? it.label : t(it.label);
    const o = { label };
    if (it.accelerator) o.accelerator = it.accelerator;
    if (it.role && it.id !== 'file.quit') { o.role = it.role; return o; } // native role: Electron runs it
    if (it.type === 'radio' || it.type === 'checkbox') {
      o.type = it.type;
      if (it.id === 'view.devMode') o.checked = model.state.developerMode;
      else if (it.id.startsWith('view.theme.')) o.checked = model.state.theme === it.id.slice('view.theme.'.length);
    }
    o.click = () => onClick(it);
    return o;
  };
  const tpl = model.items.map(conv).filter(Boolean);
  return platform === 'darwin' ? [{ role: 'appMenu' }, ...tpl] : tpl;
}

export function createMenu({
  app, Menu, shell, getWindow = () => null, settings, projects, services = {}, push = () => {}, platform = process.platform,
  pollMs = 2000, setIntervalFn = setInterval, clearIntervalFn = clearInterval,
} = {}) {
  const packaged = !!app?.isPackaged;
  const model = () => buildModel({ projects: projects.list(), settings: settings.get(), platform, packaged });
  let sig = '';
  let timer = null;

  const wc = () => { const w = getWindow(); return w && !w.isDestroyed?.() ? w : null; };

  /** Run a handler:'main' action. -> {ok} (renderer-handled ids return {ok:false}). */
  function runMain(item) {
    const w = wc();
    const c = w?.webContents;
    switch (item.id) {
      case 'file.saveState': services.store?.saveAll?.(); return { ok: true };
      case 'file.quit': app.quit(); return { ok: true };
      case 'edit.undo': c?.undo(); return { ok: !!c };
      case 'edit.redo': c?.redo(); return { ok: !!c };
      case 'edit.cut': c?.cut(); return { ok: !!c };
      case 'edit.copy': c?.copy(); return { ok: !!c };
      case 'edit.paste': c?.paste(); return { ok: !!c };
      case 'edit.selectAll': c?.selectAll(); return { ok: !!c };
      case 'view.zoomIn': c?.setZoomLevel(Math.min(5, c.getZoomLevel() + 0.5)); return { ok: !!c };
      case 'view.zoomOut': c?.setZoomLevel(Math.max(-3, c.getZoomLevel() - 0.5)); return { ok: !!c };
      case 'view.zoomReset': c?.setZoomLevel(0); return { ok: !!c };
      case 'view.fullscreen': w?.setFullScreen(!w.isFullScreen()); return { ok: !!w };
      case 'view.devtools': if (packaged) return { ok: false }; c?.toggleDevTools(); return { ok: !!c };
      default:
        if (item.url) {
          if (!isSafeMenuUrl(item.url)) return { ok: false };
          shell?.openExternal(item.url);
          return { ok: true };
        }
        return { ok: false };
    }
  }

  function invoke(id) {
    if (typeof id !== 'string') return { ok: false };
    const item = flattenMenu(model().items).find((i) => i.id === id);
    if (!item || item.handler !== 'main') return { ok: false };
    return runMain(item);
  }

  function onNativeClick(item) {
    if (item.handler === 'main') { runMain(item); return; }
    const w = wc();
    if (w && !w.isVisible?.()) w.show();
    push(CH.evMenu, { id: item.id });
  }

  function apply() {
    if (!Menu) return;
    const s = settings.get();
    const m = model();
    const key = JSON.stringify([s.language, s.theme, s.developerMode, m.items[0].submenu.find((x) => x.dynamic === 'recent')?.submenu.map((r) => [r.id, r.label])]);
    if (key === sig) return;
    sig = key;
    try {
      Menu.setApplicationMenu(Menu.buildFromTemplate(buildTemplate(m, { lang: s.language, platform, onClick: onNativeClick })));
    } catch { /* menu is best effort */ }
  }

  apply();
  timer = setIntervalFn(apply, pollMs);
  timer?.unref?.();

  return { model, invoke, apply, dispose() { if (timer) clearIntervalFn(timer); timer = null; } };
}

export function create(deps) {
  return createMenu({
    app: deps.electron.app, Menu: deps.electron.Menu, shell: deps.electron.shell, getWindow: deps.getWindow,
    settings: deps.settings, projects: deps.projects, services: deps.services, push: deps.push,
  });
}
