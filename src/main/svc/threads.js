// Conversations ("threads") per project + markdown context notes.
//
// A project keeps several named conversations for different sections of the work. They all see the same project folder; the
// ACTIVE conversation is mirrored into the project record (agent, model, effort, sessionId, sessionRoute, activeThread), so the agent
// manager and the composer keep working unchanged. Each conversation has its own history file (history-<id>.jsonl; the main one keeps
// history.jsonl) and a markdown note <project>/.flowstate/context/<id>.md. <project>/.flowstate/context/PROJECT.md summarises all of
// them. When a conversation has no resumable session (provider swap, new machine, session expired) the next prompt carries a short
// hand-off note pointing the agent at those files, so any provider can pick the work up.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { THREAD_RE } from '../history.js';
import { readJsonSafe } from './store-fs.js';
import { writeJsonAtomic } from '../settings.js';

export const MAIN_ID = '00000000';
const MAX_THREADS = 30;
const MAX_TITLE = 60;
const MAX_FILES = 20;
const EXCHANGES_IN_MD = 40;
const TEXT_CAP = 1500;
const CONTEXT_DIR = 'context';
const IGNORE_LINES = ['threads.json', 'history-*.jsonl'];
const DEFAULT_TITLE_RE = /^(Conversation|Conversación) \d+$/;

const validId = (id) => id === MAIN_ID || (typeof id === 'string' && THREAD_RE.test(id));
const cleanTitle = (s, fallback) => {
  const t = String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
  return t || fallback;
};
const clip = (s, n) => { const t = String(s ?? '').trim(); return t.length > n ? `${t.slice(0, n)}...` : t; };

/** Pure: markdown of one conversation from history records (user + assistant text + files touched). */
export function renderThreadMarkdown(thread, project, records) {
  const lines = [`# ${thread.title}`, '',
    `- Project: ${project.name}`,
    `- Agent: ${thread.agent}${thread.model ? ` (${thread.model})` : ''}`,
    `- Updated: ${new Date(thread.updatedAt || Date.now()).toISOString()}`, ''];
  const exchanges = [];
  let cur = null;
  for (const r of records || []) {
    if (r.t === 'user') { cur = { user: String(r.text || ''), reply: [], files: [] }; exchanges.push(cur); continue; }
    if (!cur || r.t !== 'event' || !r.event) continue;
    const ev = r.event;
    if (ev.type === 'text' && ev.text) cur.reply.push(String(ev.text));
    else if (ev.type === 'file-change' && ev.path && !cur.files.includes(ev.path)) cur.files.push(ev.path);
  }
  const shown = exchanges.slice(-EXCHANGES_IN_MD);
  if (exchanges.length > shown.length) lines.push(`_${exchanges.length - shown.length} earlier exchanges are not shown._`, '');
  for (const x of shown) {
    lines.push('## You', '', clip(x.user, TEXT_CAP), '');
    const reply = x.reply.join('\n\n');
    lines.push('## Assistant', '', reply ? clip(reply, TEXT_CAP) : '_(no text reply)_', '');
    if (x.files.length) lines.push(`Files changed: ${x.files.map((f) => `\`${f}\``).join(', ')}`, '');
  }
  if (!shown.length) lines.push('_No messages yet._', '');
  return lines.join('\n');
}

/** Pure: PROJECT.md (all conversations of a project). */
export function renderProjectMarkdown(project, threads, activeId) {
  const lines = [`# ${project.name}`, '', 'Context notes kept by FlowState. Every conversation of this project shares the same files; read the notes below to continue any of them.', '',
    '## Conversations', ''];
  for (const t of threads) {
    const file = t.id === MAIN_ID ? 'main' : t.id;
    lines.push(`- **${t.title}**${t.id === activeId ? ' (active)' : ''} - ${t.agent}${t.model ? `/${t.model}` : ''}, ${t.turns || 0} turns - \`.flowstate/${CONTEXT_DIR}/${file}.md\``);
  }
  const files = [...new Set(threads.flatMap((t) => t.files || []))].slice(0, 40);
  lines.push('', '## Files touched recently', '', ...(files.length ? files.map((f) => `- \`${f}\``) : ['_None yet._']), '');
  return lines.join('\n');
}

