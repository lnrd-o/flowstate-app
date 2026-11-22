// Typed file previews for the Files tab / artifact viewer. Pure parsers (zip, xlsx, pptx, docx, csv) + a guarded reader.
// No native deps: own zip reader on node:zlib with entry-count / size / zip-bomb caps. Nothing is ever extracted to disk.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { resolveInside, classify, MAX_TEXT, MAX_IMAGE } from './files.js';

export const CAPS = Object.freeze({
  zipFile: 64 * 1024 * 1024, zipEntries: 5000, entryInflated: 24 * 1024 * 1024, totalInflated: 64 * 1024 * 1024,
  rows: 200, cols: 40, sheets: 30, slides: 100, slideImages: 3, imageBytes: 600 * 1024, imagesTotal: 4 * 1024 * 1024,
  blocks: 3000, docChars: 300000, listEntries: 500, pdf: 20 * 1024 * 1024, csvBytes: 1024 * 1024, sharedStrings: 200000, cellChars: 500,
});

// ---------- zip ----------
/** Open a zip held in a Buffer. -> {entries:[{name,size,csize,method,dir}], read(name,max?) -> Buffer|null} */
export function openZip(buf, caps = CAPS) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('Not a zip file');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOff === 0xffffffff || cdSize === 0xffffffff) throw new Error('ZIP64 is not supported');
  if (count > caps.zipEntries) throw new Error('Too many entries');
  if (cdOff + cdSize > buf.length) throw new Error('Corrupt zip');
  const entries = [];
  const byName = new Map();
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Corrupt zip');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nl);
    const e = { name, size, csize, method, dir: name.endsWith('/'), flags, lho };
    entries.push(e);
    byName.set(name, e);
    p += 46 + nl + el + cl;
  }
  let total = 0;
  const read = (name, max = caps.entryInflated) => {
    const e = byName.get(name);
    if (!e || e.dir) return null;
    if (e.flags & 1) throw new Error('Encrypted entries are not supported');
    if (e.size > max) throw new Error('Entry too large');
    const o = e.lho;
    if (o + 30 > buf.length || buf.readUInt32LE(o) !== 0x04034b50) throw new Error('Corrupt zip');
    const start = o + 30 + buf.readUInt16LE(o + 26) + buf.readUInt16LE(o + 28);
    if (start + e.csize > buf.length) throw new Error('Corrupt zip');
    const raw = buf.subarray(start, start + e.csize);
    let out;
    if (e.method === 0) out = Buffer.from(raw);
    else if (e.method === 8) {
      try { out = zlib.inflateRawSync(raw, { maxOutputLength: Math.min(max, Math.max(1, caps.totalInflated - total)) }); } catch { throw new Error('Entry too large or corrupt'); }
    } else throw new Error('Unsupported compression');
    total += out.length;
    if (total > caps.totalInflated) throw new Error('Archive expands too much');
    return out;
  };
  return { entries: entries.map(({ name, size, csize, method, dir }) => ({ name, size, csize, method, dir })), read };
}

// ---------- xml helpers ----------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export const xmlDecode = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
  if (e[0] === '#') { const c = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return String.fromCodePoint(c); } catch { return ''; } }
  return ENT[e.toLowerCase()] ?? m;
});
const attr = (tag, name) => { const m = new RegExp(`(?:^|[\\s<])${name}="([^"]*)"`).exec(tag); return m ? xmlDecode(m[1]) : null; };
const textOf = (xml, tagRe) => { let out = ''; const re = new RegExp(`<${tagRe}(?:\\s[^>]*)?>([\\s\\S]*?)</${tagRe}>`, 'g'); let m; while ((m = re.exec(xml))) out += xmlDecode(m[1]); return out; };
const clip = (s, n = CAPS.cellChars) => (s.length > n ? `${s.slice(0, n)}…` : s);
const str = (buf) => (buf ? buf.toString('utf8').replace(/^﻿/, '') : '');

