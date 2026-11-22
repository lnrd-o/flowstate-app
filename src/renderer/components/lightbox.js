// Image lightbox: a dialog (focus trapped, Esc closes) with the full image. `load` resolves to a data URL.
import { h } from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import { openDialog } from './modal.js';

/** openLightbox({ title, alt, load: () => Promise<dataUrl|null> }) -> dialog handle. */
export function openLightbox({ title, alt, load }) {
  const img = h('img', { class: 'lightbox__img', alt: alt || title || t('images.previewTitle'), hidden: true });
  const status = h('div', { class: 'lightbox__status muted', attrs: { role: 'status' } }, h('span', { class: 'spinner' }), t('common.loading'));
  const close = h('button', { class: 'btn btn--primary', type: 'button', text: t('images.close') });
  const dlg = openDialog({ title: title || t('images.previewTitle'), body: h('div', { class: 'lightbox' }, status, img), footer: [close], size: 'lg' });
  dlg.dialog.classList.add('dialog--image');
  close.addEventListener('click', () => dlg.close('done'));
  close.focus();
  Promise.resolve().then(load).then((url) => {
    if (typeof url === 'string' && /^data:image\//.test(url)) {
      img.src = url; img.hidden = false; status.hidden = true;
    } else {
      status.replaceChildren(t('images.loadFailed'));
    }
  }).catch(() => { status.replaceChildren(t('images.loadFailed')); });
  return dlg;
}
