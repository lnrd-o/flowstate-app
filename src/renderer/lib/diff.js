// Pure diff helpers (no DOM): line diff, unified diff writer/parser, and client-side diffs derived from tool inputs.

const MAX_DP = 4_000_000; // cells of the LCS table before falling back to "replace everything"
const MAX_DERIVED_LINES = 400;

/** Split text into lines (CRLF tolerant, no phantom trailing line). */
export function splitLines(s) {
  const text = String(s ?? '').replace(/\r\n/g, '\n');
  if (text === '') return [];
  const a = text.split('\n');
  if (a[a.length - 1] === '') a.pop();
  return a;
}

/** Line diff via LCS on the part between the common prefix and suffix. Returns [{ t: 'ctx'|'add'|'del', text }]. */
export function lineDiff(oldLines, newLines) {
  const a = oldLines;
  const b = newLines;
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  const ops = [];
  for (let i = 0; i < pre; i++) ops.push({ t: 'ctx', text: a[i] });
  const n = am.length;
  const m = bm.length;
  if (n * m > MAX_DP) {
    for (const x of am) ops.push({ t: 'del', text: x });
    for (const x of bm) ops.push({ t: 'add', text: x });
  } else if (n === 0 || m === 0) {
    for (const x of am) ops.push({ t: 'del', text: x });
    for (const x of bm) ops.push({ t: 'add', text: x });
  } else {
    const w = m + 1;
    const dp = new Int32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * w + j] = am[i] === bm[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (am[i] === bm[j]) { ops.push({ t: 'ctx', text: am[i] }); i++; j++; }
      else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) { ops.push({ t: 'del', text: am[i] }); i++; }
      else { ops.push({ t: 'add', text: bm[j] }); j++; }
    }
    while (i < n) ops.push({ t: 'del', text: am[i++] });
    while (j < m) ops.push({ t: 'add', text: bm[j++] });
  }
  for (let i = a.length - suf; i < a.length; i++) ops.push({ t: 'ctx', text: a[i] });
  return ops;
}

/** Unified diff (hunks only, no file headers) between two texts, with `context` lines around changes. */
export function makeUnifiedDiff(oldText, newText, context = 3) {
  const ops = lineDiff(splitLines(oldText), splitLines(newText));
  const changed = [];
  ops.forEach((o, i) => { if (o.t !== 'ctx') changed.push(i); });
  if (!changed.length) return '';
  // Group changed indices into ranges separated by more than 2*context unchanged lines.
  const ranges = [];
  let start = Math.max(0, changed[0] - context);
  let end = Math.min(ops.length - 1, changed[0] + context);
  for (let k = 1; k < changed.length; k++) {
    const lo = Math.max(0, changed[k] - context);
    const hi = Math.min(ops.length - 1, changed[k] + context);
    if (lo <= end + 1) end = hi;
    else { ranges.push([start, end]); start = lo; end = hi; }
  }
  ranges.push([start, end]);
  // Line numbers before each op.
  const oldNo = [];
  const newNo = [];
  let o = 1;
  let nn = 1;
  for (const op of ops) {
    oldNo.push(o); newNo.push(nn);
    if (op.t !== 'add') o++;
    if (op.t !== 'del') nn++;
  }
  const out = [];
  for (const [s, e] of ranges) {
    let oc = 0;
    let nc = 0;
    const body = [];
    for (let i = s; i <= e; i++) {
      const op = ops[i];
      if (op.t !== 'add') oc++;
      if (op.t !== 'del') nc++;
      body.push((op.t === 'add' ? '+' : op.t === 'del' ? '-' : ' ') + op.text);
    }
    out.push('@@ -' + (oc ? oldNo[s] : oldNo[s] - 1) + ',' + oc + ' +' + (nc ? newNo[s] : newNo[s] - 1) + ',' + nc + ' @@', ...body);
  }
  return out.join('\n');
}

/** Unified diff of a brand-new file: everything added. */
export function newFileDiff(content) {
  const lines = splitLines(content);
  if (!lines.length) return '';
  return ['@@ -0,0 +1,' + lines.length + ' @@', ...lines.map((l) => '+' + l)].join('\n');
}