function relsOf(zip, partPath) {
  const dir = path.posix.dirname(partPath);
  const x = str(zip.read(`${dir === '.' ? '' : `${dir}/`}_rels/${path.posix.basename(partPath)}.rels`));
  const map = new Map();
  for (const m of x.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], 'Id'); let tg = attr(m[0], 'Target'); const type = attr(m[0], 'Type') || '';
    if (!id || !tg || attr(m[0], 'TargetMode') === 'External') continue;
    tg = tg.startsWith('/') ? tg.slice(1) : path.posix.normalize(path.posix.join(dir === '.' ? '' : dir, tg));
    map.set(id, { target: tg, type });
  }
  return map;
}

// ---------- csv ----------
export function parseCsv(text, { delimiter, maxRows = CAPS.rows, maxCols = CAPS.cols } = {}) {
  const s = String(text).replace(/^﻿/, '');
  let d = delimiter;
  if (!d) {
    const first = s.split(/\r?\n/, 1)[0] || '';
    const cnt = (c) => first.split(c).length - 1;
    d = [',', ';', '\t', '|'].map((c) => [c, cnt(c)]).sort((a, b) => b[1] - a[1])[0][0];
  }
  const rows = []; let row = []; let cell = ''; let q = false; let truncated = false; let maxW = 0;
  const endRow = () => { row.push(cell); cell = ''; maxW = Math.max(maxW, row.length); rows.push(row.slice(0, maxCols)); row = []; };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c;
    } else if (c === '"' && cell === '') q = true;
    else if (c === d) { row.push(cell); cell = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      endRow();
      if (rows.length >= maxRows) { truncated = i < s.length - 1; break; }
    } else cell += c;
  }
  if (rows.length < maxRows && (cell !== '' || row.length)) endRow();
  return { delimiter: d, rows: rows.map((r) => r.map((v) => clip(v))), truncated, colsTruncated: maxW > maxCols };
}

