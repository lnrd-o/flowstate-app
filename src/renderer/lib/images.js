// Pure helpers for image attachments (validation, suggestion chips, base64) + a tiny thumbnail cache. No DOM.

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGES = 5;
export const IMAGE_MIMES = Object.freeze(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
export const IMAGE_ACCEPT = IMAGE_MIMES.join(',');

/** i18n keys of the chips shown while at least one image is attached (the text is resolved in the current language). */
export const IMAGE_SUGGESTIONS = Object.freeze([
  { id: 'describe', key: 'images.sugg.describe' },
  { id: 'recreate', key: 'images.sugg.recreate' },
  { id: 'bug', key: 'images.sugg.bug' },
  { id: 'text', key: 'images.sugg.text' },
  { id: 'design', key: 'images.sugg.design' },
]);

/** General starter chips for an empty chat without images. */
export const STARTER_SUGGESTIONS = Object.freeze([
  { id: 'explain', key: 'images.starter.explain' },
  { id: 'tests', key: 'images.starter.tests' },
  { id: 'todo', key: 'images.starter.todo' },
]);

/**
 * Suggestion chips for the composer. translate(key) -> text (the caller passes i18n t, so it follows the current language).
 * With >= 1 image: the 5 image prompts. Without images and an empty chat: 3 starters. Otherwise none.
 */
export function suggestionChips({ imageCount = 0, chatEmpty = false }, translate) {
  const list = imageCount > 0 ? IMAGE_SUGGESTIONS : chatEmpty ? STARTER_SUGGESTIONS : [];
  return list.map((s) => ({ id: s.id, text: translate(s.key) }));
}

/**
 * Validate one candidate file ({type, size, name}) given how many images are already attached.
 * Returns { ok:true } or { ok:false, key, vars } (i18n key under images.err.*).
 */
export function validateImage(file, existingCount = 0) {
  if (!file || typeof file !== 'object') return { ok: false, key: 'images.err.type', vars: { name: '' } };
  const name = String(file.name || 'image');
  if (!IMAGE_MIMES.includes(String(file.type || '').toLowerCase())) return { ok: false, key: 'images.err.type', vars: { name } };
  if (!(Number(file.size) > 0)) return { ok: false, key: 'images.err.empty', vars: { name } };
  if (Number(file.size) > MAX_IMAGE_BYTES) return { ok: false, key: 'images.err.size', vars: { name, max: Math.round(MAX_IMAGE_BYTES / 1048576) } };
  if (existingCount >= MAX_IMAGES) return { ok: false, key: 'images.err.count', vars: { name, max: MAX_IMAGES } };
  return { ok: true };
}

/** Validate a batch in order: returns { accepted: file[], errors: [{name, key, vars}] } (never exceeds MAX_IMAGES in total). */
export function validateBatch(files, existingCount = 0) {
  const accepted = [];
  const errors = [];
  for (const f of Array.from(files || [])) {
    const r = validateImage(f, existingCount + accepted.length);
    if (r.ok) accepted.push(f);
    else errors.push({ name: String((f && f.name) || 'image'), key: r.key, vars: r.vars });
  }
  return { accepted, errors };
}

/** data:image/png;base64,AAAA -> { mime, base64 } (null when it is not a base64 data URL). */
export function parseDataUrl(dataUrl) {
  const m = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n]*)$/i.exec(String(dataUrl || ''));
  return m ? { mime: m[1].toLowerCase(), base64: m[2].replace(/[\r\n]/g, '') } : null;
}

/** Bytes represented by a base64 string. */
export function base64Bytes(b64) {
  const s = String(b64 || '').replace(/[\r\n=]/g, '');
  return Math.floor((s.length * 3) / 4);
}

export function extFromMime(mime) {
  return { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[String(mime).toLowerCase()] || 'png';
}

/** Name for a pasted clipboard image (they arrive as "image.png"). */
export function pastedName(mime, n = 1, now = new Date()) {
  const p = (x) => String(x).padStart(2, '0');
  return 'pasted-' + now.getFullYear() + p(now.getMonth() + 1) + p(now.getDate()) + '-' + p(now.getHours()) + p(now.getMinutes()) + p(now.getSeconds()) + '-' + n + '.' + extFromMime(mime);
}

/** "1.4 MB" style size text. */
export function sizeText(bytes) {
  const b = Number(bytes) || 0;
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(b < 10240 ? 1 : 0) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}

/** Memoised attachments.read(projectId, rel) -> Promise<dataUrl|null> (shared by the chat bubbles and the lightbox). */
export function createThumbCache(api) {
  const cache = new Map();
  return {
    get(projectId, rel) {
      const key = projectId + '|' + rel;
      if (!cache.has(key)) {
        const p = Promise.resolve()
          .then(() => (api.attachments && api.attachments.read ? api.attachments.read(projectId, rel) : null))
          .then((r) => (r && typeof r.dataUrl === 'string' ? r.dataUrl : null))
          .catch(() => null);
        cache.set(key, p);
        p.then((v) => { if (v == null) cache.delete(key); });
      }
      return cache.get(key);
    },
    put(projectId, rel, dataUrl) { cache.set(projectId + '|' + rel, Promise.resolve(dataUrl)); },
  };
}
