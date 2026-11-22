// Append-only chat history: one JSONL file per project, stored INSIDE the project folder (<project>/.flowstate/history.jsonl).
// Falls back to <userData>/history/<projectId>.jsonl when the folder is unknown or read-only; an existing userData file is
// migrated into the folder once (the folder copy wins when both exist).
import fs from 'node:fs';
import path from 'node:path';
import { ensureStoreDir } from './svc/store-fs.js';

export const MAX_BYTES = 2 * 1024 * 1024;
export const KEEP_BYTES = Math.floor(MAX_BYTES * 0.75);
export const RETURN_LAST = 500;
const FIELD_CAP = 20000;
export const DIFF_CAP = 200 * 1024;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const THREAD_RE = /^[a-f0-9]{8}$/;

/** Cap very long string fields so a single record cannot blow up the file. */
export function capEvent(ev) {
  const out = { ...ev };
  for (const k of ['text', 'output', 'stderr', 'message']) {
    if (typeof out[k] === 'string' && out[k].length > FIELD_CAP) out[k] = `${out[k].slice(0, FIELD_CAP)}\n[truncated]`;
  }
  if (typeof out.diff === 'string' && out.diff.length > DIFF_CAP) { out.diff = `${out.diff.slice(0, DIFF_CAP)}\n[truncated]`; out.truncated = true; }
  if (typeof out.commandOutput === 'string' && out.commandOutput.length > FIELD_CAP) out.commandOutput = `${out.commandOutput.slice(0, FIELD_CAP)}\n[truncated]`;
  if (out.input !== undefined) {
    const s = JSON.stringify(out.input);
    if (s && s.length > FIELD_CAP) out.input = { truncated: s.slice(0, 2000) };
  }
  return out;
}