// ---------- xlsx ----------
const BUILTIN_DATE = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
const isDateFmt = (code) => /[ymdhs]/i.test(String(code).replace(/"[^"]*"|\[[^\]]*\]|\\.|_.|\*./g, ''));

export function colIndex(ref) {
  const m = /^([A-Z]+)/i.exec(ref); if (!m) return 0;
  let n = 0; for (const ch of m[1].toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
}
export const colName = (i) => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

export function excelDate(serial) {
  const ms = Math.round(Number(serial) * 86400000);
  const d = new Date(Date.UTC(1899, 11, 30) + ms);
  if (Number.isNaN(d.getTime())) return String(serial);
  const iso = d.toISOString();
  return Number(serial) % 1 === 0 ? iso.slice(0, 10) : iso.slice(0, 16).replace('T', ' ');
}
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? String(Number(n.toPrecision(15))) : v; };

export function parseXlsx(buf, caps = CAPS) {
  const zip = openZip(buf, caps);
  const wb = str(zip.read('xl/workbook.xml'));
  if (!wb) throw new Error('Not a workbook');
  const rels = relsOf(zip, 'xl/workbook.xml');
  const shared = [];
  const ssXml = str(zip.read('xl/sharedStrings.xml'));
  for (const m of ssXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    shared.push(clip(textOf(m[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, ''), 't')));
    if (shared.length >= caps.sharedStrings) break;
  }
  const styles = str(zip.read('xl/styles.xml'));
  const fmts = new Map();
  for (const m of styles.matchAll(/<numFmt\b[^>]*>/g)) fmts.set(Number(attr(m[0], 'numFmtId')), attr(m[0], 'formatCode') || '');
  const xfs = [];
  const cx = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles);
  if (cx) for (const m of cx[1].matchAll(/<xf\b[^>]*>/g)) xfs.push(Number(attr(m[0], 'numFmtId') || 0));
  const kindOf = (s) => {
    const id = xfs[s]; if (id == null) return null;
    if (id === 9 || id === 10) return 'pct';
    if (BUILTIN_DATE.has(id) || (fmts.has(id) && isDateFmt(fmts.get(id)))) return 'date';
    return null;
  };
  const sheets = [];
  const defs = [...wb.matchAll(/<sheet\b[^>]*>/g)].map((m) => ({ name: attr(m[0], 'name') || 'Sheet', rid: attr(m[0], 'r:id') }));
  let more = 0;
  for (const def of defs) {
    if (sheets.length >= caps.sheets) { more++; continue; }
    const target = rels.get(def.rid)?.target;
    const sh = { name: def.name, rows: [], truncated: false, colsTruncated: false, dims: null };
    sheets.push(sh);
    let xml = '';
    try { xml = str(target ? zip.read(target) : null); } catch { sh.error = true; continue; }
    const dim = /<dimension\b[^>]*ref="([^"]+)"/.exec(xml); if (dim) sh.dims = dim[1];
    let n = 0;
    for (const rm of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      if (n >= caps.rows) { sh.truncated = true; break; }
      n++;
      const rIdx = Number(attr(rm[1], 'r')) || n;
      const cells = [];
      for (const cm of (rm[2] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = attr(cm[1], 'r'); const ci = ref ? colIndex(ref) : cells.length;
        if (ci >= caps.cols) { sh.colsTruncated = true; continue; }
        const t = attr(cm[1], 't'); const sIdx = Number(attr(cm[1], 's') || 0);
        const body = cm[2] || '';
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        let val = '';
        if (t === 's') val = shared[Number(v)] ?? '';
        else if (t === 'inlineStr') val = clip(textOf(body, 't'));
        else if (t === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
        else if (t === 'str' || t === 'e') val = clip(xmlDecode(v ?? ''));
        else if (v != null && v !== '') {
          const k = kindOf(sIdx);
          val = k === 'date' ? excelDate(v) : k === 'pct' ? `${num(Number(v) * 100)}%` : num(v);
        }
        while (cells.length < ci) cells.push('');
        cells[ci] = val;
      }
      while (sh.rows.length < rIdx - 1 && sh.rows.length < caps.rows) sh.rows.push([]);
      sh.rows.push(cells);
    }
    while (sh.rows.length && sh.rows[sh.rows.length - 1].every((c) => c === '')) sh.rows.pop();
  }
  return { sheets, moreSheets: more };
}

// ---------- pptx ----------
const paras = (xml) => [...xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)].map((m) => {
  const inner = m[1].replace(/<a:br\s*\/>/g, '\n');
  let out = ''; for (const tm of inner.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>|\n/g)) out += tm[0] === '\n' ? '\n' : xmlDecode(tm[1]);
  return out.trim();
}).filter(Boolean);
const IMG_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

