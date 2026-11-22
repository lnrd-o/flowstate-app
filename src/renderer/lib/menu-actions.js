// ONE action map for every menu action the renderer handles: HTML menu bar (handler 'renderer') and the native menu's ev:menu pushes.
// Actions of handler 'main' (and role items) go to menu.invoke(id) instead (see dispatchMenu).
import { activeProject } from './store.js';
import { t } from './i18n.js';

export const THEMES = Object.freeze(['dark', 'light', 'gold']);

/**
 * createMenuActions({ store, api, actions, ui, notify }) -> { has(id), run(id), ids }
 *  ui: { titlebar:{focusSearch}, main:{composer:{openPicker}} } (filled after the shell is built)
 *  notify(message, kind): toast
 */
export function createMenuActions({ store, api, actions, ui, notify }) {
  const needProject = (fn) => (...a) => {
    const p = activeProject(store.get());
    if (!p) { notify(t('menu.noProject'), 'warn'); return false; }
    return fn(p, ...a);
  };
  const showChat = () => { if (store.get().view !== 'project') actions.setView('project'); };
  const map = {
    'file.newProject': () => actions.openWalkthrough(),
    'file.openFolder': () => actions.openFolder(),
    'file.revealProject': needProject((p) => api.files.reveal(p.id, '')),
    'file.settings': () => actions.openSettings(),
    'edit.find': () => { if (ui.titlebar) ui.titlebar.focusSearch(); },
    'edit.attachImage': needProject(() => { showChat(); if (ui.main && ui.main.composer) ui.main.composer.openPicker(); }),
    'edit.clearHistory': needProject((p) => actions.clearHistory(p.id)),
    'view.toggleSidebar': () => actions.toggleSidebar(),
    'view.toggleArtifacts': () => actions.toggleArtifacts(),
    'view.tasks': () => actions.setView('tasks'),
    'view.usage': () => actions.openUsage(),
    'view.devMode': () => actions.toggleDeveloper(),
    'help.shortcuts': () => actions.openShortcuts(),
    'help.about': () => actions.openAbout(),
  };
  for (const th of THEMES) map['view.theme.' + th] = () => actions.updateSettings({ theme: th });

  const recent = (id) => (id.startsWith('file.recent:') ? id.slice('file.recent:'.length) : null);
  return {
    ids: Object.keys(map),
    has: (id) => typeof id === 'string' && (id in map || !!recent(id)),
    /** Runs the action; resolves to false when nothing handled it. */
    async run(id) {
      const pid = typeof id === 'string' ? recent(id) : null;
      if (pid) {
        if (!store.get().projects.some((p) => p.id === pid)) { notify(t('menu.noProject'), 'warn'); return false; }
        await actions.selectProject(pid);
        return true;
      }
      const fn = map[id];
      if (!fn) return false;
      const r = await fn();
      return r !== false;
    },
  };
}

/** Route a menu item: renderer-handled ids run locally, everything else (main handlers and roles) goes to menu.invoke. */
export async function dispatchMenu(item, { api, menuActions }) {
  if (item.handler === 'renderer' && menuActions.has(item.id)) return menuActions.run(item.id);
  if (api.menu && api.menu.invoke) {
    try { const r = await api.menu.invoke(item.id); return !(r && r.ok === false); } catch { return false; }
  }
  return false;
}
