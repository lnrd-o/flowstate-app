// Pure reducer: normalised agent events -> chat state. No DOM, unit-tested.
//
// Chat state: { messages, running, seq, turnHadText, needsAuth, alwaysProceed, lastPrompt, rateLimited, turn }
//   turn = { id, agent, startedAt, lastEventAt, endedAt }   timestamps only when the caller passes { now } (live events, history ts)
// Every message carries { turn: turn id, agent?: agent that produced the turn, at?: epoch ms }.
// Message kinds (m.role):
//   user        { id, role, text }
//   assistant   { id, role, text, open, fromDelta }
//   tool        { id, role, toolId, name, kind, input, summary, output, status: 'running'|'done'|'error'|'blocked', blocked?: { reason, message }, startedAt?, endedAt?,
//                 durationMs?, exitCode?, commandOutput?, change? }     change = { path, op, added, removed, diff, truncated }
//   thinking    { id, role, durationMs, tokens, outputTokens, text, steps }
//   summary     { id, role }                    marker after the final text of a turn that did something (stats computed from the turn)
//   permission  { id, role, kind: 'denied'|'request', toolId, tool, reason, message, input, status: 'pending'|'approved'|'denied' }
//               (only for denied actions that have no tool card; the approval card lists them with the blocked tool cards)
//   approval    { id, role, status: 'pending'|'allowed'|'dismissed' }   one per turn that ended with blocked actions (items are derived
//               from the turn: tool cards with status 'blocked' + pending permission messages)
//   error       { id, role, kind, message, stderr }
//   system      { id, role, key?, text? }       key is an i18n key rendered by the UI
//   limit       { id, role, agent, kind, status:'warning'|'rejected', resetsAt?, utilization?, message? }   usage limit card (one per kind/status per turn)
// user messages may carry images: [rel] (attachment paths inside <project>/.flowstate/attachments).
// 'todos' and 'subagent' events never create messages: they fill state.todos (agent task list) and state.subagents.

import { classifyTool, looksLikeLimitText } from '../../shared/events.js';
import { turnMessages, turnStats, hasActivity } from './activity.js';
import { classifyBlocked, blockedItems, reasonOf } from './approvals.js';

const MAX_OUTPUT = 20000;
const MAX_COMMAND_OUTPUT = 60000;

export function createChatState() {
  return {
    messages: [], running: false, seq: 0, turnHadText: false,
    needsAuth: false, alwaysProceed: false, rateLimited: false, lastPrompt: null, todos: [], subagents: [],
    turn: { id: 0, agent: null, startedAt: null, lastEventAt: null, endedAt: null },
  };
}

function nextId(state) {
  return { id: 'm' + (state.seq + 1), seq: state.seq + 1 };
}

function push(state, msg) {
  const { id, seq } = nextId(state);
  const extra = { turn: state.turn.id };
  if (state.turn.agent) extra.agent = state.turn.agent;
  return { ...state, seq, messages: [...state.messages, { id, ...extra, ...msg }] };
}

function replaceAt(state, index, msg) {
  const messages = state.messages.slice();
  messages[index] = msg;
  return { ...state, messages };
}

function closeOpenAssistant(state) {
  const i = state.messages.length - 1;
  const last = state.messages[i];
  if (last && last.role === 'assistant' && last.open) return replaceAt(state, i, { ...last, open: false });
  return state;
}