/** storeDirOf(projectId) -> absolute <project>/.flowstate path | null (unknown project). */
export function createHistory({ dir, fsx = fs, now = Date.now, storeDirOf = null, threadOf = null } = {}) {
  // threadOf(projectId) -> id of the project's ACTIVE conversation (null = the main one, history.jsonl). Other conversations use history-<id>.jsonl.
  const tidOf = (id) => { let t = null; try { t = threadOf?.(id) ?? null; } catch { t = null; } return typeof t === 'string' && THREAD_RE.test(t) ? t : null; };
  const root = path.join(dir, 'history');
  const pending = new Map(); // projectId -> accumulated text-delta string
  const readonly = new Set(); // projects whose folder could not be written: they use the userData copy
  const migrated = new Set();

  const legacyOf = (id) => {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new TypeError('invalid project id');
    return path.join(root, `${id}.jsonl`);
  };
  const folderOf = (id, tid = tidOf(id)) => {
    if (readonly.has(id)) return null;
    let d = null;
    try { d = storeDirOf?.(id) ?? null; } catch { d = null; }
    return d ? path.join(d, tid ? `history-${tid}.jsonl` : 'history.jsonl') : null;
  };
  /** One-time move of an old userData history file into the folder (best effort; never loses data). */
  const migrate = (id, folderFile) => {
    if (migrated.has(id)) return;
    migrated.add(id);
    const old = legacyOf(id);
    try {
      if (!fsx.existsSync(old) || fsx.existsSync(folderFile)) return; // both exist: the folder copy wins, the old one stays
      fsx.copyFileSync(old, folderFile);
      fsx.unlinkSync(old);
    } catch { /* keep the old copy */ }
  };
  // File to use for a project. For a folder file when writing, make sure the folder (and its .gitignore) exists and is writable.
  const fileOf = (id, forWrite = false, tid = tidOf(id)) => {
    const legacy = tid ? path.join(root, `${id}-${tid}.jsonl`) : legacyOf(id);
    legacyOf(id);
    const ff = folderOf(id, tid);
    if (!ff) return legacy;
    const storeDir = path.dirname(ff);
    if (forWrite) {
      try { ensureStoreDir(path.dirname(storeDir), fsx); } catch { readonly.add(id); return legacy; }
      if (!tid) migrate(id, ff);
    } else {
      if (fsx.existsSync(storeDir) && !tid) migrate(id, ff);
      if (!fsx.existsSync(ff) && fsx.existsSync(legacy)) return legacy; // not migrated yet (no folder): still readable
    }
    return ff;
  };
  const write = (id, rec) => {
    let f = fileOf(id, true);
    const line = `${JSON.stringify(rec)}\n`;
    try {
      fsx.mkdirSync(path.dirname(f), { recursive: true });
      fsx.appendFileSync(f, line, 'utf8');
    } catch (e) {
      if (f === legacyOf(id)) throw e;
      readonly.add(id); // read-only folder: fall back to the userData copy
      f = legacyOf(id);
      fsx.mkdirSync(path.dirname(f), { recursive: true });
      fsx.appendFileSync(f, line, 'utf8');
    }
  };
  const flush = (id) => {
    const t = pending.get(id);
    pending.delete(id);
    if (t) write(id, { ts: now(), t: 'event', event: capEvent({ type: 'text', text: t }) });
  };

  return {
    recordUser(id, text, images) {
      flush(id);
      const rec = { ts: now(), t: 'user', text: String(text).slice(0, FIELD_CAP) };
      if (Array.isArray(images) && images.length) rec.images = images.filter((r) => typeof r === 'string').slice(0, 5);
      write(id, rec);
    },
    /** text-delta is buffered; a full 'text' event supersedes the buffer; any other event flushes it first. */
    recordEvent(id, ev) {
      try {
        if (!ev || typeof ev !== 'object') return;
        if (ev.type === 'text-delta') { pending.set(id, (pending.get(id) ?? '') + (ev.text ?? '')); return; }
        if (ev.type === 'text') pending.delete(id); else flush(id);
        write(id, { ts: now(), t: 'event', event: capEvent(ev) });
      } catch { /* history is best effort */ }
    },
    flush,
    get(id, tid) {
      legacyOf(id);
      flush(id);
      const f = fileOf(id, false, tid === undefined ? tidOf(id) : tid);
      let text;
      try { text = fsx.readFileSync(f, 'utf8'); } catch { return []; }
      if (Buffer.byteLength(text) > MAX_BYTES) {
        const lines = text.split('\n').filter(Boolean);
        let size = 0; let start = lines.length;
        while (start > 0 && size + lines[start - 1].length + 1 <= KEEP_BYTES) { start--; size += lines[start].length + 1; }
        text = `${lines.slice(start).join('\n')}\n`;
        try { fsx.writeFileSync(f, text, 'utf8'); } catch { /* ignore */ }
      }
      const recs = [];
      for (const l of text.split('\n')) {
        if (!l) continue;
        try { const r = JSON.parse(l); if (r && (r.t === 'user' || r.t === 'event')) recs.push(r); } catch { /* skip bad line */ }
      }
      return recs.slice(-RETURN_LAST);
    },
    /** Truncate the history (folder copy and any leftover userData copy). */
    clear(id, tid) {
      legacyOf(id);
      pending.delete(id);
      const t = tid === undefined ? tidOf(id) : tid;
      const ff = folderOf(id, t);
      if (ff) { try { fsx.unlinkSync(ff); } catch { /* none */ } }
      try { fsx.unlinkSync(t ? path.join(root, `${id}-${t}.jsonl`) : legacyOf(id)); } catch { /* none */ }
    },
    /** Project removed from the registry: drop in-memory state and the userData copy only. The folder history stays. */
    forget(id) {
      pending.delete(id); migrated.delete(id); readonly.delete(id);
      try { fsx.unlinkSync(legacyOf(id)); } catch { /* none */ }
    },
    /** Absolute file currently used for this project (diagnostics / status). */
    fileFor: (id) => fileOf(id),
  };
}
