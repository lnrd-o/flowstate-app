// Real diff view: a table-like region with old/new line-number gutters, coloured add/del rows, muted hunk headers and
// syntax highlighting of the code part (by file extension). Everything is built with createElement/textContent.
import { h } from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import { parseUnifiedDiff, diffLineCount } from '../lib/diff.js';
import { highlightLines } from '../lib/markdown.js';
import { detectLanguage } from '../lib/md-utils.js';

const MAX_HIGHLIGHT_LINES = 1500;
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'", '&#39;': "'" };
const decode = (s) => s.replace(/&(?:amp|lt|gt|quot|#x27|#39);/g, (m) => ENTITIES[m]);

/** Convert one line of hljs output (only span tags + escaped text) into DOM nodes without innerHTML. */
export function highlightedToNodes(html) {
  const root = document.createDocumentFragment();
  const stack = [root];
  const re = /<span class="([\w -]*)">|<\/span>/g;
  let last = 0;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m.index > last) stack[stack.length - 1].appendChild(document.createTextNode(decode(html.slice(last, m.index))));
    last = re.lastIndex;
    if (m[0] === '</span>') { if (stack.length > 1) stack.pop(); }
    else {
      const span = document.createElement('span');
      span.className = m[1];
      stack[stack.length - 1].appendChild(span);
      stack.push(span);
    }
  }
  if (last < html.length) stack[stack.length - 1].appendChild(document.createTextNode(decode(html.slice(last))));
  return root;
}

/** Highlighted DOM nodes for each line of a hunk, keyed by line object (old side for del, new side for add and ctx). */
function highlightHunk(hunk, lang) {
  const oldLines = hunk.lines.filter((l) => l.type === 'ctx' || l.type === 'del');
  const newLines = hunk.lines.filter((l) => l.type === 'ctx' || l.type === 'add');
  const oldHtml = highlightLines(oldLines.map((l) => l.text).join('\n'), lang);
  const newHtml = highlightLines(newLines.map((l) => l.text).join('\n'), lang);
  const map = new Map();
  oldLines.forEach((l, i) => { if (l.type === 'del') map.set(l, oldHtml[i]); });
  newLines.forEach((l, i) => map.set(l, newHtml[i]));
  return map;
}

/**
 * opts: { diff, path, hideNumbers, label }. Returns { el, text } where text is the raw unified diff (for Copy diff).
 */
export function createDiffView({ diff, path, hideNumbers = false, label }) {
  const parsed = parseUnifiedDiff(diff);
  const ext = (/\.([A-Za-z0-9+#-]+)$/.exec(String(path || '')) || [])[1] || '';
  const lang = detectLanguage(ext).lang;
  const canHighlight = lang !== 'plaintext' && lang !== 'diff' && diffLineCount(parsed) <= MAX_HIGHLIGHT_LINES;

  const tbody = h('tbody');
  for (const hunk of parsed.hunks) {
    if (hunk.header) {
      tbody.append(h('tr', { class: 'diffv__row diffv__row--hunk' },
        h('td', { class: 'diffv__num' }), h('td', { class: 'diffv__num' }), h('td', { class: 'diffv__sign' }),
        h('td', { class: 'diffv__code', text: hunk.header })));
    }
    let hl = null;
    if (canHighlight) { try { hl = highlightHunk(hunk, lang); } catch { hl = null; } }
    for (const line of hunk.lines) {
      const cell = h('td', { class: 'diffv__code' });
      const html = hl && hl.get(line);
      if (html != null && line.type !== 'meta') cell.append(highlightedToNodes(html));
      else cell.textContent = line.text;
      const sign = line.type === 'add' ? '+' : line.type === 'del' ? '-' : '';
      tbody.append(h('tr', { class: 'diffv__row diffv__row--' + line.type },
        h('td', { class: 'diffv__num', text: hideNumbers || line.oldNo == null ? '' : String(line.oldNo), attrs: { 'aria-hidden': 'true' } }),
        h('td', { class: 'diffv__num', text: hideNumbers || line.newNo == null ? '' : String(line.newNo), attrs: { 'aria-hidden': 'true' } }),
        h('td', { class: 'diffv__sign', text: sign }),
        cell));
    }
  }
  const table = h('table', { class: 'diffv__table' }, tbody);
  const el = h('div', {
    class: 'diffv' + (hideNumbers ? ' diffv--nonum' : ''),
    attrs: { role: 'region', tabindex: '0', 'aria-label': label || t('act.diffLabel', { file: path || '' }) },
  }, table);
  return { el, text: String(diff || ''), lines: diffLineCount(parsed), parsed };
}
