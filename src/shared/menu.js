// FlowState application menu model (File / Edit / View / Help). One source of truth for:
//  - the NATIVE menu (Electron Menu: macOS menu bar, accelerators everywhere), built in main (svc/menu.js)
//  - the HTML menu bar rendered in the custom title bar on Windows/Linux (the native bar is hidden there)
//
// Item = { id, label (i18n key under 'menu.'), accelerator?, role?, handler:'main'|'renderer', type?:'separator'|'radio'|'checkbox', submenu?, dynamic? }
//  - role items map to Electron roles (undo, copy ...) and run natively; in the HTML bar they call document.execCommand / window APIs.
//  - handler 'main' actions are executed by main (menu:invoke); 'renderer' actions are pushed to the renderer as ev:menu {id}.
//  - dynamic 'recent' = submenu filled at runtime from the project registry (most recent first, max 8): ids 'file.recent:<projectId>'.
//  - 'view.theme.*' are radios; 'view.devMode' is a checkbox (state from settings.developerMode).
// The accelerator strings use Electron syntax ('CmdOrCtrl+B').

export const MENU = Object.freeze([
  { id: 'file', label: 'menu.file', submenu: [
    { id: 'file.newProject', label: 'menu.newProject', accelerator: 'CmdOrCtrl+N', handler: 'renderer' },
    { id: 'file.openFolder', label: 'menu.openFolder', accelerator: 'CmdOrCtrl+O', handler: 'renderer' },
    { id: 'file.recent', label: 'menu.openRecent', dynamic: 'recent', submenu: [] },
    { type: 'separator' },
    { id: 'file.saveState', label: 'menu.saveState', accelerator: 'CmdOrCtrl+S', handler: 'main' },
    { id: 'file.revealProject', label: 'menu.revealProject', handler: 'renderer' },
    { type: 'separator' },
    { id: 'file.settings', label: 'menu.settings', accelerator: 'CmdOrCtrl+,', handler: 'renderer' },
    { type: 'separator' },
    { id: 'file.quit', label: 'menu.quit', accelerator: 'CmdOrCtrl+Q', role: 'quit', handler: 'main' },
  ] },
  { id: 'edit', label: 'menu.edit', submenu: [
    { id: 'edit.undo', label: 'menu.undo', accelerator: 'CmdOrCtrl+Z', role: 'undo', handler: 'main' },
    { id: 'edit.redo', label: 'menu.redo', accelerator: 'CmdOrCtrl+Shift+Z', role: 'redo', handler: 'main' },
    { type: 'separator' },
    { id: 'edit.cut', label: 'menu.cut', accelerator: 'CmdOrCtrl+X', role: 'cut', handler: 'main' },
    { id: 'edit.copy', label: 'menu.copy', accelerator: 'CmdOrCtrl+C', role: 'copy', handler: 'main' },
    { id: 'edit.paste', label: 'menu.paste', accelerator: 'CmdOrCtrl+V', role: 'paste', handler: 'main' },
    { id: 'edit.selectAll', label: 'menu.selectAll', accelerator: 'CmdOrCtrl+A', role: 'selectAll', handler: 'main' },
    { type: 'separator' },
    { id: 'edit.find', label: 'menu.find', accelerator: 'CmdOrCtrl+K', handler: 'renderer' },
    { id: 'edit.attachImage', label: 'menu.attachImage', accelerator: 'CmdOrCtrl+Shift+I', handler: 'renderer' },
    { id: 'edit.clearHistory', label: 'menu.clearHistory', handler: 'renderer' },
  ] },
  { id: 'view', label: 'menu.view', submenu: [
    { id: 'view.toggleSidebar', label: 'menu.toggleSidebar', accelerator: 'CmdOrCtrl+B', handler: 'renderer' },
    { id: 'view.toggleArtifacts', label: 'menu.toggleArtifacts', accelerator: 'CmdOrCtrl+J', handler: 'renderer' },
    { type: 'separator' },
    { id: 'view.tasks', label: 'menu.tasks', accelerator: 'CmdOrCtrl+Shift+T', handler: 'renderer' },
    { id: 'view.usage', label: 'menu.usage', accelerator: 'CmdOrCtrl+Shift+U', handler: 'renderer' },
    { type: 'separator' },
    { id: 'view.devMode', label: 'menu.devMode', type: 'checkbox', accelerator: 'CmdOrCtrl+Shift+D', handler: 'renderer' },
    { id: 'view.theme', label: 'menu.theme', submenu: [
      { id: 'view.theme.dark', label: 'menu.themeDark', type: 'radio', handler: 'renderer' },
      { id: 'view.theme.light', label: 'menu.themeLight', type: 'radio', handler: 'renderer' },
      { id: 'view.theme.gold', label: 'menu.themeGold', type: 'radio', handler: 'renderer' },
    ] },
    { type: 'separator' },
    { id: 'view.zoomIn', label: 'menu.zoomIn', accelerator: 'CmdOrCtrl+Plus', role: 'zoomIn', handler: 'main' },
    { id: 'view.zoomOut', label: 'menu.zoomOut', accelerator: 'CmdOrCtrl+-', role: 'zoomOut', handler: 'main' },
    { id: 'view.zoomReset', label: 'menu.zoomReset', accelerator: 'CmdOrCtrl+0', role: 'resetZoom', handler: 'main' },
    { id: 'view.fullscreen', label: 'menu.fullscreen', accelerator: 'F11', role: 'togglefullscreen', handler: 'main' },
    { id: 'view.devtools', label: 'menu.devtools', accelerator: 'CmdOrCtrl+Shift+J', role: 'toggleDevTools', handler: 'main', devOnly: true },
  ] },
  { id: 'help', label: 'menu.help', submenu: [
    { id: 'help.shortcuts', label: 'menu.shortcuts', accelerator: 'CmdOrCtrl+/', handler: 'renderer' },
    { id: 'help.docs', label: 'menu.docs', handler: 'main', url: 'https://github.com/lnrd-o/flowstate-app#readme' },
    { id: 'help.releases', label: 'menu.releases', handler: 'main', url: 'https://github.com/lnrd-o/flowstate-app/releases' },
    { id: 'help.report', label: 'menu.report', handler: 'main', url: 'https://github.com/lnrd-o/flowstate-app/issues/new' },
    { type: 'separator' },
    { id: 'help.about', label: 'menu.about', handler: 'renderer' },
  ] },
]);

/** Flatten to every actionable item (no separators), with its parent path. */
export function flattenMenu(items = MENU, path = []) {
  const out = [];
  for (const it of items) {
    if (it.type === 'separator') continue;
    if (it.submenu) out.push(...flattenMenu(it.submenu, [...path, it.id]));
    else out.push({ ...it, path });
  }
  return out;
}

export const MENU_ACTION_IDS = Object.freeze(new Set(flattenMenu().map((i) => i.id)));
export const MENU_ID_RE = /^[a-z][A-Za-z0-9.]{0,63}(?::[A-Za-z0-9-]{1,64})?$/; // ids, plus 'file.recent:<projectId>'

/** Is `id` a valid action id (static ids or a recent-project entry)? */
export function isMenuAction(id) {
  return typeof id === 'string' && MENU_ID_RE.test(id) && (MENU_ACTION_IDS.has(id) || id.startsWith('file.recent:'));
}
