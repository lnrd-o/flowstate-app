// Renders typed previews from api.files.preview (csv/xlsx tables, pptx slide cards, docx text, archives, pdf, generic fallback).
import { h, icon } from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import { renderMarkdown, buildCodeBlock } from '../lib/markdown.js';
import { formatBytes } from '../lib/files.js';

const note = (text, ic = 'alert') => h('div', { class: 'fv__note', attrs: { role: 'status' } }, icon(ic), h('span', { text }));

function colLetter(i) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Cap-aware table (array of arrays). header: first row is the header; letters: spreadsheet A/B/C + row numbers. */
export function buildTable(rows, { label, header = false, letters = false } = {}) {
  const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const thead = letters || header
    ? h('thead', {}, h('tr', {}, letters ? h('th', { class: 'fv__rn', attrs: { scope: 'col' } }) : null,
      ...Array.from({ length: width }, (_, i) => h('th', { attrs: { scope: 'col' }, text: letters ? colLetter(i) : ((rows[0] && rows[0][i]) ?? '') }))))
    : null;
  const body = header && !letters ? rows.slice(1) : rows;
  const tbody = h('tbody', {}, ...body.map((r, ri) => h('tr', {}, letters ? h('th', { class: 'fv__rn', attrs: { scope: 'row' }, text: String(ri + 1) }) : null,
    ...Array.from({ length: width }, (_, i) => { const v = r[i] ?? ''; return h('td', { class: /^-?\d+([.,]\d+)?%?$/.test(v) ? 'is-num' : '', text: v }); }))));
  return h('div', { class: 'fv__table-wrap', attrs: { tabindex: '0', role: 'region', 'aria-label': label || t('files.table') } }, h('table', { class: 'fv__table' }, thead, tbody));
}

function xlsxView(res) {
  const sheets = res.sheets || [];
  if (!sheets.length) return note(t('files.emptyFile'), 'file');
  const panel = h('div', { class: 'fv__sheet', attrs: { role: 'tabpanel' } });
  const tabs = h('div', { class: 'fv__tabs', attrs: { role: 'tablist', 'aria-label': t('files.sheets') } });
  const btns = [];
  const select = (i) => {
    btns.forEach((b, k) => { b.setAttribute('aria-selected', String(k === i)); b.tabIndex = k === i ? 0 : -1; b.classList.toggle('is-active', k === i); });
    const sh = sheets[i];
    panel.replaceChildren(
      ...(sh.truncated ? [note(t('files.rowsCapped', { n: sh.rows.length }))] : []),
      ...(sh.colsTruncated ? [note(t('files.colsCapped'))] : []),
      sh.rows.length ? buildTable(sh.rows, { letters: true, label: sh.name }) : note(t('files.emptySheet'), 'file'));
  };
  sheets.forEach((sh, i) => {
    const b = h('button', { class: 'fv__tab', type: 'button', attrs: { role: 'tab' }, text: sh.name });
    b.addEventListener('click', () => select(i));
    b.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      const n = (i + d + sheets.length) % sheets.length;
      select(n); btns[n].focus();
    });
    btns.push(b); tabs.append(b);
  });
  select(0);
  return h('div', { class: 'fv__xlsx' }, tabs, panel, res.moreSheets ? note(t('files.moreSheets', { n: res.moreSheets })) : null);
}

function pptxView(res) {
  const slides = res.slides || [];
  if (!slides.length) return note(t('files.emptyFile'), 'file');
  return h('div', { class: 'fv__slides', attrs: { role: 'list', 'aria-label': t('files.slides') } },
    ...slides.map((s) => h('section', { class: 'fv__slide', attrs: { role: 'listitem', 'aria-label': t('files.slideN', { n: s.index }) } },
      h('div', { class: 'fv__slide-n faint small', text: t('files.slideN', { n: s.index }) }),
      h('h3', { class: 'fv__slide-title', text: s.title || t('files.untitledSlide') }),
      s.lines.length ? h('ul', { class: 'fv__slide-lines' }, ...s.lines.map((l) => h('li', { text: l }))) : null,
      s.images.length ? h('div', { class: 'fv__slide-imgs' }, ...s.images.map((src) => h('img', { src, alt: '' }))) : null,
      s.notes ? h('details', { class: 'fv__notes' }, h('summary', { text: t('files.notes') }), h('div', { class: 'small', text: s.notes })) : null)),
    res.moreSlides ? note(t('files.moreSlides', { n: res.moreSlides })) : null);
}

