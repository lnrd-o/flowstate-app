// Image attachments for the composer: paste, drag and drop, file picker, thumbnail strip with progress and remove buttons.
// Files are read with FileReader (data: URLs only: the CSP has no blob:), validated by lib/images.js and uploaded with attachments.save.
import { h, icon } from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import { IMAGE_ACCEPT, MAX_IMAGES, MAX_IMAGE_BYTES, parseDataUrl, pastedName, validateBatch } from '../lib/images.js';
import { openLightbox } from './lightbox.js';

/**
 * createAttachments({ api, getProjectId, notify, onChange }) -> controller
 *  getProjectId(): active project id; notify(message, kind): toast; onChange(): the composer repaints (send button, chips).
 */
export function createAttachments({ api, getProjectId, notify, onChange }) {
  const byProject = new Map(); // projectId -> [{ key, name, mime, size, thumb, status:'reading'|'uploading'|'done'|'error', progress, rel, error }]
  let seq = 0;
  let dragDepth = 0;

  const strip = h('div', { class: 'att-strip', hidden: true, attrs: { role: 'list' } });
  const input = h('input', { type: 'file', accept: IMAGE_ACCEPT, multiple: true, class: 'att-input', attrs: { tabindex: '-1', 'aria-hidden': 'true' } });
  const overlayTitle = h('div', { class: 'drop-overlay__title' });
  const overlayText = h('div', { class: 'drop-overlay__text' });
  const overlay = h('div', { class: 'drop-overlay', hidden: true, attrs: { 'aria-hidden': 'true' } }, icon('upload', 'icon--lg'), overlayTitle, overlayText);
  const announce = h('div', { class: 'sr-only', attrs: { role: 'status' } });

  const list = (pid) => byProject.get(pid) || [];
  const cur = () => list(getProjectId());
  const changed = () => { paint(); if (onChange) onChange(); };

  function paint() {
    const items = cur();
    strip.hidden = !items.length;
    strip.setAttribute('aria-label', t('images.strip'));
    strip.replaceChildren(...items.map((it, i) => {
      const imgEl = h('img', { class: 'att__img', src: it.thumb || '', alt: t('images.alt', { n: i + 1, name: it.name }), draggable: false });
      const open = h('button', {
        class: 'att__open', type: 'button', disabled: !it.thumb,
        attrs: { 'aria-label': t('images.alt', { n: i + 1, name: it.name }), title: it.name },
        on: { click: () => openLightbox({ title: it.name, alt: t('images.alt', { n: i + 1, name: it.name }), load: async () => it.thumb }) },
      }, imgEl);
      const rm = h('button', {
        class: 'att__remove', type: 'button', attrs: { 'aria-label': t('images.remove', { name: it.name }), title: t('images.remove', { name: it.name }) },
        on: { click: () => remove(it.key) },
      }, icon('x'));
      const busy = it.status === 'reading' || it.status === 'uploading';
      const bar = busy ? h('div', {
        class: 'att__progress progress', attrs: { role: 'progressbar', 'aria-label': t('images.uploading', { name: it.name }), 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(it.progress || 0)) },
      }, h('div', { class: 'progress__bar', style: 'width:' + Math.round(it.progress || 0) + '%' })) : null;
      const err = it.status === 'error' ? h('div', { class: 'att__error', title: it.error || '', attrs: { role: 'img', 'aria-label': t('images.failed', { name: it.name }) } }, icon('alert')) : null;
      return h('div', { class: 'att att--' + it.status, attrs: { role: 'listitem' }, dataset: { key: it.key } }, open, rm, bar, err);
    }));
  }

  function remove(key) {
    const pid = getProjectId();
    byProject.set(pid, list(pid).filter((x) => x.key !== key));
    changed();
  }

  function update(pid, key, patch) {
    const items = list(pid);
    const i = items.findIndex((x) => x.key === key);
    if (i < 0) return;
    items[i] = { ...items[i], ...patch };
    byProject.set(pid, items.slice());
    if (pid === getProjectId()) changed();
  }

  function readFile(file, pid, key) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onprogress = (e) => { if (e.lengthComputable) update(pid, key, { progress: (e.loaded / e.total) * 45 }); };
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(new Error('read'));
      r.readAsDataURL(file);
    });
  }

  async function upload(file, pid, key) {
    try {
      const url = await readFile(file, pid, key);
      const parsed = parseDataUrl(url);
      if (!parsed) throw new Error('read');
      update(pid, key, { thumb: url, status: 'uploading', progress: 55 });
      const att = await api.attachments.save(pid, { name: file.name, mime: parsed.mime, dataBase64: parsed.base64 });
      if (!att || !att.rel) throw new Error('save');
      update(pid, key, { status: 'done', progress: 100, rel: att.rel });
    } catch (e) {
      update(pid, key, { status: 'error', error: (e && e.message) || '' });
      notify(t('images.failed', { name: file.name }), 'error');
    }
  }

  /** Validate, show thumbnails and upload. opts.pasted names clipboard images. */
  function addFiles(files, opts) {
    const pid = getProjectId();
    if (!pid || !api.attachments || !api.attachments.save) return;
    const incoming = Array.from(files || []);
    const { accepted, errors } = validateBatch(incoming, list(pid).length);
    for (const e of errors.slice(0, 3)) notify(t(e.key, e.vars), 'warn', 6000);
    if (errors.length > 3) notify(t('images.err.count', { name: '+' + (errors.length - 3), max: MAX_IMAGES }), 'warn', 6000);
    let n = 0;
    for (const file of accepted) {
      n += 1;
      const key = 'a' + (++seq);
      const name = opts && opts.pasted ? pastedName(file.type, n) : file.name || 'image';
      byProject.set(pid, [...list(pid), { key, name, mime: file.type, size: file.size, thumb: '', status: 'reading', progress: 2, rel: null }]);
      const named = name === file.name ? file : new File([file], name, { type: file.type });
      upload(named, pid, key);
    }
    if (accepted.length) changed();
  }

  /** Clipboard images (Ctrl+V). Returns true when it consumed the paste (an image and no text). */
  function handlePaste(e) {
    const cd = e.clipboardData;
    if (!cd || !cd.items) return false;
    const files = [];
    for (const it of cd.items) if (it.kind === 'file' && /^image\//i.test(it.type)) { const f = it.getAsFile(); if (f) files.push(f); }
    if (!files.length) return false;
    addFiles(files, { pasted: true });
    return !cd.getData('text/plain');
  }

  input.addEventListener('change', () => { addFiles(input.files); input.value = ''; });

  const hasFiles = (e) => !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  /** Drop zone: overlay over `target` (chat + composer). A document-level guard stops the window from navigating to a dropped file. */
  function bindDrop(target) {
    target.append(overlay, announce);
    const show = (on) => {
      overlay.hidden = !on;
      announce.textContent = on ? t('images.dropAnnounce') : '';
    };
    target.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth += 1; show(true); });
    target.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    target.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) show(false); });
    target.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); dragDepth = 0; show(false);
      addFiles(e.dataTransfer.files);
    });
    for (const ev of ['dragover', 'drop']) document.addEventListener(ev, (e) => { if (hasFiles(e) && !target.contains(e.target)) e.preventDefault(); });
    document.addEventListener('dragend', () => { dragDepth = 0; show(false); });
  }

  function label() {
    overlayTitle.textContent = t('images.dropTitle');
    overlayText.textContent = t('images.dropText', { max: Math.round(MAX_IMAGE_BYTES / 1048576), count: MAX_IMAGES });
  }
  label();

  return {
    strip, input, addFiles, handlePaste, bindDrop, relabel() { label(); paint(); },
    pick() { input.click(); },
    repaint: paint,
    count: (pid) => list(pid).length,
    busy: (pid) => list(pid).some((x) => x.status === 'reading' || x.status === 'uploading'),
    /** [{ rel }] of the attachments that finished uploading (what agent.send expects). */
    refs: (pid) => list(pid).filter((x) => x.status === 'done' && x.rel).map((x) => ({ rel: x.rel })),
    /** Thumbnails by rel for the optimistic user bubble. */
    thumbs: (pid) => new Map(list(pid).filter((x) => x.rel && x.thumb).map((x) => [x.rel, x.thumb])),
    clear(pid) { byProject.set(pid, []); if (pid === getProjectId()) changed(); },
  };
}
