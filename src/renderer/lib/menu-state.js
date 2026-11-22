// Pure parts of the in-window menu bar: model -> view model, accelerator formatting/matching, key handling. No DOM.
// The model comes from menu.model() (src/shared/menu.js MENU with the dynamic Open Recent submenu filled in).

const isMac = (platform) => platform === 'darwin';

/** 'CmdOrCtrl+Shift+Z' -> 'Ctrl+Shift+Z' (Cmd on macOS); 'CmdOrCtrl+Plus' -> 'Ctrl++'. */
export function acceleratorLabel(acc, platform) {
  if (!acc) return '';
  return String(acc).split('+').map((p) => {
    if (p === 'CmdOrCtrl' || p === 'CommandOrControl') return isMac(platform) ? 'Cmd' : 'Ctrl';
    if (p === 'Plus') return '+';
    return p;
  }).join('+');
}

/** 'Ctrl+Shift+Z' -> ['Ctrl','Shift','Z'];  'Ctrl++' -> ['Ctrl','+'] (for rendering one <kbd> per key). */
export function accelKeys(label) {
  const l = String(label || '');
  if (!l) return [];
  if (l.endsWith('++')) return [...l.slice(0, -2).split('+').filter(Boolean), '+'];
  return l.split('+');
}

/** Does a KeyboardEvent-like {key, ctrlKey, metaKey, shiftKey, altKey} trigger an Electron accelerator? */
export function acceleratorMatches(e, acc, platform) {
  if (!acc || !e || !e.key) return false;
  const parts = String(acc).split('+');
  const last = parts[parts.length - 1] === '' ? '+' : parts[parts.length - 1];
  const mods = parts.slice(0, parts.length - (parts[parts.length - 1] === '' ? 2 : 1));
  const wantMod = mods.some((m) => m === 'CmdOrCtrl' || m === 'CommandOrControl' || m === 'Ctrl' || m === 'Control' || m === 'Cmd' || m === 'Command');
  const hasMod = isMac(platform) ? e.metaKey : e.ctrlKey;
  if (wantMod !== !!hasMod) return false;
  if (mods.includes('Alt') !== !!e.altKey) return false;
  const key = String(e.key);
  if (last === 'Plus' || last === '+') return key === '+' || key === '=';
  if (last === '-') return key === '-' || key === '_';
  if (!(mods.includes('Shift') === !!e.shiftKey)) return false;
  return key.toLowerCase() === last.toLowerCase();
}

/** Label text: 'menu.*' keys are translated, anything else (a project name in Open Recent) is shown as is. */
export function labelOf(item, translate) {
  const l = String(item.label || '');
  if (item.literal) return l;
  return /^menu\.[A-Za-z]+$/.test(l) ? translate(l) : l;
}

function cleanSeparators(list) {
  const out = [];
  for (const it of list) {
    if (it.kind === 'separator' && (!out.length || out[out.length - 1].kind === 'separator')) continue;
    out.push(it);
  }
  while (out.length && out[out.length - 1].kind === 'separator') out.pop();
  return out;
}

function viewItems(items, ctx) {
  const out = [];
  for (const it of items) {
    if (it.type === 'separator') { out.push({ kind: 'separator' }); continue; }
    if (it.devOnly && ctx.packaged !== false) continue;
    const label = labelOf(it, ctx.t);
    const accel = acceleratorLabel(it.accelerator, ctx.platform);
    if (it.submenu) {
      let children = viewItems(it.submenu, ctx);
      if (it.dynamic === 'recent' && (!children.length || it.enabled === false)) children = [{ kind: 'item', id: 'file.recent.none', label: ctx.t('menu.noRecent'), accel: '', disabled: true }];
      out.push({ kind: 'submenu', id: it.id, label, accel: '', items: children, disabled: !children.some((c) => c.kind !== 'separator' && !c.disabled) });
      continue;
    }
    const base = { id: it.id, label, accel, handler: it.handler || 'renderer', role: it.role || null, disabled: !!it.disabled, url: it.url || null };
    if (it.type === 'checkbox') {
      const checked = it.id === 'view.devMode' ? !!ctx.developerMode : !!it.checked;
      out.push({ ...base, kind: 'checkbox', checked });
    } else if (it.type === 'radio') {
      const checked = it.id.startsWith('view.theme.') ? ctx.theme === it.id.slice('view.theme.'.length) : !!it.checked;
      out.push({ ...base, kind: 'radio', checked });
    } else out.push({ ...base, kind: 'item' });
  }
  return cleanSeparators(out);
}

