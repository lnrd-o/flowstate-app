// Pure line-based unified diff (Myers O(ND)) with size guards. No dependencies.
export const MAX_DIFF_LINES = 5000;
export const MAX_DIFF_BYTES = 1024 * 1024;
const MAX_EDIT_DISTANCE = 3000;
const NOEOL = '\u0000noeol';

/** Split into comparable keys. CRLF is normalised to LF; a last line without a final newline gets a marker so EOF-newline changes show. */
function toLines(text) {
  const t = String(text ?? '').replace(/\r\n/g, '\n').replace(/\r(?!\n)/g, '\n');
  if (t === '') return [];
  const parts = t.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  else parts[parts.length - 1] += NOEOL;
  return parts;
}

const show = (k) => (k.endsWith(NOEOL) ? k.slice(0, -NOEOL.length) : k);

/** Myers shortest edit script -> ops [{t:' '|'+'|'-', k}] or null when the edit distance exceeds the cap. */
function myers(a, b) {
  const n = a.length; const m = b.length;
  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) x = v[off + k + 1];
      else x = v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
  }
  if (found < 0) return null;
  // Backtrack. trace[d] holds v (before round d) for diagonals -d-1 .. d+1.
  const ops = [];
  let x = n; let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d];
    const get = (k) => prev[k + d + 1];
    const k = x - y;
    const pk = (k === -d || (k !== d && get(k - 1) < get(k + 1))) ? k + 1 : k - 1;
    const px = get(pk); const py = px - pk;
    const ins = pk === k + 1;
    // snake after the edit
    while (x > px + (ins ? 0 : 1) && y > py + (ins ? 1 : 0)) { ops.push({ t: ' ', k: a[x - 1] }); x--; y--; }
    if (ins) { ops.push({ t: '+', k: b[y - 1] }); y--; } else { ops.push({ t: '-', k: a[x - 1] }); x--; }
  }
  while (x > 0 && y > 0) { ops.push({ t: ' ', k: a[x - 1] }); x--; y--; }
  return ops.reverse();
}

function coarse(a, b, maxLines) {
  const out = [];
  const lines = [...a.map((k) => ({ t: '-', k })), ...b.map((k) => ({ t: '+', k }))];
  const shown = lines.slice(0, maxLines);
  for (const o of shown) {
    out.push(`${o.t}${show(o.k)}`);
    if (o.k.endsWith(NOEOL)) out.push('\\ No newline at end of file');
  }
  const header = `@@ -${a.length ? 1 : 0},${a.length} +${b.length ? 1 : 0},${b.length} @@`;
  return { diff: `${header}\n${out.join('\n')}`, added: b.length, removed: a.length, truncated: true };
}

/** unifiedDiff(oldText, newText, {context, maxLines}) -> {diff, added, removed, truncated} */
export function unifiedDiff(oldText, newText, { context = 3, maxLines = 4000 } = {}) {
  const o = String(oldText ?? ''); const nw = String(newText ?? '');
  if (o === nw) return { diff: '', added: 0, removed: 0, truncated: false };
  const a = toLines(o); const b = toLines(nw);
  if (a.length === b.length && a.every((l, i) => l === b[i])) return { diff: '', added: 0, removed: 0, truncated: false };
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES || o.length > MAX_DIFF_BYTES || nw.length > MAX_DIFF_BYTES) return coarse(a, b, maxLines);

  // Trim the common prefix/suffix so Myers only sees the changed middle.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const mid = myers(a.slice(pre, a.length - suf), b.slice(pre, b.length - suf));
  if (!mid) return coarse(a, b, maxLines);
  const ops = [
    ...a.slice(0, pre).map((k) => ({ t: ' ', k })), ...mid, ...a.slice(a.length - suf).map((k) => ({ t: ' ', k })),
  ];

  let added = 0; let removed = 0;
  const changeIdx = [];
  ops.forEach((op, i) => { if (op.t === '+') { added++; changeIdx.push(i); } else if (op.t === '-') { removed++; changeIdx.push(i); } });

  // Group changes into hunks: nearby changes (gap <= 2*context unchanged lines) merge.
  const groups = [];
  for (const i of changeIdx) {
    const g = groups[groups.length - 1];
    if (g && i - g.end - 1 <= 2 * context) g.end = i; else groups.push({ start: i, end: i });
  }
  // Running line numbers per op index.
  const oldNo = []; const newNo = [];
  let ol = 1; let nl = 1;
  for (const op of ops) {
    oldNo.push(ol); newNo.push(nl);
    if (op.t !== '+') ol++;
    if (op.t !== '-') nl++;
  }

  const out = [];
  let truncated = false;
  for (const g of groups) {
    const s = Math.max(0, g.start - context); const e = Math.min(ops.length - 1, g.end + context);
    let oc = 0; let nc = 0;
    for (let i = s; i <= e; i++) { if (ops[i].t !== '+') oc++; if (ops[i].t !== '-') nc++; }
    const os = oc === 0 ? oldNo[s] - 1 : oldNo[s]; const ns = nc === 0 ? newNo[s] - 1 : newNo[s];
    const body = [`@@ -${os},${oc} +${ns},${nc} @@`];
    for (let i = s; i <= e; i++) {
      body.push(`${ops[i].t}${show(ops[i].k)}`);
      if (ops[i].k.endsWith(NOEOL)) body.push('\\ No newline at end of file');
    }
    if (out.length + body.length > maxLines) {
      truncated = true;
      out.push(...body.slice(0, Math.max(0, maxLines - out.length)));
      break;
    }
    out.push(...body);
  }
  return { diff: out.join('\n'), added, removed, truncated };
}