export function parsePptx(buf, caps = CAPS) {
  const zip = openZip(buf, caps);
  const pres = str(zip.read('ppt/presentation.xml'));
  if (!pres) throw new Error('Not a presentation');
  const rels = relsOf(zip, 'ppt/presentation.xml');
  let order = [...pres.matchAll(/<p:sldId\b[^>]*>/g)].map((m) => rels.get(attr(m[0], 'r:id'))?.target).filter(Boolean);
  if (!order.length) order = zip.entries.map((e) => e.name).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => parseInt(a.match(/(\d+)\.xml/)[1], 10) - parseInt(b.match(/(\d+)\.xml/)[1], 10));
  let imgTotal = 0;
  const slides = [];
  for (const part of order.slice(0, caps.slides)) {
    let xml = '';
    try { xml = str(zip.read(part)); } catch { /* skip */ }
    let title = '';
    const lines = [];
    for (const sp of xml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g)) {
      const ps = paras(sp[0]);
      if (!ps.length) continue;
      if (!title && /<p:ph\b[^>]*type="(?:title|ctrTitle)"/.test(sp[0])) title = ps.join(' ');
      else lines.push(...ps);
    }
    // tables on slides
    for (const tc of xml.matchAll(/<a:tr\b[\s\S]*?<\/a:tr>/g)) {
      const cells = [...tc[0].matchAll(/<a:tc\b[\s\S]*?<\/a:tc>/g)].map((c) => paras(c[0]).join(' '));
      if (cells.some(Boolean)) lines.push(cells.join(' | '));
    }
    const srels = relsOf(zip, part);
    let notes = '';
    const images = [];
    for (const r of srels.values()) {
      try {
        if (/notesSlide$/.test(r.type)) {
          const nx = str(zip.read(r.target));
          const body = [...nx.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g)].filter((s) => /<p:ph\b[^>]*type="body"/.test(s[0])).flatMap((s) => paras(s[0]));
          notes = body.join('\n');
        } else if (/\/image$/.test(r.type) && images.length < caps.slideImages) {
          const mime = IMG_MIME[path.posix.extname(r.target).slice(1).toLowerCase()];
          if (!mime) continue;
          const e = zip.entries.find((x) => x.name === r.target);
          if (!e || e.size > caps.imageBytes || imgTotal + e.size > caps.imagesTotal) continue;
          const b = zip.read(r.target, caps.imageBytes);
          if (b) { imgTotal += b.length; images.push(`data:${mime};base64,${b.toString('base64')}`); }
        }
      } catch { /* ignore broken optional parts */ }
    }
    slides.push({ index: slides.length + 1, title: clip(title, 300), lines: lines.slice(0, 200).map((l) => clip(l, 2000)), notes: clip(notes, 5000), images });
  }
  return { slides, moreSlides: Math.max(0, order.length - caps.slides) };
}

// ---------- docx ----------
export function parseDocx(buf, caps = CAPS) {
  const zip = openZip(buf, caps);
  const xml = str(zip.read('word/document.xml'));
  if (!xml) throw new Error('Not a document');
  const ptext = (p) => {
    let out = '';
    for (const m of p.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>/g)) out += m[0].startsWith('<w:tab') ? '\t' : m[0].startsWith('<w:br') ? '\n' : xmlDecode(m[1]);
    return out;
  };
  const blocks = []; let chars = 0; let truncated = false;
  for (const m of xml.matchAll(/<w:tbl\b[\s\S]*?<\/w:tbl>|<w:p\b[\s\S]*?<\/w:p>/g)) {
    if (blocks.length >= caps.blocks || chars > caps.docChars) { truncated = true; break; }
    if (m[0].startsWith('<w:tbl')) {
      const rows = [...m[0].matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)].slice(0, caps.rows).map((r) => [...r[0].matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)].slice(0, caps.cols).map((c) => clip([...c[0].matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)].map((p) => ptext(p[0])).join(' ')))); 
      blocks.push({ t: 'table', rows });
    } else {
      const text = ptext(m[0]);
      if (!text.trim()) continue;
      const hm = /<w:pStyle\b[^>]*w:val="(?:Heading|heading|Title)(\d?)"/.exec(m[0]);
      chars += text.length;
      blocks.push({ t: 'p', text, ...(hm ? { level: Math.min(6, Number(hm[1]) || 1) } : {}), ...(/<w:numPr>/.test(m[0]) ? { list: true } : {}) });
    }
  }
  return { blocks, truncated };
}

export function listZip(buf, caps = CAPS) {
  const zip = openZip(buf, caps);
  const all = zip.entries;
  return { entries: all.slice(0, caps.listEntries).map((e) => ({ name: e.name, size: e.size, dir: e.dir })), total: all.length, truncated: all.length > caps.listEntries };
}

// ---------- classification + guarded reader ----------
const ZIPS = new Set(['.zip', '.jar', '.apk', '.whl', '.vsix', '.odt', '.ods', '.odp', '.epub', '.nupkg']);
const mimeByExt = { '.pdf': 'application/pdf', '.xlsx': 'xlsx', '.xlsm': 'xlsx', '.pptx': 'pptx', '.docx': 'docx' };

