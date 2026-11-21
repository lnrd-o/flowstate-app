// Append-only chat history: one JSONL file per project in <userData>/history/<projectId>.jsonl.
import fs from 'node:fs';
import path from 'node:path';

export const MAX_BYTES = 2 * 1024 * 1024;
export const KEEP_BYTES = Math.floor(MAX_BYTES * 0.75);
export const RETURN_LAST = 500;
const FIELD_CAP = 20000;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Cap very long string fields so a single record cannot blow up the file. */
export function capEvent(ev) {
  const out = { ...ev };
  for (const k of ['text', 'output', 'stderr', 'message']) {
    if (typeof out[k] === 'string' && out[k].length > FIELD_CAP) out[k] = `${out[k].slice(0, FIELD_CAP)}\n[truncated]`;
  }
  if (out.input !== undefined) {
    const s = JSON.stringify(out.input);
    if (s && s.length > FIELD_CAP) out.input = { truncated: s.slice(0, 2000) };
  }
  return out;
}

export function createHistory({ dir, fsx = fs, now = Date.now } = {}) {
  const root = path.join(dir, 'history');
  const pending = new Map(); // projectId -> accumulated text-delta string
  const fileOf = (id) => {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new TypeError('invalid project id');
    return path.join(root, `${id}.jsonl`);
  };
  const write = (id, rec) => {
    const f = fileOf(id);
    fsx.mkdirSync(root, { recursive: true });
    fsx.appendFileSync(f, `${JSON.stringify(rec)}\n`, 'utf8');
  };
  const flush = (id) => {
    const t = pending.get(id);
    pending.delete(id);
    if (t) write(id, { ts: now(), t: 'event', event: capEvent({ type: 'text', text: t }) });
  };

  return {
    recordUser(id, text) {
      flush(id);
      write(id, { ts: now(), t: 'user', text: String(text).slice(0, FIELD_CAP) });
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
    get(id) {
      const f = fileOf(id);
      flush(id);
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
    clear(id) {
      const f = fileOf(id);
      pending.delete(id);
      try { fsx.unlinkSync(f); } catch { /* none */ }
    },
  };
}
