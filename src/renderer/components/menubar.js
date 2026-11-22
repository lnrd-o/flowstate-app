// HTML menu bar for the custom title bar (Windows / Linux; macOS keeps the native bar). ARIA menubar pattern:
// role=menubar > menuitem (File Edit View Help) > role=menu > menuitem | menuitemcheckbox | menuitemradio (+ one level of submenu: Open Recent).
// Model: menu.model() (src/shared/menu.js). Pure parts (view model, key table, accelerators) live in lib/menu-state.js.
import { h, icon } from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import { isDev } from '../lib/store.js';
import { buildMenuView, altMnemonic, edgeIndex, keyAction, moveIndex, typeAheadIndex } from '../lib/menu-state.js';

export function mountMenubar(host, { store, api, menuDispatch }) {
  const bar = h('div', { class: 'mb', attrs: { role: 'menubar' } });
  host.append(bar);
  let model = null;
  let view = [];
  let openIdx = -1;
  let subItem = null; // id of the open submenu item
  let barFocus = 0; // roving tabindex of the top level
  let prevFocus = null;
  let tops = []; // [{ btn, wrap, menu|null }]
  let rows = []; // rows of the open dropdown: [{ it, el }]
  let subRows = []; // rows of the open submenu

  const ctx = () => {
    const s = store.get();
    return { t, platform: s.win.platform, developerMode: isDev(s), theme: s.settings.theme, packaged: model && model.state ? model.state.packaged : true };
  };

  function rebuildView() {
    view = buildMenuView(model || { items: [] }, ctx());
  }

  function itemEl(it, onSub) {
    if (it.kind === 'separator') return { el: h('div', { class: 'mb__sep', attrs: { role: 'separator' } }) };
    const role = it.kind === 'checkbox' ? 'menuitemcheckbox' : it.kind === 'radio' ? 'menuitemradio' : 'menuitem';
    const mark = it.kind === 'checkbox' ? (it.checked ? '\u2713' : '') : it.kind === 'radio' ? (it.checked ? '\u2022' : '') : '';
    const attrs = { role, tabindex: '-1' };
    if (it.kind === 'checkbox' || it.kind === 'radio') attrs['aria-checked'] = String(!!it.checked);
    if (it.disabled) attrs['aria-disabled'] = 'true';
    if (it.kind === 'submenu') { attrs['aria-haspopup'] = 'menu'; attrs['aria-expanded'] = String(subItem === it.id); }
    const el = h('button', { class: 'mb__item' + (it.disabled ? ' is-disabled' : ''), type: 'button', attrs, dataset: { id: it.id || '' } },
      h('span', { class: 'mb__check', attrs: { 'aria-hidden': 'true' }, text: mark }),
      h('span', { class: 'mb__label truncate', text: it.label }),
      it.kind === 'submenu' ? h('span', { class: 'mb__arrow', attrs: { 'aria-hidden': 'true' } }, icon('chevron')) : h('span', { class: 'mb__accel', attrs: { 'aria-hidden': 'true' }, text: it.accel || '' }));
    if (it.kind === 'submenu') return { el, it, node: h('div', { class: 'mb__subwrap', attrs: { role: 'none' } }, el, onSub(it)) };
    return { el, it };
  }

  function menuPanel(items, isSub) {
    const panel = h('div', { class: 'mb__menu' + (isSub ? ' mb__menu--sub' : ''), attrs: { role: 'menu' } });
    const list = [];
    const subPanelHolder = {};
    for (const it of items) {
      const r = itemEl(it, (sit) => {
        const sp = menuPanel(sit.items, true);
        sp.panel.hidden = subItem !== sit.id;
        subPanelHolder[sit.id] = sp;
        return sp.panel;
      });
      panel.append(r.node || r.el);
      list.push(r);
    }
    return { panel, list, subs: subPanelHolder };
  }

  function render() {
    bar.setAttribute('aria-label', t('menu.barLabel'));
    tops = view.map((m, i) => {
      const btn = h('button', {
        class: 'mb__top' + (openIdx === i ? ' is-open' : ''), type: 'button', dataset: { menu: m.id },
        attrs: { role: 'menuitem', 'aria-haspopup': 'menu', 'aria-expanded': String(openIdx === i), tabindex: i === barFocus ? '0' : '-1' },
      }, h('span', { text: m.label }));
      const wrap = h('div', { class: 'mb__slot' }, btn);
      let menu = null;
      if (openIdx === i) {
        menu = menuPanel(m.items, false);
        wrap.append(menu.panel);
        rows = menu.list.filter((r) => r.it);
        subRows = [];
        for (const r of rows) {
          if (r.it.kind === 'submenu' && subItem === r.it.id && menu.subs[r.it.id]) subRows = menu.subs[r.it.id].list.filter((x) => x.it);
        }
        rows.forEach((r) => wire(r, false));
        subRows.forEach((r) => wire(r, true));
        for (const sp of Object.values(menu.subs)) sp.list.filter((x) => x.it).forEach((r) => wire(r, true));
      }
      btn.addEventListener('click', () => { if (openIdx === i) closeAll(true); else openMenu(i, 'none'); });
      // Hover switches menus only on a REAL pointer move (re-rendering under a still pointer fires a synthetic mouseenter).
      btn.addEventListener('mousemove', (e) => { if ((e.movementX || e.movementY) && openIdx >= 0 && openIdx !== i) openMenu(i, 'none', false); });
      btn.addEventListener('focus', () => { barFocus = i; });
      return { btn, wrap, menu };
    });
    bar.replaceChildren(...tops.map((x) => x.wrap));
  }

  function wire(r, isSub) {
    const { el, it } = r;
    if (el.dataset.wired) return;
    el.dataset.wired = '1';
    el.addEventListener('mousemove', (e) => {
      if (!(e.movementX || e.movementY) || it.disabled || document.activeElement === el) return;
      el.focus({ preventScroll: true });
      if (it.kind === 'submenu') { if (subItem !== it.id) openSub(it.id, false); } else if (!isSub && subItem) closeSub(false);
    });
    el.addEventListener('click', () => {
      if (it.disabled) return;
      if (it.kind === 'submenu') { openSub(it.id, true); return; }
      activate(it);
    });
  }

  function currentList() { return subItem && subRows.length && subRows.some((r) => r.el === document.activeElement) ? subRows : rows; }
  function focusRow(list, i) { if (i >= 0 && list[i]) list[i].el.focus({ preventScroll: true }); }

  function openMenu(i, focus, doRefresh = true) {
    if (openIdx < 0) prevFocus = document.activeElement && !host.contains(document.activeElement) ? document.activeElement : prevFocus;
    openIdx = i; barFocus = i; subItem = null;
    render();
    if (doRefresh) refreshModel();
    if (focus === 'first') focusRow(rows, edgeIndex(rows.map((r) => r.it), 'first'));
    else if (focus === 'last') focusRow(rows, edgeIndex(rows.map((r) => r.it), 'last'));
    else if (focus === 'none' && tops[i]) tops[i].btn.focus({ preventScroll: true });
    document.addEventListener('pointerdown', onDoc, true);
    window.addEventListener('blur', onBlur);
  }

  function openSub(id, focus) {
    subItem = id;
    const idx = rows.findIndex((r) => r.it.id === id);
    render();
    const parent = rows.find((r) => r.it.id === id);
    if (focus && subRows.length) focusRow(subRows, edgeIndex(subRows.map((r) => r.it), 'first'));
    else if (parent) parent.el.focus({ preventScroll: true });
    return idx;
  }

  function closeSub(refocus) {
    const id = subItem;
    subItem = null;
    render();
    if (refocus) { const parent = rows.find((r) => r.it.id === id); if (parent) parent.el.focus({ preventScroll: true }); }
  }

  function closeAll(focusTop, restore) {
    const was = openIdx;
    openIdx = -1; subItem = null; rows = []; subRows = [];
    document.removeEventListener('pointerdown', onDoc, true);
    window.removeEventListener('blur', onBlur);
    rebuildView();
    render();
    if (focusTop && tops[was]) tops[was].btn.focus();
    else if (restore && prevFocus && document.contains(prevFocus)) prevFocus.focus();
  }

  const onDoc = (e) => { if (!host.contains(e.target)) closeAll(false); };
  const onBlur = () => closeAll(false);

  async function activate(it) {
    // Roles (copy, paste ...) act on the focused field: give focus back before the call.
    closeAll(false, true);
    const item = { id: it.id, handler: it.handler, role: it.role };
    try { await (menuDispatch ? menuDispatch(item) : api.menu.invoke(it.id)); } catch { /* the action reports its own errors */ }
  }

  async function refreshModel() {
    try {
      const m = await api.menu.model();
      if (m && Array.isArray(m.items)) {
        model = m;
        rebuildView();
        if (openIdx < 0) render(); // while a menu is open the DOM (and focus) stays as it is
      }
    } catch { /* keep the previous model */ }
  }

  bar.addEventListener('keydown', (e) => {
    const active = document.activeElement;
    const inSub = subRows.some((r) => r.el === active);
    const inMenu = rows.some((r) => r.el === active);
    const level = inSub ? 'sub' : inMenu ? 'menu' : 'bar';
    const list = inSub ? subRows : rows;
    const idx = list.findIndex((r) => r.el === active);
    const focusedHasSubmenu = idx >= 0 && list[idx].it.kind === 'submenu';
    const action = keyAction({ level, focusedHasSubmenu }, e.key);
    if (action === 'none' || e.altKey || e.ctrlKey || e.metaKey) return;
    const its = list.map((r) => r.it);
    const topIdx = level === 'bar' ? tops.findIndex((x) => x.btn === active) : openIdx;
    const n = view.length;
    e.preventDefault();
    e.stopPropagation();
    switch (action) {
      case 'next-menu': case 'prev-menu': {
        const to = (topIdx + (action === 'next-menu' ? 1 : n - 1)) % n;
        if (openIdx >= 0) openMenu(to, 'first'); else { barFocus = to; tops[to].btn.focus(); tops.forEach((x, i) => { x.btn.tabIndex = i === to ? 0 : -1; }); }
        break;
      }
      case 'first-menu': case 'last-menu': { const to = action === 'first-menu' ? 0 : n - 1; barFocus = to; tops[to].btn.focus(); break; }
      case 'open-menu': openMenu(topIdx, 'first'); break;
      case 'open-menu-last': openMenu(topIdx, 'last'); break;
      case 'next-item': focusRow(list, moveIndex(its, idx, 1)); break;
      case 'prev-item': focusRow(list, moveIndex(its, idx, -1)); break;
      case 'first-item': focusRow(list, edgeIndex(its, 'first')); break;
      case 'last-item': focusRow(list, edgeIndex(its, 'last')); break;
      case 'open-sub': openSub(list[idx].it.id, true); break;
      case 'close-sub': closeSub(true); break;
      case 'close': closeAll(true); break;
      case 'close-all': closeAll(false); break;
      case 'activate': if (idx >= 0) activate(list[idx].it); break;
      case 'typeahead': focusRow(list, typeAheadIndex(its, idx, e.key)); break;
      default: break;
    }
  });

  // Alt+F / E / V / H open the matching menu from anywhere.
  document.addEventListener('keydown', (e) => {
    const id = altMnemonic(e);
    if (!id) return;
    const i = view.findIndex((m) => m.id === id);
    if (i < 0) return;
    e.preventDefault();
    openMenu(i, 'first');
  });

  store.subscribe((s, prev) => {
    if (openIdx >= 0) return;
    if (s.settings.theme !== prev.settings.theme || s.settings.developerMode !== prev.settings.developerMode || s.projects !== prev.projects || s.activeProjectId !== prev.activeProjectId) {
      rebuildView();
      render();
    }
  });

  rebuildView();
  render();
  refreshModel();
  return {
    update() { rebuildView(); render(); },
    isOpen: () => openIdx >= 0,
    close: () => closeAll(false),
    openByIndex: (i) => openMenu(i, 'first'),
  };
}
