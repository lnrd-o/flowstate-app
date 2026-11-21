// Small popup menu anchored to an element. Focus managed: first item focused, arrows/Home/End, Esc, Tab and outside click close.
import { h } from '../lib/dom.js';

let current = null;

export function closeMenu() {
  if (current) current.close();
}

/**
 * openMenu(anchor, items, { label })
 * items: [{ label, onClick, danger, disabled, checked (bool -> menuitemradio/checkbox), role, heading, sep }]
 */
export function openMenu(anchor, items, opts = {}) {
  closeMenu();
  const menu = h('div', { class: 'menu app-menu', attrs: { role: 'menu', 'aria-label': opts.label || null } });
  const buttons = [];
  for (const it of items) {
    if (it.sep) { menu.append(h('div', { class: 'menu__sep', attrs: { role: 'separator' } })); continue; }
    if (it.heading) { menu.append(h('div', { class: 'menu__heading', attrs: { role: 'presentation' }, text: it.heading })); continue; }
    const role = it.checked === undefined ? 'menuitem' : (it.role || 'menuitemradio');
    const btn = h('button', {
      class: 'menu__item' + (it.danger ? ' menu__item--danger' : ''), type: 'button', disabled: !!it.disabled,
      attrs: { role, tabindex: '-1', ...(it.checked === undefined ? {} : { 'aria-checked': String(!!it.checked) }) },
    },
    h('span', { class: 'menu__check', attrs: { 'aria-hidden': 'true' }, text: it.checked ? '\u2713' : '' }),
    h('span', { class: 'truncate', text: it.label }));
    btn.addEventListener('click', () => { api.close(); it.onClick && it.onClick(); });
    menu.append(btn);
    if (!it.disabled) buttons.push(btn);
  }
  const opener = document.activeElement;
  const onDoc = (e) => { if (!menu.contains(e.target) && !anchor.contains(e.target)) api.close(false); };
  const onKey = (e) => {
    const i = buttons.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); api.close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); buttons[(i + 1) % buttons.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); buttons[(i - 1 + buttons.length) % buttons.length].focus(); }
    else if (e.key === 'Home') { e.preventDefault(); buttons[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); buttons[buttons.length - 1].focus(); }
    else if (e.key === 'Tab') api.close();
  };
  const api = {
    close(restore = true) {
      if (current !== api) return;
      current = null;
      document.removeEventListener('pointerdown', onDoc, true);
      menu.removeEventListener('keydown', onKey);
      menu.remove();
      anchor.setAttribute('aria-expanded', 'false');
      if (restore && opener && document.contains(opener)) opener.focus();
    },
  };
  current = api;
  anchor.setAttribute('aria-expanded', 'true');
  menu.style.position = 'fixed';
  menu.style.visibility = 'hidden';
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  let left = opts.align === 'left' ? r.left : r.right - mw;
  left = Math.max(8, Math.min(left, window.innerWidth - mw - 8));
  let top = r.bottom + 4;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4);
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
  menu.style.visibility = '';
  document.addEventListener('pointerdown', onDoc, true);
  menu.addEventListener('keydown', onKey);
  const first = buttons.find((b) => b.getAttribute('aria-checked') === 'true') || buttons[0];
  if (first) first.focus();
  return api;
}