/** Pure: preview type by file name. -> 'pdf'|'csv'|'xlsx'|'pptx'|'docx'|'json'|'archive'|'markdown'|'html'|'image'|'text'|'binary' */
export function previewType(rel) {
  const ext = path.posix.extname(String(rel).replace(/\\/g, '/')).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (ext === '.csv' || ext === '.tsv') return 'csv';
  if (mimeByExt[ext]) return mimeByExt[ext];
  if (ext === '.json') return 'json';
  if (ZIPS.has(ext)) return 'archive';
  return classify(rel).kind;
}

export function createPreview({ getProject, fsx = fs } = {}) {
  const need = (id) => { const p = typeof id === 'string' ? getProject(id) : null; if (!p) throw new Error('Unknown project'); return p; };
  const head = (abs, max) => {
    const fd = fsx.openSync(abs, 'r');
    try { const b = Buffer.alloc(max); return b.subarray(0, fsx.readSync(fd, b, 0, max, 0)); } finally { fsx.closeSync(fd); }
  };
  return {
    /** -> {type, size, name, ext, ...payload}; never throws for parse problems (returns type 'generic' + error). */
    preview(projectId, relPath) {
      const p = need(projectId);
      const { abs, rel } = resolveInside(p.path, relPath, fsx);
      const st = fsx.statSync(abs);
      if (!st.isFile()) throw new Error('Not a file');
      const size = st.size;
      const ext = path.extname(rel).toLowerCase();
      const base = { size, name: path.basename(rel), ext, mtimeMs: st.mtimeMs };
      const generic = (error) => ({ ...base, type: 'generic', ...(error ? { error } : {}) });
      const type = previewType(rel);
      try {
        if (type === 'image') {
          const c = classify(rel);
          if (size > MAX_IMAGE) return generic('too-large');
          return { ...base, type, dataUrl: `data:${c.mime};base64,${fsx.readFileSync(abs).toString('base64')}` };
        }
        if (type === 'pdf') {
          if (size > CAPS.pdf) return generic('too-large');
          return { ...base, type, dataUrl: `data:application/pdf;base64,${fsx.readFileSync(abs).toString('base64')}` };
        }
        if (['xlsx', 'pptx', 'docx', 'archive'].includes(type)) {
          if (size > CAPS.zipFile) return generic('too-large');
          const buf = fsx.readFileSync(abs);
          if (type === 'xlsx') return { ...base, type, ...parseXlsx(buf) };
          if (type === 'pptx') return { ...base, type, ...parsePptx(buf) };
          if (type === 'docx') return { ...base, type, ...parseDocx(buf) };
          return { ...base, type, ...listZip(buf) };
        }
        if (type === 'csv') {
          const buf = head(abs, Math.min(size, CAPS.csvBytes));
          return { ...base, type, ...parseCsv(buf.toString('utf8'), { delimiter: ext === '.tsv' ? '\t' : undefined }), truncatedBytes: size > CAPS.csvBytes };
        }
        if (type === 'binary') {
          const buf = head(abs, Math.min(size, 8192));
          if (buf.includes(0) || size === 0) return generic();
          // unknown extension but looks like text: show it as plain text
          const t = head(abs, Math.min(size, MAX_TEXT));
          return { ...base, type: 'text', lang: 'plaintext', content: t.toString('utf8'), truncated: size > MAX_TEXT };
        }
        const buf = head(abs, Math.min(size, MAX_TEXT));
        if (buf.includes(0)) return generic();
        let content = buf.toString('utf8');
        const truncated = size > MAX_TEXT;
        const c = classify(rel);
        if (type === 'json' && !truncated) { try { content = JSON.stringify(JSON.parse(content), null, 2); } catch { /* show raw */ } }
        return { ...base, type, content, truncated, ...(c.lang ? { lang: c.lang } : {}) };
      } catch (e) {
        return generic(e && e.message ? String(e.message).slice(0, 200) : 'parse-failed');
      }
    },
  };
}
