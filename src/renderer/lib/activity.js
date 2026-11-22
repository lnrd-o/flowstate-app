// Pure helpers behind the rich activity view (tool card titles, turn statistics, timeline). No DOM.
import { classifyTool } from '../../shared/events.js';
import { diffFromInput } from './diff.js';
import { relativeTo } from './touched.js';

const PATH_KEYS = ['file_path', 'filePath', 'path', 'Path', 'TargetFile', 'targetFile', 'AbsolutePath', 'notebook_path', 'DirectoryPath', 'SearchPath', 'url', 'Url'];
const CMD_KEYS = ['command', 'CommandLine', 'commandLine'];
const QUERY_KEYS = ['pattern', 'Pattern', 'query', 'Query', 'url', 'Url', 'prompt', 'Query'];

const str = (input, keys) => {
  if (!input || typeof input !== 'object') return '';
  for (const k of keys) if (typeof input[k] === 'string' && input[k]) return input[k];
  return '';
};

/** Tool kind of a chat tool message (reducer stores it; old history falls back to classifying the name). */
export function kindOf(m) {
  return (m && m.kind) || classifyTool(null, m && m.name);
}

/** Remove ANSI escape sequences (colors, cursor moves, OSC) and resolve carriage-return rewrites. */
export function stripAnsi(s) {
  return String(s ?? '')
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[@-Z\\-_]/g, '')
    .replace(/\r\n/g, '\n')
    .split('\n').map((l) => (l.includes('\r') ? l.slice(l.lastIndexOf('\r') + 1) : l)).join('\n');
}

/** 17300 -> "17.3 s", 800 -> "800 ms", 72000 -> "1 m 12 s". */
export function formatDuration(ms) {
  const v = Number(ms);
  if (!Number.isFinite(v) || v < 0) return '';
  if (v < 1000) return Math.round(v) + ' ms';
  if (v < 60000) return (Math.round(v / 100) / 10).toFixed(1) + ' s';
  const s = Math.round(v / 1000);
  return Math.floor(s / 60) + ' m ' + (s % 60) + ' s';
}

export function formatCount(n, locale = 'en') {
  try { return Number(n).toLocaleString(locale); } catch { return String(n); }
}

/** Whole seconds elapsed between two epoch-ms values (never negative). */
export function elapsedSeconds(since, now) {
  if (typeof since !== 'number' || typeof now !== 'number') return 0;
  return Math.max(0, Math.floor((now - since) / 1000));
}

export function baseName(p) {
  const parts = String(p || '').replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(p || '');
}

/** Command line of a command tool, if its input exposes one. */
export function commandOf(m) {
  return str(m && m.input, CMD_KEYS);
}

function shorten(s, n = 70) {
  const one = String(s).replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '...' : one;
}

/** Change attached to a tool card: the backend's file-change, else a diff derived from the tool input (claude). */
export function changeOf(m) {
  if (!m || m.role !== 'tool') return null;
  if (m.change) return m.change;
  const kind = kindOf(m);
  if ((kind === 'edit' || kind === 'write') && m.status !== 'error') return diffFromInput(kind, m.input);
  return null;
}

/** Path of a tool card shown to the user: project-relative with forward slashes when possible. */
export function displayPath(m, root) {
  const ch = changeOf(m);
  const raw = (ch && ch.path) || str(m && m.input, PATH_KEYS);
  if (!raw) return '';
  const rel = root ? relativeTo(root, raw) : null;
  return rel || String(raw).replace(/\\/g, '/');
}

/**
 * Human title descriptor for a tool card: { key, vars } (i18n key 'act.title.*') or null for the generic card.
 */
export function toolTitle(m, root) {
  const kind = kindOf(m);
  const running = m.status === 'running';
  const ch = changeOf(m);
  const path = displayPath(m, root);
  const file = path ? baseName(path) : '';
  if (kind === 'command') {
    const cmd = commandOf(m);
    return cmd ? { key: running ? 'act.title.running' : 'act.title.ran', vars: { cmd: shorten(cmd) } } : { key: running ? 'act.title.runningNoCmd' : 'act.title.ranNoCmd', vars: {} };
  }
  if (kind === 'write' || kind === 'edit') {
    if (ch && ch.op === 'delete') return { key: 'act.title.deleted', vars: { file } };
    if (ch ? ch.op === 'create' : kind === 'write') return { key: running ? 'act.title.creating' : 'act.title.created', vars: { file: file || '?' } };
    return { key: running ? 'act.title.editing' : 'act.title.edited', vars: { file: file || '?' } };
  }
  if (kind === 'read') return file ? { key: running ? 'act.title.reading' : 'act.title.read', vars: { file } } : { key: running ? 'act.title.readingNoFile' : 'act.title.readNoFile', vars: {} };
  if (kind === 'search') {
    const q = str(m.input, QUERY_KEYS);
    return q ? { key: running ? 'act.title.searching' : 'act.title.searched', vars: { query: shorten(q, 50) } } : { key: running ? 'act.title.searchingNoQuery' : 'act.title.searchedNoQuery', vars: {} };
  }
  if (kind === 'list') return file ? { key: running ? 'act.title.listing' : 'act.title.listed', vars: { dir: file } } : { key: running ? 'act.title.listingNoDir' : 'act.title.listedNoDir', vars: {} };
  return null;
}