/**
 * Parse a unified diff into hunks. File header lines (diff/index/---/+++) before the first hunk are skipped.
 * Returns { hunks: [{ header, lines: [{ type: 'ctx'|'add'|'del'|'meta', text, oldNo, newNo }] }], added, removed }.
 */
export function parseUnifiedDiff(diff) {
  const hunks = [];
  let added = 0;
  let removed = 0;
  let cur = null;
  let o = 0;
  let n = 0;
  for (const raw of String(diff ?? '').replace(/\r\n/g, '\n').split('\n')) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (m) {
      cur = { header: raw, lines: [] };
      hunks.push(cur);
      o = Number(m[1]);
      n = Number(m[2]);
      continue;
    }
    if (!cur) {
      if (/^(diff |index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode)/.test(raw) || raw === '') continue;
      cur = { header: '', lines: [] };
      hunks.push(cur);
      o = 1;
      n = 1;
    }
    if (raw.startsWith('\\')) cur.lines.push({ type: 'meta', text: raw, oldNo: null, newNo: null });
    else if (raw.startsWith('+')) { cur.lines.push({ type: 'add', text: raw.slice(1), oldNo: null, newNo: n++ }); added++; }
    else if (raw.startsWith('-')) { cur.lines.push({ type: 'del', text: raw.slice(1), oldNo: o++, newNo: null }); removed++; }
    else cur.lines.push({ type: 'ctx', text: raw.startsWith(' ') ? raw.slice(1) : raw, oldNo: o++, newNo: n++ });
  }
  // A trailing empty line from the final newline is not a context line.
  for (const hk of hunks) {
    const last = hk.lines[hk.lines.length - 1];
    if (last && last.type === 'ctx' && last.text === '' && String(diff).endsWith('\n')) hk.lines.pop();
  }
  return { hunks: hunks.filter((hk) => hk.lines.length || hk.header), added, removed };
}

/** Number of body lines of a parsed diff (all hunks). */
export function diffLineCount(parsed) {
  return parsed.hunks.reduce((s, hk) => s + hk.lines.length, 0);
}

const S = (v) => (typeof v === 'string' ? v : null);
const first = (input, keys) => { for (const k of keys) { const v = S(input[k]); if (v != null) return v; } return null; };

/**
 * Diff derived on the client from a tool's input (claude Edit / MultiEdit / Write, or similar agy inputs that carry content).
 * Returns { path, op, added, removed, diff, truncated, derived: true } or null when the input has nothing to show.
 */
export function diffFromInput(kind, input) {
  if (!input || typeof input !== 'object') return null;
  const path = first(input, ['file_path', 'filePath', 'path', 'Path', 'TargetFile', 'targetFile', 'AbsolutePath', 'notebook_path']);
  if (!path) return null;
  let diff = '';
  let op = 'modify';
  let truncated = false;
  if (kind === 'write') {
    const content = first(input, ['content', 'CodeContent', 'file_text', 'text']);
    if (content == null) return null;
    op = 'create';
    let lines = splitLines(content);
    if (lines.length > MAX_DERIVED_LINES) { lines = lines.slice(0, MAX_DERIVED_LINES); truncated = true; }
    diff = lines.length ? ['@@ -0,0 +1,' + lines.length + ' @@', ...lines.map((l) => '+' + l)].join('\n') : '';
  } else if (kind === 'edit') {
    const pairs = [];
    if (Array.isArray(input.edits)) {
      for (const e of input.edits) if (e && typeof e === 'object') pairs.push([first(e, ['old_string', 'TargetContent']), first(e, ['new_string', 'ReplacementContent'])]);
    } else {
      pairs.push([first(input, ['old_string', 'TargetContent']), first(input, ['new_string', 'ReplacementContent'])]);
    }
    const parts = pairs.filter(([a, b]) => a != null && b != null).map(([a, b]) => makeUnifiedDiff(a, b, 3)).filter(Boolean);
    if (!parts.length) return null;
    diff = parts.join('\n');
  } else return null;
  const p = parseUnifiedDiff(diff);
  return { path, op, added: p.added, removed: p.removed, diff, truncated, derived: true };
}
