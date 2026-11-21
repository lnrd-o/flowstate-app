// Pure reducer: normalised agent events -> chat state. No DOM, unit-tested.
//
// Chat state: { messages, running, seq, turnHadText, needsAuth, alwaysProceed, lastPrompt, rateLimited }
// Message kinds (m.role):
//   user        { id, role, text }
//   assistant   { id, role, text, open, fromDelta }
//   tool        { id, role, toolId, name, input, summary, output, status: 'running'|'done'|'error' }
//   permission  { id, role, kind: 'denied'|'request', toolId, tool, reason, message, input, status: 'pending'|'approved'|'denied' }
//   error       { id, role, kind, message, stderr }
//   system      { id, role, key?, text? }       key is an i18n key rendered by the UI

const MAX_OUTPUT = 20000;

export function createChatState() {
  return {
    messages: [], running: false, seq: 0, turnHadText: false,
    needsAuth: false, alwaysProceed: false, rateLimited: false, lastPrompt: null,
  };
}

function nextId(state) {
  return { id: 'm' + (state.seq + 1), seq: state.seq + 1 };
}

function push(state, msg) {
  const { id, seq } = nextId(state);
  return { ...state, seq, messages: [...state.messages, { id, ...msg }] };
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

function clip(s) {
  const str = typeof s === 'string' ? s : s == null ? '' : JSON.stringify(s, null, 2);
  return str.length > MAX_OUTPUT ? str.slice(0, MAX_OUTPUT) + '\n...' : str;
}

/** One-line summary of a tool input for the tool card header. */
export function summarizeTool(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  const v = i.file_path ?? i.path ?? i.command ?? i.pattern ?? i.url ?? i.query ?? i.description ?? i.prompt ?? '';
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s.length > 140 ? s.slice(0, 137) + '...' : s;
}

/** Add the user's prompt and mark the turn as running. */
export function addUserMessage(state, text) {
  const s = closeOpenAssistant(state);
  const next = push(s, { role: 'user', text: String(text ?? '') });
  return { ...next, running: true, turnHadText: false, lastPrompt: String(text ?? ''), needsAuth: false };
}

/** Mark a permission card as approved / denied (UI action, not an agent event). */
export function resolvePermission(state, id, status) {
  const i = state.messages.findIndex((m) => m.id === id);
  if (i < 0) return state;
  return replaceAt(state, i, { ...state.messages[i], status });
}

/** Local failure (e.g. agent.send rejected): show an error and stop the running flag. */
export function failTurn(state, message) {
  const s = closeOpenAssistant(state);
  return { ...push(s, { role: 'error', kind: 'process', message: String(message || ''), stderr: '' }), running: false };
}

export function reduceEvent(state, ev) {
  if (!ev || typeof ev !== 'object') return state;
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
      const i = state.messages.length - 1;
      const last = state.messages[i];
      // Authoritative full text after streamed deltas: replace instead of duplicating.
      if (last && last.role === 'assistant' && last.fromDelta) {
        return { ...replaceAt(state, i, { ...last, text, open: false }), turnHadText: true };
      }
      if (!text) return state;
      return { ...push(state, { role: 'assistant', text, open: false, fromDelta: false }), turnHadText: true };
    }
    case 'tool-use': {
      let s = closeOpenAssistant(state);
      const idx = s.messages.findIndex((m) => m.role === 'tool' && m.toolId === ev.id);
      const card = {
        role: 'tool', toolId: ev.id, name: ev.name || 'tool', input: ev.input ?? null,
        summary: summarizeTool(ev.name, ev.input), output: '', status: 'running',
      };
      if (idx >= 0) return replaceAt(s, idx, { ...s.messages[idx], ...card, output: s.messages[idx].output });
      return push(s, card);
    }
    case 'tool-result': {
      const idx = state.messages.findIndex((m) => m.role === 'tool' && m.toolId === ev.id);
      const status = ev.isError ? 'error' : 'done';
      if (idx < 0) {
        const s = closeOpenAssistant(state);
        return push(s, {
          role: 'tool', toolId: ev.id, name: ev.name || 'tool', input: null, summary: '',
          output: clip(ev.output), status,
        });
      }
      const cur = state.messages[idx];
      return replaceAt(state, idx, { ...cur, name: cur.name || ev.name || 'tool', output: clip(ev.output), status });
    }
    case 'permission-denied':
    case 'permission-request': {
      if (state.messages.some((m) => m.role === 'permission' && m.toolId === ev.id && ev.id != null)) return state;
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
    case 'result': {
      let s = closeOpenAssistant(state);
      if (!s.turnHadText && ev.ok !== false && ev.text) {
        s = push(s, { role: 'assistant', text: String(ev.text), open: false, fromDelta: false });
      }
      if (ev.stopped) s = push(s, { role: 'system', key: 'chat.stopped' });
      else if (ev.ok === false) s = push(s, { role: 'error', kind: 'api', message: ev.text || '', stderr: '' });
      return { ...s, running: false };
    }
    case 'error': {
      const s = closeOpenAssistant(state);
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
