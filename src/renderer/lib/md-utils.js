// Pure helpers for markdown rendering (no DOM, unit-tested in Node).

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Streaming-safe fence closing: if the text ends inside an unfinished fenced code block,
 * append a closing fence so the markdown parser renders it as a complete block.
 */
export function closeOpenFence(text) {
  const src = String(text ?? '');
  let open = null; // { ch, len }
  for (const line of src.split('\n')) {
    const m = FENCE_RE.exec(line.replace(/\r$/, ''));
    if (!m) continue;
    const marker = m[1];
    const rest = m[2];
    if (!open) {
      if (marker[0] === '`' && rest.includes('`')) continue; // inline code like ```a``` is not a fence
      open = { ch: marker[0], len: marker.length };
    } else if (marker[0] === open.ch && marker.length >= open.len && rest.trim() === '') {
      open = null;
    }
  }
  if (!open) return src;
  const fence = open.ch.repeat(open.len);
  return src + (src.endsWith('\n') ? '' : '\n') + fence;
}

const LANG_ALIASES = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', node: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  py: 'python', python3: 'python',
  sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash', 'shell-session': 'bash',
  ps1: 'powershell', pwsh: 'powershell', ps: 'powershell',
  yml: 'yaml',
  html: 'xml', htm: 'xml', svg: 'xml', xhtml: 'xml', vue: 'xml',
  md: 'markdown',
  'c++': 'cpp', cc: 'cpp', hpp: 'cpp', h: 'c',
  cs: 'csharp', 'c#': 'csharp',
  rs: 'rust', golang: 'go', rb: 'ruby', kt: 'kotlin',
  docker: 'dockerfile', patch: 'diff',
  json5: 'json', jsonc: 'json', jsonl: 'json',
  text: 'plaintext', txt: 'plaintext', plain: 'plaintext', '': 'plaintext',
  toml: 'ini', conf: 'ini',
};

export const SUPPORTED_LANGUAGES = Object.freeze([
  'javascript', 'typescript', 'json', 'bash', 'powershell', 'python', 'css', 'xml', 'markdown', 'yaml', 'diff',
  'sql', 'java', 'csharp', 'cpp', 'c', 'go', 'rust', 'ruby', 'php', 'dockerfile', 'ini', 'kotlin', 'swift', 'plaintext',
]);

/** Map a fence info string ("```ts title=x") to { label, lang } where lang is a registered hljs language. */
export function detectLanguage(info) {
  const raw = String(info ?? '').trim().split(/\s+/)[0].replace(/^\{?\.?/, '').replace(/\}$/, '').toLowerCase();
  const mapped = Object.prototype.hasOwnProperty.call(LANG_ALIASES, raw) ? LANG_ALIASES[raw] : raw;
  const lang = SUPPORTED_LANGUAGES.includes(mapped) ? mapped : 'plaintext';
  return { label: raw || 'text', lang };
}

