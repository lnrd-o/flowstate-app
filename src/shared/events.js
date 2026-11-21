// FlowState normalised event contract (DRAFT v0, frozen at end of Phase 0).
// Every agent adapter maps its CLI's native stream-json into these events; the renderer only sees these.
//
//   { type: 'session',     sessionId, model?, permissionMode?, tools? }
//   { type: 'text-delta',  text }
//   { type: 'text',        text }                      full message (no partial streaming available)
//   { type: 'tool-use',    id, name, input }
//   { type: 'tool-result', id, name?, output?, isError? }
//   { type: 'permission-request', id, tool, input }    UNVERIFIED for claude (control_request), see docs/spikes.md
//   { type: 'result',      ok, text?, costUsd?, durationMs?, usage? }
//   { type: 'error',       kind: 'auth'|'api'|'process'|'parse', message }

export const EVENT_TYPES = Object.freeze([
  'session', 'text-delta', 'text', 'tool-use', 'tool-result', 'permission-request', 'result', 'error',
]);

/** Map one parsed claude stream-json object to zero or more normalised events. */
export function normalizeClaude(j) {
  const out = [];
  if (!j || typeof j !== 'object') return out;

  if (j.type === 'system' && j.subtype === 'init') {
    out.push({ type: 'session', sessionId: j.session_id, model: j.model, permissionMode: j.permissionMode, tools: j.tools });
  } else if (j.type === 'stream_event') {
    // Only present with --include-partial-messages.
    const d = j.event?.delta;
    if (j.event?.type === 'content_block_delta' && d?.type === 'text_delta') out.push({ type: 'text-delta', text: d.text });
  } else if (j.type === 'assistant') {
    if (j.error === 'authentication_failed') {
      const text = j.message?.content?.find((c) => c.type === 'text')?.text;
      out.push({ type: 'error', kind: 'auth', message: text || 'Authentication failed' });
      return out;
    }
    for (const c of j.message?.content ?? []) {
      if (c.type === 'text' && c.text) out.push({ type: 'text', text: c.text });
      else if (c.type === 'tool_use') out.push({ type: 'tool-use', id: c.id, name: c.name, input: c.input });
    }
  } else if (j.type === 'user') {
    for (const c of Array.isArray(j.message?.content) ? j.message.content : []) {
      if (c.type === 'tool_result') {
        const output = typeof c.content === 'string' ? c.content : JSON.stringify(c.content);
        out.push({ type: 'tool-result', id: c.tool_use_id, output, isError: !!c.is_error });
      }
    }
  } else if (j.type === 'control_request' && j.request?.subtype === 'can_use_tool') {
    out.push({ type: 'permission-request', id: j.request_id, tool: j.request.tool_name, input: j.request.input });
  } else if (j.type === 'result') {
    out.push({
      type: 'result', ok: !j.is_error, text: j.result, costUsd: j.total_cost_usd, durationMs: j.duration_ms, usage: j.usage,
    });
  }
  return out;
}

/** Map one parsed agy stream-json object to zero or more normalised events. */
export function normalizeAgy(j) {
  const out = [];
  if (!j || typeof j !== 'object') return out;

  if (j.event === 'init') {
    out.push({ type: 'session', sessionId: j.conversation_id, permissionMode: j.init?.permission_mode, tools: j.init?.tools });
  } else if (j.event === 'step_update') {
    const s = j.step_update;
    const id = `${s.conversation_id}:${s.step_index}`;
    if (s.step_type === 'agent_response' && s.text_delta) {
      if (s.state === 'ACTIVE') out.push({ type: 'text-delta', text: s.text_delta });
      // DONE carries only a trailing newline; the stream already delivered the text.
    } else if (s.step_type === 'tool') {
      if (s.state === 'ACTIVE') out.push({ type: 'tool-use', id, name: s.tool_name, input: s.tool_info?.parameters });
      else if (s.state === 'DONE') out.push({ type: 'tool-result', id, name: s.tool_name, output: s.tool_info?.output });
    }
  } else if (j.event === 'result') {
    const r = j.result ?? {};
    out.push({ type: 'result', ok: r.status === 'SUCCESS', text: r.response, durationMs: (r.duration_seconds ?? 0) * 1000, usage: r.usage });
  }
  return out;
}

export const NORMALIZERS = Object.freeze({ claude: normalizeClaude, agy: normalizeAgy });

/** Split a stdout chunk stream into JSON objects (NDJSON). Keeps partial lines between calls. */
export function createNdjsonParser(onObject, onBadLine) {
  let buf = '';
  return (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try { onObject(JSON.parse(line)); } catch { onBadLine?.(line); }
    }
  };
}
