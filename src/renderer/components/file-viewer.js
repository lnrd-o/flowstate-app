// Shared file viewer (Files tab + Preview tab): toolbar + markdown / code / image / html / binary rendering.
import { h, icon } from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import { renderMarkdown, buildCodeBlock, attachLinkHandler } from '../lib/markdown.js';
import { formatBytes, baseName } from '../lib/files.js';
import { toast } from './modal.js';

export function createFileViewer({ api, emptyIcon = 'file', emptyTitle, emptyText }) {
  let projectId = null;
  let rel = null;
  let token = 0;
  let lastKey = '';

  const name = h('span', { class: 'fv__name mono truncate' });
  const meta = h('span', { class: 'fv__meta faint small shrink-0' });
  const btn = (ic, key, fn) => {
    const b = h('button', { class: 'btn btn--sm', type: 'button', attrs: { 'data-i18n-key': key } }, icon(ic), h('span', { class: 'fv__btn-text' }));
    b.addEventListener('click', fn);
    return b;
  };
  const revealBtn = btn('folder', 'files.reveal', () => act('reveal'));
  const openBtn = btn('external', 'files.open', () => act('open'));
  const refreshBtn = btn('refresh', 'artifacts.refresh', () => load(true));
  const bar = h('div', { class: 'fv__bar' }, h('div', { class: 'fv__title row' }, name, meta), h('div', { class: 'fv__actions row wrap gap-1' }, revealBtn, openBtn, refreshBtn));
  const content = h('div', { class: 'fv__content' });
  const el = h('div', { class: 'fv' }, bar, content);
  attachLinkHandler(content);

  function labels() {
    for (const b of el.querySelectorAll('[data-i18n-key]')) b.querySelector('.fv__btn-text').textContent = t(b.getAttribute('data-i18n-key'));
    revealBtn.title = t('files.revealTitle');
    openBtn.title = t('files.openTitle');
  }

  async function act(kind) {
    if (!projectId || !rel) return;
    try { await api.files[kind](projectId, rel); } catch (e) { toast((e && e.message) || t('errors.generic'), 'error'); }
  }

  function renderEmpty() {
    bar.hidden = true;
    content.replaceChildren(h('div', { class: 'empty-state' },
      h('div', { class: 'empty-state__icon' }, icon(emptyIcon, 'icon--lg')),
      h('div', { class: 'empty-state__title', text: emptyTitle ? emptyTitle() : t('artifacts.empty') }),
      h('div', { class: 'empty-state__text', text: emptyText ? emptyText() : t('artifacts.emptyText') })));
  }

  function body(res) {
    const wrap = h('div', { class: 'fv__body' });
    if (res.truncated) wrap.append(h('div', { class: 'fv__note', attrs: { role: 'status' } }, icon('alert'), t('files.truncated', { size: formatBytes(res.size) })));
    if (res.kind === 'markdown') {
      wrap.append(h('div', { class: 'md fv__md' }, renderMarkdown(res.content || '')));
    } else if (res.kind === 'text') {
      wrap.append(h('div', { class: 'fv__code' }, buildCodeBlock(res.content || '', res.lang || 'plaintext', { lineNumbers: true })));
    } else if (res.kind === 'image') {
      wrap.append(h('div', { class: 'fv__image' }, h('img', { src: res.dataUrl, alt: baseName(rel) })));
    } else if (res.kind === 'html') {
      wrap.append(
        h('div', { class: 'fv__note fv__note--info' }, icon('shield'), h('span', { text: t('files.htmlHint') }),
          h('button', { class: 'btn btn--sm', type: 'button', on: { click: () => act('open') } }, icon('external'), t('files.openBrowser'))),
        h('iframe', { class: 'fv__frame', title: baseName(rel), sandbox: '', srcdoc: res.content || '' }));
    } else {
      wrap.append(h('div', { class: 'empty-state' },
        h('div', { class: 'empty-state__icon' }, icon('file', 'icon--lg')),
        h('div', { class: 'empty-state__title', text: t('files.binary') }),
        h('div', { class: 'empty-state__text', text: formatBytes(res.size) + ' - ' + t('files.binaryText') })));
    }
    return wrap;
  }

  async function load(force) {
    if (!projectId || !rel) { lastKey = ''; renderEmpty(); return; }
    const my = ++token;
    bar.hidden = false;
    name.textContent = rel;
    name.title = rel;
    meta.textContent = '';
    if (force || lastKey !== projectId + ':' + rel) content.replaceChildren(h('div', { class: 'row muted fv__loading' }, h('span', { class: 'spinner' }), t('common.loading')));
    lastKey = projectId + ':' + rel;
    labels();
    let res;
    try { res = await api.files.read(projectId, rel); } catch (e) {
      if (my !== token) return;
      content.replaceChildren(h('div', { class: 'fv__note', attrs: { role: 'alert' } }, icon('alert'), (e && e.message) || t('files.readFailed')));
      return;
    }
    if (my !== token) return;
    meta.textContent = formatBytes(res.size);
    content.replaceChildren(body(res));
    content.scrollTop = 0;
  }

  renderEmpty();
  return {
    el,
    show(pid, relPath) {
      if (pid === projectId && relPath === rel) return;
      projectId = pid; rel = relPath || null; load(false);
    },
    clear() { projectId = null; rel = null; token++; renderEmpty(); },
    refresh() { return load(false); },
    update() { labels(); if (!rel) renderEmpty(); else { lastKey = ''; load(false); } },
    current: () => rel,
    projectId: () => projectId,
  };
}