/** All tool/thinking/answer messages of one turn, in order. */
export function turnMessages(messages, turnId) {
  return (messages || []).filter((m) => m && m.turn === turnId && m.role !== 'user');
}

/**
 * Statistics for a set of messages (usually one turn):
 * { files: [{ path, added, removed, op, ids }], added, removed, commands, failed, thinkingMs, thinkingTokens, tools }.
 */
export function turnStats(messages, root) {
  const files = new Map();
  const st = { files: [], added: 0, removed: 0, commands: 0, failed: 0, thinkingMs: 0, thinkingTokens: 0, tools: 0 };
  for (const m of messages || []) {
    if (!m) continue;
    if (m.role === 'thinking') { st.thinkingMs += m.durationMs || 0; st.thinkingTokens += m.tokens || 0; continue; }
    if (m.role !== 'tool') continue;
    st.tools++;
    if (m.status === 'blocked') continue; // never ran: not counted as work done
    const kind = kindOf(m);
    if (kind === 'command') {
      st.commands++;
      if (m.status === 'error' || (typeof m.exitCode === 'number' && m.exitCode !== 0)) st.failed++;
    }
    const ch = (kind === 'edit' || kind === 'write') ? changeOf(m) : null;
    if (ch && ch.path) {
      const norm = String(ch.path).replace(/\\/g, '/');
      const key = (root && relativeTo(root, norm)) || norm;
      const f = files.get(key) || { path: key, added: 0, removed: 0, op: ch.op, ids: [] };
      f.added += ch.added || 0;
      f.removed += ch.removed || 0;
      if (ch.op === 'create') f.op = 'create';
      f.ids.push(m.id);
      files.set(key, f);
      st.added += ch.added || 0;
      st.removed += ch.removed || 0;
    }
  }
  st.files = [...files.values()];
  return st;
}

/** True when a turn summary is worth showing. */
export function hasActivity(stats) {
  return !!(stats && (stats.files.length || stats.commands || stats.thinkingMs || stats.thinkingTokens));
}

/**
 * Chronological rows for the Activity tab:
 * [{ id, type: 'thinking'|'tool'|'answer', toolKind, title: {key,vars}|null, name, offsetMs, durationMs, status, exitCode }].
 */
export function buildTimeline(messages, turn, root) {
  const t0 = turn && typeof turn.startedAt === 'number' ? turn.startedAt : null;
  const rows = [];
  for (const m of messages || []) {
    if (!m) continue;
    const offsetMs = t0 != null && typeof m.at === 'number' ? Math.max(0, m.at - t0) : null;
    if (m.role === 'thinking') rows.push({ id: m.id, type: 'thinking', offsetMs, durationMs: m.durationMs || 0, tokens: m.tokens || 0, status: 'done' });
    else if (m.role === 'tool') {
      rows.push({
        id: m.id, type: 'tool', toolKind: kindOf(m), title: toolTitle(m, root), name: m.name, offsetMs,
        durationMs: m.durationMs != null ? m.durationMs : null, status: m.status, exitCode: typeof m.exitCode === 'number' ? m.exitCode : null,
      });
    } else if (m.role === 'assistant' && m.text) rows.push({ id: m.id, type: 'answer', offsetMs, durationMs: null, status: 'done' });
  }
  return rows;
}

/** Commands of a turn: [{ id, command, exitCode, status, durationMs }]. */
export function commandList(messages) {
  return (messages || []).filter((m) => m && m.role === 'tool' && kindOf(m) === 'command').map((m) => ({
    id: m.id, command: commandOf(m) || m.name, exitCode: typeof m.exitCode === 'number' ? m.exitCode : null, status: m.status, durationMs: m.durationMs != null ? m.durationMs : null,
  }));
}

/**
 * Live status of a running chat: { key: 'thinking'|'tool'|'writing', title, name, since, id }.
 * `since` is when that phase started (epoch ms) when the reducer was given a clock, else null.
 */
export function livePhase(chat, root) {
  const turn = chat && chat.turn ? chat.turn : {};
  const msgs = chat && chat.messages ? chat.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role === 'tool' && m.status === 'running') {
      return { key: 'tool', title: toolTitle(m, root), cmd: shorten(commandOf(m), 60), name: m.name, since: typeof m.startedAt === 'number' ? m.startedAt : turn.lastEventAt ?? null, id: m.id };
    }
    if (m.role === 'assistant' && m.open && m.text) return { key: 'writing', title: null, name: '', since: turn.lastEventAt ?? null, id: m.id };
    if (m.role === 'user' || m.role === 'tool' || m.role === 'assistant' || m.role === 'thinking') break;
  }
  return { key: 'thinking', title: null, name: '', since: turn.lastEventAt ?? null, id: '' };
}