/**
 * Model -> bar view: [{ id, label, mnemonic, items:[ {kind:'item'|'checkbox'|'radio'|'submenu'|'separator', id, label, accel, checked?, disabled, items?} ] }].
 * ctx: { t, platform, developerMode, theme, packaged }.
 */
export function buildMenuView(model, ctx) {
  const items = model && Array.isArray(model.items) ? model.items : [];
  return items.filter((m) => m.submenu).map((m) => ({
    id: m.id, label: labelOf(m, ctx.t), mnemonic: MNEMONICS[m.id] || '', items: viewItems(m.submenu, ctx),
  }));
}

export const MNEMONICS = Object.freeze({ file: 'f', edit: 'e', view: 'v', help: 'h' });

/** Alt+F / E / V / H -> top menu id (null otherwise). */
export function altMnemonic(e) {
  if (!e || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || !e.key) return null;
  const k = String(e.key).toLowerCase();
  return Object.keys(MNEMONICS).find((id) => MNEMONICS[id] === k) || null;
}

/** Indexes of items that can take focus. */
export function focusableIndexes(items) {
  const out = [];
  (items || []).forEach((it, i) => { if (it.kind !== 'separator' && !it.disabled) out.push(i); });
  return out;
}

/** Next/previous focusable index, wrapping. cur = -1 starts from the edge. */
export function moveIndex(items, cur, dir) {
  const f = focusableIndexes(items);
  if (!f.length) return -1;
  const pos = f.indexOf(cur);
  if (pos < 0) return dir > 0 ? f[0] : f[f.length - 1];
  return f[(pos + dir + f.length) % f.length];
}

export function edgeIndex(items, which) {
  const f = focusableIndexes(items);
  return f.length ? (which === 'first' ? f[0] : f[f.length - 1]) : -1;
}

/** Type-ahead: the next focusable item (after cur, wrapping) whose label starts with the typed character. */
export function typeAheadIndex(items, cur, ch) {
  const c = String(ch || '').toLowerCase();
  if (c.length !== 1) return -1;
  const f = focusableIndexes(items);
  const ordered = [...f.filter((i) => i > cur), ...f.filter((i) => i <= cur)];
  return ordered.find((i) => String(items[i].label || '').toLowerCase().startsWith(c)) ?? -1;
}

/**
 * Keyboard table of the ARIA menubar pattern. level: 'bar' (a top-level button has focus), 'menu' (inside a dropdown), 'sub' (inside a submenu).
 * focusedHasSubmenu: the focused item opens a submenu. Returns an action name the component executes.
 */
export function keyAction({ level, focusedHasSubmenu = false }, key) {
  if (level === 'bar') {
    switch (key) {
      case 'ArrowRight': return 'next-menu';
      case 'ArrowLeft': return 'prev-menu';
      case 'ArrowDown': case 'Enter': case ' ': return 'open-menu';
      case 'ArrowUp': return 'open-menu-last';
      case 'Home': return 'first-menu';
      case 'End': return 'last-menu';
      case 'Escape': return 'close';
      default: return 'none';
    }
  }
  switch (key) {
    case 'ArrowDown': return 'next-item';
    case 'ArrowUp': return 'prev-item';
    case 'Home': return 'first-item';
    case 'End': return 'last-item';
    case 'ArrowRight': return focusedHasSubmenu ? 'open-sub' : level === 'menu' ? 'next-menu' : 'none';
    case 'ArrowLeft': return level === 'sub' ? 'close-sub' : 'prev-menu';
    case 'Enter': case ' ': return focusedHasSubmenu ? 'open-sub' : 'activate';
    case 'Escape': return level === 'sub' ? 'close-sub' : 'close';
    case 'Tab': return 'close-all';
    default: return key && key.length === 1 ? 'typeahead' : 'none';
  }
}

/** Shortcuts dialog data: [{ id, label, items:[{ id, label, accel }] }] for every item with an accelerator, grouped by top menu. */
export function shortcutGroups(view) {
  const flat = (items) => items.flatMap((it) => (it.kind === 'submenu' ? flat(it.items) : it.kind !== 'separator' && it.accel ? [{ id: it.id, label: it.label, accel: it.accel }] : []));
  return view.map((m) => ({ id: m.id, label: m.label, items: flat(m.items) })).filter((g) => g.items.length);
}