function docxView(res) {
  const blocks = res.blocks || [];
  if (!blocks.length) return note(t('files.emptyFile'), 'file');
  return h('div', { class: 'md fv__md fv__doc' },
    ...blocks.map((b) => {
      if (b.t === 'table') return buildTable(b.rows, { header: true });
      if (b.level) return h('h' + Math.min(6, b.level + 1), { text: b.text });
      return h('p', { text: (b.list ? '• ' : '') + b.text });
    }),
    res.truncated ? note(t('files.docCapped')) : null);
}

function archiveView(res) {
  const rows = (res.entries || []).map((e) => [e.name, e.dir ? '' : formatBytes(e.size)]);
  return h('div', {}, h('div', { class: 'faint small', text: t('files.archiveCount', { n: res.total }) }),
    buildTable([[t('files.entryName'), t('files.entrySize')], ...rows], { header: true, label: t('files.archive') }),
    res.truncated ? note(t('files.rowsCapped', { n: rows.length })) : null);
}

function pdfView(res, ctx) {
  let url = res.dataUrl;
  try {
    const bin = atob(res.dataUrl.split(',')[1]);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    url = URL.createObjectURL(new Blob([arr], { type: 'application/pdf' }));
  } catch { /* keep the data url */ }
  return h('div', { class: 'fv__pdf' },
    h('iframe', { class: 'fv__frame', title: ctx.name, src: url }),
    h('div', { class: 'fv__note fv__note--info' }, icon('shield'), h('span', { text: t('files.pdfHint') }),
      h('button', { class: 'btn btn--sm', type: 'button', on: { click: () => ctx.act('open') } }, icon('external'), t('files.open'))));
}

function genericView(res, ctx) {
  const why = res.error === 'too-large' ? t('files.tooLarge') : res.error ? t('files.parseFailed') : t('files.binaryText');
  return h('div', { class: 'empty-state' },
    h('div', { class: 'empty-state__icon' }, icon('file', 'icon--lg')),
    h('div', { class: 'empty-state__title', text: t('files.binary') }),
    h('div', { class: 'empty-state__text', text: `${res.ext || ''} ${formatBytes(res.size)} - ${why}`.trim() }),
    h('div', { class: 'row gap-2 wrap' },
      h('button', { class: 'btn btn--sm', type: 'button', on: { click: () => ctx.act('open') } }, icon('external'), t('files.openDefault')),
      h('button', { class: 'btn btn--sm', type: 'button', on: { click: () => ctx.act('reveal') } }, icon('folder'), t('files.showInFolder'))));
}

/** ctx = {name, act(kind)} -> HTMLElement body */
export function renderPreview(res, ctx) {
  const wrap = h('div', { class: 'fv__body' });
  if (res.truncated || res.truncatedBytes) wrap.append(h('div', { class: 'fv__note', attrs: { role: 'status' } }, icon('alert'), t('files.truncated', { size: formatBytes(res.size) })));
  switch (res.type) {
    case 'markdown': wrap.append(h('div', { class: 'md fv__md' }, renderMarkdown(res.content || ''))); break;
    case 'text': case 'json': wrap.append(h('div', { class: 'fv__code' }, buildCodeBlock(res.content || '', res.lang || 'plaintext', { lineNumbers: true }))); break;
    case 'image': wrap.append(h('div', { class: 'fv__image' }, h('img', { src: res.dataUrl, alt: ctx.name }))); break;
    case 'html':
      wrap.append(
        h('div', { class: 'fv__note fv__note--info' }, icon('shield'), h('span', { text: t('files.htmlHint') }),
          h('button', { class: 'btn btn--sm', type: 'button', on: { click: () => ctx.act('open') } }, icon('external'), t('files.openBrowser'))),
        h('iframe', { class: 'fv__frame', title: ctx.name, sandbox: '', srcdoc: res.content || '' }));
      break;
    case 'csv':
      wrap.append(res.rows.length ? buildTable(res.rows, { header: true, label: ctx.name }) : note(t('files.emptyFile'), 'file'),
        ...(res.truncated ? [note(t('files.rowsCapped', { n: res.rows.length }))] : []), ...(res.colsTruncated ? [note(t('files.colsCapped'))] : []));
      break;
    case 'xlsx': wrap.append(xlsxView(res)); break;
    case 'pptx': wrap.append(pptxView(res)); break;
    case 'docx': wrap.append(docxView(res)); break;
    case 'archive': wrap.append(archiveView(res)); break;
    case 'pdf': wrap.append(pdfView(res, ctx)); break;
    default: wrap.append(genericView(res, ctx));
  }
  return wrap;
}
