// Dialogs (focus trap, Esc, backdrop), confirm dialog and toasts.
import { h, icon, focusables, nextId } from '../lib/dom.js';
import { t } from '../lib/i18n.js';

const stack = [];
let listening = false;

function onKeydown(e) {
  const top = stack[stack.length - 1];
  if (!top) return;
  if (e.key === 'Escape') {
    e.stopPropagation();
    e.preventDefault();
    top.close('escape');
  } else if (e.key === 'Tab') {
    const f = focusables(top.dialog);
    if (!f.length) { e.preventDefault(); return; }
    const first = f[0];
    const last = f[f.length - 1];
    const active = document.activeElement;
    if (!top.dialog.contains(active)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  }
}

/**
 * openDialog({ title, body, footer, size, onClose, dismissible })
 * body: Node | Node[]; footer: Node[]. Returns { el, dialog, setTitle, setBody, setFooter, close }.
 */
export function openDialog({ title, body, footer, size, onClose, dismissible = true }) {
  const opener = document.activeElement;
  const titleId = nextId('dlg-title');
  const titleEl = h('h2', { class: 'dialog__title', id: titleId, text: title || '' });
  const bodyEl = h('div', { class: 'dialog__body' });
  const footerEl = h('div', { class: 'dialog__footer' });
  const closeBtn = h('button', { class: 'btn btn--ghost btn--icon btn--sm', type: 'button', attrs: { 'aria-label': t('common.close'), title: t('common.close') } }, icon('x'));
  const dialog = h('div', { class: 'dialog' + (size === 'lg' ? ' dialog--lg' : ''), attrs: { tabindex: '-1' } },
    h('div', { class: 'dialog__header' }, titleEl, dismissible ? closeBtn : null), bodyEl, footerEl);
  const backdrop = h('div', { class: 'modal__backdrop' });
  const el = h('div', { class: 'modal', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId } }, backdrop, dialog);

  const api = {
    el, dialog,
    setTitle: (s) => { titleEl.textContent = s; },
    setBody: (n) => { bodyEl.replaceChildren(...[].concat(n)); },
    setFooter: (n) => { footerEl.replaceChildren(...[].concat(n || [])); footerEl.hidden = !n || !n.length; },
    close(reason) {
      const i = stack.indexOf(api);
      if (i < 0) return;
      if (reason === 'escape' && !dismissible) return;
      stack.splice(i, 1);
      el.remove();
      if (!stack.length) { document.removeEventListener('keydown', onKeydown, true); listening = false; }
      if (opener && opener.focus && document.contains(opener)) opener.focus();
      if (onClose) onClose(reason || 'close');
    },
  };
  api.setBody(body || []);
  api.setFooter(footer || []);
  if (dismissible) {
    backdrop.addEventListener('click', () => api.close('backdrop'));
    closeBtn.addEventListener('click', () => api.close('x'));
  }
  stack.push(api);
  if (!listening) { document.addEventListener('keydown', onKeydown, true); listening = true; }
  document.body.appendChild(el);
  const first = focusables(bodyEl)[0] || focusables(footerEl)[0] || dialog;
  first.focus();
  return api;
}

/** Promise<boolean> confirm dialog. */
export function confirmDialog({ title, message, confirmLabel, danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const cancel = h('button', { class: 'btn', type: 'button', text: t('common.cancel') });
    const ok = h('button', { class: 'btn ' + (danger ? 'btn--danger' : 'btn--primary'), type: 'button', text: confirmLabel || t('common.ok') });
    const dlg = openDialog({
      title: title || t('common.ok'),
      body: h('p', { text: message || '' }),
      footer: [cancel, ok],
      onClose: () => done(false),
    });
    cancel.addEventListener('click', () => dlg.close('cancel'));
    ok.addEventListener('click', () => { done(true); dlg.close('ok'); });
    cancel.focus();
  });
}

let toastStack = null;
/** Transient status message. kind: 'success' | 'error' | 'warn' | undefined */
export function toast(message, kind) {
  if (!toastStack) {
    toastStack = h('div', { class: 'toast-stack' });
    document.body.appendChild(toastStack);
  }
  const el = h('div', { class: 'toast' + (kind ? ' toast--' + kind : ''), attrs: { role: 'status' }, text: message });
  toastStack.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}
