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
//   { type: 'error',       kind: 'auth'|'api'|'process'|'parse', message, stderr?, code? }
// Backend extras: session.warning === 'always-proceed' (agy); result.stopped === true (user pressed stop);
// permission-denied { id, tool, reason, message }; rate-limit { status, windows }.

// Phase 5 additions (rich activity view):
//   tool-use    gains `kind`: 'command'|'edit'|'write'|'read'|'search'|'list'|'other'   (classifyTool below)
//   tool-result gains `kind`, `durationMs`; for command tools also `exitCode` (number|null) and `commandOutput` (header-stripped text)
//   { type: 'thinking',    id?, durationMs?, tokens?, outputTokens?, text? }   agy: only timing/token counts (it never streams reasoning text);
//                                                                           claude: `text` when a thinking block is present
//   { type: 'file-change', id, path, op:'create'|'modify'|'delete', added, removed, diff, truncated }
//        emitted by main (src/main/changes.js) after an edit/write tool finishes: `path` is project-relative with forward slashes,
//        `diff` is a unified diff with 3 lines of context (empty for binary/oversized files), `id` equals the tool-use id.

export const EVENT_TYPES = Object.freeze([
  'session', 'text-delta', 'text', 'thinking', 'tool-use', 'tool-result', 'file-change', 'permission-request', 'permission-denied',
  'rate-limit', 'result', 'error',
]);

const TOOL_KINDS = {
  command: /^(bash|powershell|run_command|command_status|send_command_input|execute_command)$/i,
  edit: /^(edit|multiedit|notebookedit|edit_file|replace_file_content|multi_replace_file_content|sed_file|apply_patch)$/i,
  write: /^(write|write_file|write_to_file|create_file)$/i,
  read: /^(read|view_file|read_file|read_url_content|read_resource|webfetch)$/i,
  search: /^(grep|glob|grep_search|find_by_name|websearch|search_web|search_marketplace)$/i,
  list: /^(ls|list_dir|list_directory)$/i,
};

/** Classify a tool name (claude or agy) so the UI can pick a renderer. */
export function classifyTool(_agent, name) {
  const n = String(name ?? '');
  for (const [kind, re] of Object.entries(TOOL_KINDS)) if (re.test(n)) return kind;
  return 'other';
}

/** Candidate file paths in a tool's input (claude: file_path; agy: Path / TargetFile / AbsolutePath ...). */
export function toolPaths(input) {
  if (!input || typeof input !== 'object') return [];
  const keys = ['file_path', 'filePath', 'path', 'Path', 'TargetFile', 'targetFile', 'AbsolutePath', 'notebook_path', 'FilePath'];
  return keys.map((k) => input[k]).filter((v) => typeof v === 'string' && v.length > 0 && v.length < 1024);
}

/** agy run_command output: "Created At..\nCompleted At..\nCommand exited with code N.\n\nCommand output:\n<text>". */
export function parseAgyCommandOutput(output) {
  const t = String(output ?? '');
  const m = /Command exited with code (-?\d+)/.exec(t);
  const idx = t.indexOf('Command output:');
  const body = idx >= 0 ? t.slice(idx + 'Command output:'.length).replace(/^\r?\n/, '') : t;
  return { exitCode: m ? Number(m[1]) : null, commandOutput: body.replace(/\r\n/g, '\n').replace(/\n+$/, '') };
}

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
      else if (c.type === 'thinking' && c.thinking) out.push({ type: 'thinking', text: c.thinking });
      else if (c.type === 'tool_use') out.push({ type: 'tool-use', id: c.id, name: c.name, kind: classifyTool('claude', c.name), input: c.input });
    }
  } else if (j.type === 'user') {
    for (const c of Array.isArray(j.message?.content) ? j.message.content : []) {
      if (c.type === 'tool_result') {
        const output = typeof c.content === 'string' ? c.content : JSON.stringify(c.content);
        out.push({ type: 'tool-result', id: c.tool_use_id, output, isError: !!c.is_error });
      }
    }
  } else if (j.type === 'system' && j.subtype === 'permission_denied') {
    // Real capture: headless default mode auto-denies writes (reasons: safetyCheck, workingDir).
    out.push({ type: 'permission-denied', id: j.tool_use_id, tool: j.tool_name, reason: j.decision_reason_type, message: j.message });
  } else if (j.type === 'rate_limit_event') {
    out.push({ type: 'rate-limit', status: j.rate_limit_info?.status, windows: j.rate_limit_info?.unifiedWindows });
  } else if (j.type === 'control_request'&& j.request?.subtype === 'can_use_tool') {
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
    if (s.step_type === 'agent_response') {
      if (s.state === 'ACTIVE' && s.text_delta) out.push({ type: 'text-delta', text: s.text_delta });
      // DONE carries only a trailing newline; the stream already delivered the text. But AGY never streams its
      // reasoning text, only how long each model step took and how many thinking tokens it used: surface that.
      if (s.state === 'DONE' && s.usage && (s.usage.thinking_tokens > 0 || s.duration_seconds >= 1)) {
        out.push({ type: 'thinking', id, durationMs: Math.round((s.duration_seconds ?? 0) * 1000), tokens: s.usage.thinking_tokens ?? 0, outputTokens: s.usage.output_tokens ?? 0 });
      }
    } else if (s.step_type === 'tool') {
      const kind = classifyTool('agy', s.tool_name);
      if (s.state === 'ACTIVE') out.push({ type: 'tool-use', id, name: s.tool_name, kind, input: s.tool_info?.parameters });
      else if (s.state === 'DONE') {
        const ev = { type: 'tool-result', id, name: s.tool_name, kind, output: s.tool_info?.output, durationMs: Math.round((s.duration_seconds ?? 0) * 1000) };
        if (kind === 'command') Object.assign(ev, parseAgyCommandOutput(s.tool_info?.output));
        out.push(ev);
      }
    }
    // step_type 'user_input' and 'system_message' carry no content in the stream: ignored.
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