export function create({ projects, history, agents, fsx = fs, now = Date.now }) {
  const storeDir = (p) => path.join(p.path, '.flowstate');
  const fileOf = (p) => path.join(storeDir(p), 'threads.json');
  const ctxName = (tid) => `${tid === MAIN_ID ? 'main' : tid}.md`;
  const ctxRel = (tid) => `.flowstate/${CONTEXT_DIR}/${ctxName(tid)}`;
  const ctxAbs = (p, tid) => path.join(storeDir(p), CONTEXT_DIR, ctxName(tid));
  const need = (id) => { const p = projects.get(id); if (!p) throw new Error('Unknown project'); return p; };

  // Conversation fields that live on the project record while that conversation is active.
  const MIRROR = ['agent', 'model', 'effort', 'sessionId', 'sessionRoute'];
  const fromProject = (p, base = {}) => ({ ...base, ...Object.fromEntries(MIRROR.map((k) => [k, p[k] ?? null])) });

  function load(p) {
    const { data } = readJsonSafe(fileOf(p), { fsx, now });
    let threads = Array.isArray(data?.threads) ? data.threads.filter((t) => t && validId(t.id) && typeof t.title === 'string').slice(0, MAX_THREADS) : [];
    if (!threads.some((t) => t.id === MAIN_ID)) {
      threads.unshift({ id: MAIN_ID, title: 'Main', createdAt: now(), updatedAt: now(), turns: 0, files: [], ...fromProject(p) });
    }
    let active = validId(data?.active) && threads.some((t) => t.id === data.active) ? data.active : MAIN_ID;
    return { threads, active };
  }

  function save(p, st) {
    try {
      fsx.mkdirSync(storeDir(p), { recursive: true });
      writeJsonAtomic(fileOf(p), { version: 1, active: st.active, threads: st.threads }, fsx);
      ensureIgnore(p);
    } catch { /* best effort: the folder may be read-only */ }
  }

  function ensureIgnore(p) {
    const gi = path.join(storeDir(p), '.gitignore');
    let text = '';
    try { text = fsx.readFileSync(gi, 'utf8'); } catch { /* none yet */ }
    const have = new Set(text.split(/\r?\n/).map((l) => l.trim()));
    const add = IGNORE_LINES.filter((l) => !have.has(l));
    if (add.length) fsx.writeFileSync(gi, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${add.join('\n')}\n`, 'utf8');
  }

  const loaded = new Set(); // projects whose active conversation was already applied to the project record

  /** Make the project record reflect the stored active conversation (first call per project in this run). */
  function adopt(p) {
    const st = load(p);
    if (!loaded.has(p.id)) {
      loaded.add(p.id);
      const t = st.threads.find((x) => x.id === st.active);
      if (p.activeThread !== st.active || (t && t.id !== MAIN_ID)) {
        projects.update(p.id, { activeThread: st.active, ...Object.fromEntries(MIRROR.map((k) => [k, t?.[k] ?? null])) });
      }
      if (!fsx.existsSync(fileOf(p))) save(p, st);
    }
    return { st, p: projects.get(p.id) };
  }

  function writeContext(p, st) {
    try {
      const dir = path.join(storeDir(p), CONTEXT_DIR);
      fsx.mkdirSync(dir, { recursive: true });
      const t = st.threads.find((x) => x.id === st.active);
      const recs = history?.get?.(p.id) ?? [];
      if (t) fsx.writeFileSync(ctxAbs(p, t.id), renderThreadMarkdown(t, p, recs), 'utf8');
      fsx.writeFileSync(path.join(dir, 'PROJECT.md'), renderProjectMarkdown(p, st.threads, st.active), 'utf8');
    } catch { /* best effort */ }
  }

  const view = (p, st) => ({
    active: st.active,
    threads: st.threads.map((t) => ({ id: t.id, title: t.title, agent: t.agent, model: t.model ?? null, turns: t.turns || 0, updatedAt: t.updatedAt || 0, main: t.id === MAIN_ID, contextPath: ctxRel(t.id) })),
    projectContextPath: `.flowstate/${CONTEXT_DIR}/PROJECT.md`,
  });

  const isRunning = (id) => !!agents?.status?.(id)?.running;
  const stop = (reason) => ({ ok: false, reason });

  /** Write the live project fields into the active conversation entry. */
  function sync(p) {
    if (!p || !p.activeThread) return;
    const st = load(p);
    const t = st.threads.find((x) => x.id === p.activeThread);
    if (!t || st.active !== p.activeThread) return;
    const next = fromProject(p, t);
    if (MIRROR.every((k) => t[k] === next[k])) return;
    Object.assign(t, next, { updatedAt: now() });
    save(p, st);
  }
  const off = projects.onChange?.((kind, p) => { if (kind === 'update') { try { sync(p); } catch { /* ignore */ } } });

  const switchTo = (p, st, tid) => {
    try { history?.flush?.(p.id); } catch { /* ignore */ }
    const cur = projects.get(p.id);
    const t = st.threads.find((x) => x.id === tid);
    const from = st.threads.find((x) => x.id === st.active);
    if (from) Object.assign(from, fromProject(cur, from));
    st.active = tid;
    save(p, st);
    projects.update(p.id, { activeThread: tid, ...Object.fromEntries(MIRROR.map((k) => [k, t[k] ?? null])) });
    writeContext(projects.get(p.id), st);
    return t;
  };

  return {
    /** Write the notes now (Context notes button). */
    ensureContext(id) { const { st, p } = adopt(need(id)); writeContext(p, st); return view(p, st); },
    list(id) {
      const { st, p } = adopt(need(id));
      if (!fsx.existsSync(ctxAbs(p, st.active)) || !fsx.existsSync(path.join(storeDir(p), CONTEXT_DIR, 'PROJECT.md'))) writeContext(p, st);
      return view(p, st);
    },

    create(id, o = {}) {
      const { st, p } = adopt(need(id));
      if (isRunning(id)) return stop('running');
      if (st.threads.length >= MAX_THREADS) return stop('limit');
      const tid = crypto.randomBytes(4).toString('hex');
      const n = st.threads.length;
      const title = cleanTitle(o.title, `Conversation ${n}`);
      const base = { id: tid, title, createdAt: now(), updatedAt: now(), turns: 0, files: [] };
      const agent = typeof o.agent === 'string' && ['claude', 'agy', 'opencode'].includes(o.agent) ? o.agent : p.agent;
      st.threads.push({ ...base, agent, model: agent === p.agent ? p.model ?? null : null, effort: agent === p.agent ? p.effort ?? null : null, sessionId: null, sessionRoute: null });
      switchTo(p, st, tid);
      return { ok: true, id: tid, ...view(projects.get(id), st) };
    },

    switch(id, tid) {
      const { st, p } = adopt(need(id));
      if (!validId(tid) || !st.threads.some((t) => t.id === tid)) return stop('unknown');
      if (isRunning(id)) return stop('running');
      if (tid !== st.active) switchTo(p, st, tid);
      return { ok: true, ...view(projects.get(id), st) };
    },

    rename(id, tid, title) {
      const { st, p } = adopt(need(id));
      const t = st.threads.find((x) => x.id === tid);
      if (!t) return stop('unknown');
      t.title = cleanTitle(title, t.title);
      save(p, st);
      writeContext(projects.get(id), st);
      return { ok: true, ...view(p, st) };
    },

    remove(id, tid) {
      const { st, p } = adopt(need(id));
      if (tid === MAIN_ID) return stop('main');
      if (!st.threads.some((x) => x.id === tid)) return stop('unknown');
      if (isRunning(id)) return stop('running');
      if (st.active === tid) switchTo(p, st, MAIN_ID);
      st.threads = st.threads.filter((x) => x.id !== tid);
      save(p, st);
      try { history?.clear?.(id, tid); } catch { /* ignore */ }
      try { fsx.unlinkSync(ctxAbs(p, tid)); } catch { /* none */ }
      writeContext(projects.get(id), st);
      return { ok: true, ...view(projects.get(id), st) };
    },

    /** Hook: after each finished turn update counters / files / auto-title and refresh the markdown notes. */
    onAgentEvent(id, ev) {
      try {
        if (!ev) return;
        const p0 = projects.get(id);
        if (!p0) return;
        if (ev.type === 'file-change' && ev.path) {
          const { st, p } = adopt(p0);
          const t = st.threads.find((x) => x.id === st.active);
          if (t) { t.files = [ev.path, ...(t.files || []).filter((f) => f !== ev.path)].slice(0, MAX_FILES); save(p, st); }
          return;
        }
        if (ev.type !== 'result' && ev.type !== 'error') return;
        const { st, p } = adopt(p0);
        const t = st.threads.find((x) => x.id === st.active);
        if (!t) return;
        if (ev.type === 'result') t.turns = (t.turns || 0) + 1;
        t.updatedAt = now();
        Object.assign(t, fromProject(projects.get(id) ?? p, t));
        if (t.id !== MAIN_ID && DEFAULT_TITLE_RE.test(t.title) && (t.turns || 0) === 1) {
          const first = (history?.get?.(id) ?? []).find((r) => r.t === 'user');
          if (first) t.title = cleanTitle(first.text, t.title);
        }
        save(p, st);
        writeContext(projects.get(id) ?? p, st);
      } catch { /* never break the agent stream */ }
    },

    /** Prompt note for a conversation that cannot resume a session: where the agent finds the earlier work. */
    handoffNote(project) {
      try {
        if (!project || project.sessionId) return null;
        const p = projects.get(project.id);
        if (!p) return null;
        const { st } = adopt(p);
        const t = st.threads.find((x) => x.id === st.active);
        if (!t) return null;
        const file = ctxAbs(p, t.id);
        let md = '';
        try { md = fsx.readFileSync(file, 'utf8'); } catch { return null; }
        if (!(t.turns > 0) && !md.includes('## You')) return null; // nothing was discussed yet
        return `[FlowState context] This conversation continues earlier work in this project (the previous session cannot be resumed, for example because the provider changed). Before answering, read ${ctxRel(t.id)} (this conversation so far) and ${`.flowstate/${CONTEXT_DIR}/PROJECT.md`} (all conversations and recently changed files), then continue consistently with them.`;
      } catch { return null; }
    },

    dispose() { try { off?.(); } catch { /* ignore */ } },
  };
}
