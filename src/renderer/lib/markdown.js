// Markdown -> sanitized DOM. ALL model output goes through DOMPurify before it touches the page.
import { Marked } from '../vendor/marked.js';
import DOMPurify from '../vendor/purify.js';
import hljs from '../vendor/hljs-core.js';
import javascript from '../vendor/hljs/languages/javascript.js';
import typescript from '../vendor/hljs/languages/typescript.js';
import json from '../vendor/hljs/languages/json.js';
import bash from '../vendor/hljs/languages/bash.js';
import powershell from '../vendor/hljs/languages/powershell.js';
import python from '../vendor/hljs/languages/python.js';
import css from '../vendor/hljs/languages/css.js';
import xml from '../vendor/hljs/languages/xml.js';
import markdown from '../vendor/hljs/languages/markdown.js';
import yaml from '../vendor/hljs/languages/yaml.js';
import diff from '../vendor/hljs/languages/diff.js';
import sql from '../vendor/hljs/languages/sql.js';
import java from '../vendor/hljs/languages/java.js';
import csharp from '../vendor/hljs/languages/csharp.js';
import cpp from '../vendor/hljs/languages/cpp.js';
import c from '../vendor/hljs/languages/c.js';
import go from '../vendor/hljs/languages/go.js';
import rust from '../vendor/hljs/languages/rust.js';
import ruby from '../vendor/hljs/languages/ruby.js';
import php from '../vendor/hljs/languages/php.js';
import dockerfile from '../vendor/hljs/languages/dockerfile.js';
import ini from '../vendor/hljs/languages/ini.js';
import kotlin from '../vendor/hljs/languages/kotlin.js';
import swift from '../vendor/hljs/languages/swift.js';
import plaintext from '../vendor/hljs/languages/plaintext.js';
import { t } from './i18n.js';
import { simplifyMath } from './md-utils.js';
import { h } from './dom.js';
import { readStore } from './storage.js';
import {
  closeOpenFence, detectLanguage, classifyDiffLine, splitHighlightedLines, escapeHtml, isSafeHref, isSafeClass,
} from './md-utils.js';

const LANGS = {
  javascript, typescript, json, bash, powershell, python, css, xml, markdown, yaml, diff, sql, java, csharp,
  cpp, c, go, rust, ruby, php, dockerfile, ini, kotlin, swift, plaintext,
};
for (const [name, def] of Object.entries(LANGS)) hljs.registerLanguage(name, def);

const SANITIZE = {
  ALLOWED_TAGS: [
    'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'em', 'strong',
    'del', 's', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'span', 'div', 'sub', 'sup', 'details', 'summary',
  ],
  ALLOWED_ATTR: ['href', 'title', 'class', 'colspan', 'rowspan', 'align', 'start'],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  RETURN_DOM_FRAGMENT: true,
};

let hooked = false;
function installHooks() {
  if (hooked) return;
  hooked = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.hasAttribute && node.hasAttribute('class') && !isSafeClass(node.getAttribute('class'))) {
      node.removeAttribute('class');
    }
    if (node.tagName === 'A') {
      const href = node.getAttribute('href');
      if (href && isSafeHref(href)) {
        node.setAttribute('rel', 'noopener noreferrer');
      } else {
        node.removeAttribute('href');
      }
      node.removeAttribute('target');
    }
  });
}

const marked = new Marked({ gfm: true, breaks: false });

/** Whether line numbers are on (localStorage flag 'flowstate.lineNumbers' = '1'). */
export function lineNumbersEnabled() {
  return readStore('flowstate.lineNumbers', '0') === '1';
}

export function highlightLines(text, lang) {
  let html;
  try {
    html = lang === 'plaintext' ? escapeHtml(text) : hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
  } catch {
    html = escapeHtml(text);
  }
  return splitHighlightedLines(html);
}

function copyButton(rawText) {
  const btn = h('button', { class: 'code-block__copy btn btn--ghost btn--sm', type: 'button', text: t('chat.copy') });
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(rawText);
    } catch {
      // Clipboard unavailable: fall back to a transient textarea selection.
      const ta = h('textarea', { value: rawText, style: 'position:fixed;opacity:0' });
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch { /* ignore */ }
      ta.remove();
    }
    btn.textContent = t('chat.copied');
    btn.classList.add('is-copied');
    setTimeout(() => {
      btn.textContent = t('chat.copy');
      btn.classList.remove('is-copied');
    }, 1500);
  });
  return btn;
}

/** Build a .code-block element for raw code text and a fence info string. */
export function buildCodeBlock(text, info, opts = {}) {
  const { label, lang } = detectLanguage(info);
  const isDiff = lang === 'diff';
  const showLines = opts.lineNumbers ?? lineNumbersEnabled();
  const raw = String(text).replace(/\n$/, '');
  const rawLines = raw.split('\n');
  const htmlLines = highlightLines(raw, lang);
  const useLineSpans = isDiff || showLines;

  const code = h('code', { class: 'hljs language-' + lang });
  if (useLineSpans) {
    // hljs output is escaped HTML built from the text, so setting it is safe.
    code.innerHTML = htmlLines.map((ln, i) => {
      const kind = isDiff ? classifyDiffLine(rawLines[i] ?? '') : 'ctx';
      const cls = 'line' + (kind === 'add' ? ' diff-add' : kind === 'del' ? ' diff-del' : '');
      return '<span class="' + cls + '">' + (ln || '') + '</span>';
    }).join('');
  } else {
    code.innerHTML = htmlLines.join('\n');
  }
  return h('div', { class: 'code-block' + (showLines ? ' code-block--lines' : '') },
    h('div', { class: 'code-block__header' }, h('span', { class: 'code-block__lang', text: label }), copyButton(raw)),
    h('pre', null, code));
}

function enhanceCodeBlocks(fragment, opts) {
  for (const pre of [...fragment.querySelectorAll('pre')]) {
    const codeEl = pre.querySelector('code');
    const cls = (codeEl && codeEl.getAttribute('class')) || '';
    const info = cls.replace(/^language-/, '');
    const block = buildCodeBlock((codeEl || pre).textContent, info, opts);
    pre.replaceWith(block);
  }
}

/**
 * Render markdown text to a sanitized DocumentFragment (wrap it in a .md element yourself).
 * opts.streaming: close unfinished code fences so layout stays stable while text arrives.
 */
export function renderMarkdown(text, opts = {}) {
  installHooks();
  const src = simplifyMath(opts.streaming ? closeOpenFence(text) : String(text ?? ''));
  const dirty = marked.parse(src, { async: false });
  const frag = DOMPurify.sanitize(dirty, SANITIZE);
  enhanceCodeBlocks(frag, opts);
  return frag;
}

/** Route external link clicks inside root to window.open (never navigate in-window). */
export function attachLinkHandler(root) {
  root.addEventListener('click', (e) => {
    const a = e.target instanceof Element ? e.target.closest('a') : null;
    if (!a || !root.contains(a)) return;
    e.preventDefault();
    const href = a.getAttribute('href');
    if (href && isSafeHref(href)) window.open(href, '_blank', 'noopener,noreferrer');
  });
}

/** Cooperative streaming renderer: coalesces updates into one render per animation frame. */
export function createFrameRenderer(render) {
  let pending = false;
  return () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; render(); });
  };
}