/** Classify one line of unified diff: 'add' | 'del' | 'hunk' | 'ctx'. File headers (+++ / ---) are context. */
export function classifyDiffLine(line) {
  const s = String(line ?? '');
  if (s.startsWith('+++') || s.startsWith('---')) return 'ctx';
  if (s.startsWith('@@')) return 'hunk';
  if (s.startsWith('+')) return 'add';
  if (s.startsWith('-')) return 'del';
  return 'ctx';
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Split highlighted HTML (hljs output: only <span ...> and </span> tags) into lines, closing and
 * reopening open spans at every newline so each line is well-formed on its own.
 */
export function splitHighlightedLines(html) {
  const lines = [];
  const stack = []; // opening tags currently open
  let cur = '';
  const re = /(<span[^>]*>|<\/span>|\n)/g;
  let last = 0;
  let m;
  while ((m = re.exec(html)) !== null) {
    cur += html.slice(last, m.index);
    last = re.lastIndex;
    const tok = m[1];
    if (tok === '\n') {
      cur += '</span>'.repeat(stack.length);
      lines.push(cur);
      cur = stack.join('');
    } else if (tok === '</span>') {
      stack.pop();
      cur += tok;
    } else {
      stack.push(tok);
      cur += tok;
    }
  }
  cur += html.slice(last);
  cur += '</span>'.repeat(stack.length);
  lines.push(cur);
  return lines;
}

const SAFE_HREF = /^(?:https?:\/\/|mailto:)/i;
/** True for hrefs we are willing to keep/open: http(s) and mailto only. */
export function isSafeHref(href) {
  return SAFE_HREF.test(String(href ?? '').trim());
}

/** True when the class value is a plain "language-xyz" token list (everything else is stripped). */
export function isSafeClass(value) {
  return /^language-[\w+#.-]+$/.test(String(value ?? '').trim());
}

// ---- LaTeX-ish math -> readable text -------------------------------------------------------------------------------------
// Models often write "$30 - 35\text{ cm}$". We have no math renderer, so inline/display math that really uses LaTeX syntax is turned
// into plain text ("30 - 35 cm"). Plain money like "$30 and $40" is left alone (no backslash / ^ / _ inside the dollars).

const SYMBOLS = {
  times: '×', cdot: '·', approx: '≈', pm: '±', le: '≤', leq: '≤', ge: '≥', geq: '≥', neq: '≠', ne: '≠',
  rightarrow: '→', to: '→', leftarrow: '←', sim: '~', infty: '∞', pi: 'π', Delta: 'Δ', delta: 'δ', mu: 'µ',
  alpha: 'α', beta: 'β', gamma: 'γ', theta: 'θ', lambda: 'λ', sigma: 'σ', omega: 'ω', degree: '°', circ: '°',
  div: '÷', ldots: '...', dots: '...', cdots: '...', quad: ' ', qquad: '  ',
};
const SUP = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹', '+': '⁺', '-': '⁻' };
const SUB = { 0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉' };
const mapChars = (s, table) => (s.length && [...s].every((c) => table[c] !== undefined) ? [...s].map((c) => table[c]).join('') : null);

/** One math expression (without the dollars) -> plain text. */
export function mathToText(expr) {
  let s = String(expr ?? '');
  for (let i = 0; i < 4; i++) { // nested \text{\textbf{..}} and \frac{\sqrt{..}}{..}
    s = s.replace(/\\(?:text|textbf|textit|mathrm|mathbf|mathit|operatorname|mbox)\s*\{([^{}]*)\}/g, '$1')
      .replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '($1)/($2)')
      .replace(/\\sqrt\s*\{([^{}]*)\}/g, '√($1)');
  }
  s = s.replace(/\^\s*\{?\\circ\}?/g, '°')
    .replace(/\^\s*\{([^{}]*)\}|\^\s*([0-9+-])/g, (_m, a, b) => { const x = a ?? b; return mapChars(x, SUP) ?? `^(${x})`; })
    .replace(/_\s*\{([^{}]*)\}|_\s*([0-9])/g, (_m, a, b) => { const x = a ?? b; return mapChars(x, SUB) ?? `_${x}`; })
    .replace(/\\([%$&#_{}])/g, '$1')
    .replace(/\\[,;:! ]/g, ' ')
    .replace(/\\([A-Za-z]+)/g, (_m, name) => (name in SYMBOLS ? SYMBOLS[name] : name))
    .replace(/[{}]/g, '');
  return s.replace(/[ \t]+/g, ' ').trim();
}

const LATEX_HINT = /\\[A-Za-z]|\^\s*[{0-9+-]|_\s*\{/;

/** Replace $...$ and $$...$$ spans that use LaTeX syntax with plain text. Fenced code and `inline code` are left untouched. */
export function simplifyMath(text) {
  const src = String(text ?? '');
  if (!src.includes('$')) return src;
  return src.split(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/).map((part, i) => {
    if (i % 2 === 1) return part;
    return part
      .replace(/\$\$([\s\S]+?)\$\$/g, (m, e) => (LATEX_HINT.test(e) ? `\n\n${mathToText(e)}\n\n` : m))
      .replace(/\$(?=\S)([^$\n]+?)(?<=\S)\$/g, (m, e) => (LATEX_HINT.test(e) ? mathToText(e) : m));
  }).join('');
}