function clip(s, max = MAX_OUTPUT) {
  const str = typeof s === 'string' ? s : s == null ? '' : JSON.stringify(s, null, 2);
  return str.length > max ? str.slice(0, max) + '\n...' : str;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

/** One-line summary of a tool input for the tool card header. */
export function summarizeTool(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  const v = i.file_path ?? i.path ?? i.command ?? i.CommandLine ?? i.TargetFile ?? i.AbsolutePath ?? i.pattern ?? i.url ?? i.query ?? i.description ?? i.prompt ?? '';
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s.length > 140 ? s.slice(0, 137) + '...' : s;
}

/**
 * Add the user's prompt and mark the turn as running.
 * opts: { agent, now } - the agent that will answer (labels the turn) and the clock.
 */
export function addUserMessage(state, text, opts) {
  const o = opts || {};
  const s = closeOpenAssistant(state);
  const now = typeof o.now === 'number' ? o.now : null;
  const turn = { id: s.turn.id + 1, agent: o.agent || null, startedAt: now, lastEventAt: now, endedAt: null };
  const images = Array.isArray(o.images) ? o.images.filter((r) => typeof r === 'string' && r) : [];
  const next = push({ ...s, turn }, { role: 'user', text: String(text ?? ''), ...(images.length ? { images } : {}), ...(now != null ? { at: now } : {}) });
  return { ...next, running: true, turnHadText: false, lastPrompt: String(text ?? ''), needsAuth: false };
}

/** Mark a permission card as approved / denied (UI action, not an agent event). */
export function resolvePermission(state, id, status) {
  const i = state.messages.findIndex((m) => m.id === id);
  if (i < 0) return state;
  return replaceAt(state, i, { ...state.messages[i], status });
}

/** Append a small system note (i18n key) to the chat, e.g. after the user declined an approval. */
export function addSystemNote(state, key) {
  return push(closeOpenAssistant(state), { role: 'system', key });
}

/** Local failure (e.g. agent.send rejected): show an error and stop the running flag. */
export function failTurn(state, message) {
  const s = closeOpenAssistant(state);
  return { ...push(s, { role: 'error', kind: 'process', message: String(message || ''), stderr: '' }), running: false };
}

/** Did a usage limit already get rejected in this turn? Then the matching generic error would only repeat it. */
function turnHasLimit(state) {
  return state.messages.some((m) => m.role === 'limit' && m.turn === state.turn.id && m.status === 'rejected');
}

function findTool(state, id) {
  return id == null ? -1 : state.messages.findIndex((m) => m.role === 'tool' && m.toolId === id);
}

/**
 * Reduce one normalised event. opts.now (epoch ms) is optional: when present messages get `at`, tool cards get
 * startedAt/endedAt and the turn tracks lastEventAt (used for the live status line and the timeline).
 */
export function reduceEvent(state, ev, opts) {
  if (!ev || typeof ev !== 'object') return state;
  const now = opts && typeof opts.now === 'number' ? opts.now : null;
  const next = reduceCore(state, ev, now);
  if (next === state || now == null) return next;
  let out = next;
  if (next.messages.length > state.messages.length) {
    const messages = next.messages.slice();
    for (let i = state.messages.length; i < messages.length; i++) if (messages[i].at == null) messages[i] = { ...messages[i], at: now };
    out = { ...out, messages };
  }
  return { ...out, turn: { ...out.turn, lastEventAt: now, endedAt: ev.type === 'result' ? now : out.turn.endedAt } };
}

function reduceCore(state, ev, now) {
  switch (ev.type) {
    case 'session': {
      let s = { ...state, needsAuth: false };
      if (ev.warning === 'always-proceed') s = { ...s, alwaysProceed: true };
      return s;
    }
    case 'text-delta': {
      const text = String(ev.text ?? '');
      if (!text) return state;
      const i = state.messages.length - 1;
      const last = state.messages[i];
      if (last && last.role === 'assistant' && last.open) {
        return { ...replaceAt(state, i, { ...last, text: last.text + text }), turnHadText: true };
      }
      return { ...push(state, { role: 'assistant', text, open: true, fromDelta: true }), turnHadText: true };
    }
    case 'text': {
      const text = String(ev.text ?? '');
      // Authoritative full text after streamed deltas: replace instead of duplicating (thinking rows may sit in between).
      let i = state.messages.length - 1;
      while (i >= 0 && state.messages[i].role === 'thinking') i--;
      const last = state.messages[i];
      if (last && last.role === 'assistant' && last.fromDelta) {
        return { ...replaceAt(state, i, { ...last, text, open: false }), turnHadText: true };
      }
      if (!text) return state;
      return { ...push(state, { role: 'assistant', text, open: false, fromDelta: false }), turnHadText: true };
    }
    case 'thinking': {
      const s = closeOpenAssistant(state);
      const durationMs = num(ev.durationMs);
      const tokens = num(ev.tokens);
      const outputTokens = num(ev.outputTokens);
      const text = typeof ev.text === 'string' ? ev.text : '';
      const i = s.messages.length - 1;
      const last = s.messages[i];
      if (last && last.role === 'thinking' && last.turn === s.turn.id) {
        return replaceAt(s, i, {
          ...last, durationMs: last.durationMs + durationMs, tokens: last.tokens + tokens, outputTokens: last.outputTokens + outputTokens,
          text: last.text && text ? last.text + '\n\n' + text : last.text || text, steps: last.steps + 1,
        });
      }
      return push(s, { role: 'thinking', durationMs, tokens, outputTokens, text, steps: 1 });
    }
    case 'tool-use': {
      const s = closeOpenAssistant(state);
      const idx = findTool(s, ev.id);
      const name = ev.name || 'tool';
      const card = {
        role: 'tool', toolId: ev.id, name, kind: ev.kind || classifyTool(null, name), input: ev.input ?? null,
        summary: summarizeTool(name, ev.input), output: '', status: 'running', startedAt: now ?? undefined,
      };
      if (idx >= 0) {
        // A standalone file-change card may already exist: keep what it knows.
        const cur = s.messages[idx];
        return replaceAt(s, idx, { ...cur, ...card, output: cur.output, status: cur.status === 'error' ? 'error' : 'running' });
      }
      return push(s, card);
    }
    case 'tool-result': {
      const idx = findTool(state, ev.id);
      const isCommand = (ev.kind || (idx >= 0 ? state.messages[idx].kind : classifyTool(null, ev.name))) === 'command';
      const exitCode = typeof ev.exitCode === 'number' ? ev.exitCode : null;
      const prevIdx = idx;
      const wasBlocked = prevIdx >= 0 && state.messages[prevIdx].status === 'blocked';
      const cls = ev.isError && exitCode == null && !wasBlocked ? classifyBlocked(ev.output) : { blocked: false };
      const blocked = wasBlocked || cls.blocked;
      const status = blocked ? 'blocked' : ev.isError || (isCommand && exitCode != null && exitCode !== 0) ? 'error' : 'done';
      const extra = {};
      if (cls.blocked) extra.blocked = { reason: cls.reason, message: '' };
      if (typeof ev.durationMs === 'number') extra.durationMs = ev.durationMs;
      if (exitCode != null) extra.exitCode = exitCode;
      if (typeof ev.commandOutput === 'string') extra.commandOutput = clip(ev.commandOutput, MAX_COMMAND_OUTPUT);
      if (now != null) extra.endedAt = now;
      if (idx < 0) {
        const s = closeOpenAssistant(state);
        const kind = ev.kind || classifyTool(null, ev.name);
        return push(s, {
          role: 'tool', toolId: ev.id, name: ev.name || 'tool', kind, input: null, summary: '',
          output: clip(ev.output), status, ...extra,
        });
      }
      const cur = state.messages[idx];
      if (extra.durationMs == null && cur.startedAt != null && now != null) extra.durationMs = Math.max(0, now - cur.startedAt);
      return replaceAt(state, idx, { ...cur, name: cur.name || ev.name || 'tool', kind: ev.kind || cur.kind, output: clip(ev.output), status, ...extra });
    }
    case 'file-change': {
      if (!ev.path || typeof ev.path !== 'string') return state;
      const change = {
        path: ev.path, op: ev.op === 'create' || ev.op === 'delete' ? ev.op : 'modify', added: num(ev.added), removed: num(ev.removed),
        diff: typeof ev.diff === 'string' ? ev.diff : '', truncated: !!ev.truncated,
      };
      const idx = findTool(state, ev.id);
      if (idx >= 0) return replaceAt(state, idx, { ...state.messages[idx], change });
      const s = closeOpenAssistant(state);
      return push(s, {
        role: 'tool', toolId: ev.id, name: 'file-change', kind: change.op === 'create' ? 'write' : 'edit', input: null,
        summary: change.path, output: '', status: 'done', change,
      });
    }
    case 'permission-denied':
    case 'permission-request': {
      if (state.messages.some((m) => m.role === 'permission' && m.toolId === ev.id && ev.id != null)) return state;
      const ti = ev.type === 'permission-denied' ? findTool(state, ev.id) : -1;
      if (ti >= 0) {
        // The blocked tool card becomes the 'blocked' state (amber); the approval card is added when the turn ends.
        const cur = state.messages[ti];
        return replaceAt(state, ti, { ...cur, status: 'blocked', blocked: { reason: reasonOf(ev.reason, ev.message), message: ev.message || '' } });
      }
      const s = closeOpenAssistant(state);
      return push(s, {
        role: 'permission', kind: ev.type === 'permission-denied' ? 'denied' : 'request', toolId: ev.id,
        tool: ev.tool || 'tool', reason: ev.reason || '', message: ev.message || '', input: ev.input ?? null,
        status: 'pending',
      });
    }
    case 'rate-limit': {
      const limited = !!ev.status && ev.status !== 'allowed' && ev.status !== 'allowed_warning';
      if (limited === state.rateLimited) return state;
      return { ...state, rateLimited: limited };
    }
    case 'limit': {
      const s = closeOpenAssistant(state);
      const kind = ['five_hour', 'seven_day', 'quota', 'unknown'].includes(ev.kind) ? ev.kind : 'unknown';
      const status = ev.status === 'warning' ? 'warning' : 'rejected';
      const card = {
        role: 'limit', agent: ev.agent || s.turn.agent || null, kind: kind === 'unknown' ? 'quota' : kind, status,
        ...(Number.isFinite(ev.resetsAt) ? { resetsAt: ev.resetsAt } : {}),
        ...(typeof ev.utilization === 'number' ? { utilization: ev.utilization } : {}),
        ...(typeof ev.message === 'string' && ev.message ? { message: ev.message } : {}),
      };
      // The same limit reported again during the turn refines the existing card (the CLI sends the event, then its own text).
      const i = s.messages.findIndex((m) => m.role === 'limit' && m.turn === s.turn.id && m.status === status);
      if (i >= 0) return replaceAt(s, i, { ...s.messages[i], ...card, kind: s.messages[i].kind === 'quota' ? card.kind : s.messages[i].kind });
      return push(s, card);
    }
    case 'todos': {
      const items = (Array.isArray(ev.items) ? ev.items : []).filter((x) => x && typeof x.content === 'string')
        .map((x) => ({ content: x.content, status: ['pending', 'in_progress', 'completed'].includes(x.status) ? x.status : 'pending' }));
      return { ...state, todos: items };
    }
    case 'subagent': {
      if (ev.id == null) return state;
      const entry = { id: ev.id, name: String(ev.name || 'agent'), description: ev.description || '', state: ['running', 'done', 'error'].includes(ev.state) ? ev.state : 'running' };
      const i = state.subagents.findIndex((x) => x.id === ev.id);
      const subagents = state.subagents.slice();
      if (i >= 0) subagents[i] = { ...subagents[i], ...entry, description: entry.description || subagents[i].description };
      else subagents.push(entry);
      return { ...state, subagents: subagents.slice(-30) };
    }
    case 'result': {
      let s = closeOpenAssistant(state);
      if (!s.turnHadText && ev.ok !== false && ev.text) {
        s = push(s, { role: 'assistant', text: String(ev.text), open: false, fromDelta: false });
      }
      if (ev.stopped) s = push(s, { role: 'system', key: 'chat.stopped' });
      else if (ev.ok === false && !turnHasLimit(s)) s = push(s, { role: 'error', kind: 'api', message: ev.text || '', stderr: '' });
      if (blockedItems(s.messages, s.turn.id).length && !ev.stopped) s = push(s, { role: 'approval', status: 'pending' });
      if (hasActivity(turnStats(turnMessages(s.messages, s.turn.id)))) s = push(s, { role: 'summary' });
      return { ...s, running: false };
    }
    case 'error': {
      const s = closeOpenAssistant(state);
      if (turnHasLimit(s) && looksLikeLimitText(ev.message)) return { ...s, running: false }; // the limit card already says it
      const next = push(s, {
        role: 'error', kind: ev.kind || 'process', message: ev.message || '', stderr: ev.stderr || '',
      });
      const fatal = ev.kind === 'auth' || ev.kind === 'process';
      return { ...next, needsAuth: next.needsAuth || ev.kind === 'auth', running: fatal ? false : next.running };
    }
    default:
      return state;
  }
}
