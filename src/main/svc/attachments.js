// Pasted / dropped images: stored in <project>/.flowstate/attachments/ (git-ignored), magic bytes verified, size parsed.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveInside } from '../files.js';
import { ensureStoreDir, ATTACH_REL } from './store-fs.js';

export const MAX_BYTES = 8 * 1024 * 1024;
export const MAX_READ = 5 * 1024 * 1024;
export const MAX_IMAGES = 5;
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const MIME_BY_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

/** Magic-byte sniff -> mime | null. */
export function sniffMime(b) {
  if (!b || b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

const pngSize = (b) => (b.length >= 24 ? { width: b.readUInt32BE(16), height: b.readUInt32BE(20) } : null);
const gifSize = (b) => (b.length >= 10 ? { width: b.readUInt16LE(6), height: b.readUInt16LE(8) } : null);
function jpegSize(b) {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    const len = b.readUInt16BE(i + 2);
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}
function webpSize(b) {
  const kind = b.toString('latin1', 12, 16);
  if (kind === 'VP8 ' && b.length >= 30) return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  if (kind === 'VP8L' && b.length >= 25) { const v = b.readUInt32LE(21); return { width: (v & 0x3fff) + 1, height: ((v >>> 14) & 0x3fff) + 1 }; }
  if (kind === 'VP8X' && b.length >= 30) return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  return null;
}
/** -> {width,height}|null from the header bytes. */
export function imageSize(b, mime) {
  try {
    const r = { 'image/png': pngSize, 'image/gif': gifSize, 'image/jpeg': jpegSize, 'image/webp': webpSize }[mime]?.(b);
    return r && r.width > 0 && r.height > 0 ? r : null;
  } catch { return null; }
}

/** Display name only: never a path, no control chars. */
export function displayName(name) {
  const base = String(name ?? '').split(/[\\/]/).pop().replace(/[\x00-\x1f\x7f<>:"|?*]/g, '').trim().slice(0, 80);
  return base || 'image';
}

const stamp = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Resolve agent.send images [{rel}] into [{rel, abs, mime, size, dataBase64?}] (max 5, each must exist inside the project's
 * attachments dir). withData=true also loads base64 (claude). Throws on anything invalid.
 */
export function loadAttachmentImages(project, images, { fsx = fs, withData = false } = {}) {
  if (!Array.isArray(images) || images.length === 0) return [];
  if (images.length > MAX_IMAGES) throw new Error(`At most ${MAX_IMAGES} images per message`);
  const out = [];
  for (const i of images) {
    const rel = i?.rel;
    if (typeof rel !== 'string' || !rel.startsWith(`${ATTACH_REL}/`)) throw new Error('Invalid image path');
    const { abs, rel: clean } = resolveInside(project.path, rel, fsx);
    if (!clean.startsWith(`${ATTACH_REL}/`) || clean.split('/').length !== 3) throw new Error('Invalid image path');
    let st;
    try { st = fsx.statSync(abs); } catch { throw new Error(`Image not found: ${clean}`); }
    if (!st.isFile() || st.size > MAX_BYTES) throw new Error(`Invalid image: ${clean}`);
    const mime = MIME_BY_EXT[path.extname(abs).slice(1).toLowerCase()];
    if (!mime) throw new Error(`Unsupported image type: ${clean}`);
    const rec = { rel: clean, abs, mime, size: st.size };
    if (withData) rec.dataBase64 = fsx.readFileSync(abs).toString('base64');
    out.push(rec);
  }
  return out;
}

export function create({ getProject, fsx = fs, now = () => new Date(), randomHex = () => crypto.randomBytes(3).toString('hex') } = {}) {
  const need = (id) => {
    const p = typeof id === 'string' ? getProject(id) : null;
    if (!p) throw new Error('Unknown project');
    return p;
  };
  return {
    save(projectId, { name, mime, dataBase64 } = {}) {
      const p = need(projectId);
      if (!EXT[mime]) throw new Error('Unsupported image type');
      if (typeof dataBase64 !== 'string' || !B64.test(dataBase64)) throw new Error('Invalid image data');
      const buf = Buffer.from(dataBase64, 'base64');
      if (buf.length === 0 || buf.length > MAX_BYTES) throw new Error('Image too large (max 8 MB)');
      if (sniffMime(buf) !== mime) throw new Error('Image content does not match its type');
      const dims = imageSize(buf, mime);
      ensureStoreDir(p.path, fsx);
      const { abs: dir } = resolveInside(p.path, ATTACH_REL, fsx);
      fsx.mkdirSync(dir, { recursive: true });
      const id = `${stamp(now())}-${randomHex()}`;
      const file = `${id}.${EXT[mime]}`;
      fsx.writeFileSync(path.join(dir, file), buf, { flag: 'wx' });
      return { id, rel: `${ATTACH_REL}/${file}`, name: displayName(name), mime, size: buf.length, ...(dims ?? {}) };
    },
    read(projectId, rel) {
      const p = need(projectId);
      const { abs, rel: clean } = resolveInside(p.path, rel, fsx);
      if (!clean.startsWith(`${ATTACH_REL}/`)) throw new Error('Not an attachment');
      const st = fsx.statSync(abs);
      if (!st.isFile()) throw new Error('Not a file');
      if (st.size > MAX_READ) throw new Error('Image too large to preview');
      const buf = fsx.readFileSync(abs);
      const mime = sniffMime(buf);
      if (!mime) throw new Error('Not an image');
      return { dataUrl: `data:${mime};base64,${buf.toString('base64')}` };
    },
  };
}
