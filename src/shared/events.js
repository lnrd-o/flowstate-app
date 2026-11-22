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

// Phase 7 additions (usage, limits, agent task lists):
//   { type: 'rate-limit', status, windows, ... }  (existing) now ALSO carries `windows.five_hour|seven_day = {utilization:0..1, resetsAt:ms, status}`
//   { type: 'limit', agent, kind:'five_hour'|'seven_day'|'quota'|'unknown', status:'warning'|'rejected', resetsAt?:ms, utilization?, message? }
//        a usage limit warning/hit. `message` is the CLI/model's OWN text (e.g. "You've hit your limit - resets 3pm") and must be shown verbatim.
//        claude: from rate_limit_event (status allowed_warning|rejected) and from assistant API-error messages whose error is
//        'rate_limit' or whose text says usage limit / resets; agy: from error/result text such as 'Usage limit reached', 'out of quota until <time>',
//        QUOTA_EXHAUSTED, RESOURCE_EXHAUSTED, RATE_LIMITED.
//   { type: 'todos', items:[{content, status:'pending'|'in_progress'|'completed'}] }   the agent's own task list (claude TodoWrite)
//   { type: 'subagent', id, name, description?, state:'running'|'done'|'error' }       claude Task tool / agy invoke_subagent

export const EVENT_TYPES = Object.freeze([
  'session', 'text-delta', 'text', 'thinking', 'tool-use', 'tool-result', 'file-change', 'permission-request', 'permission-denied',
  'rate-limit', 'limit', 'todos', 'subagent', 'result', 'error',
]);

const LIMIT_TEXT = /(usage|rate|message) limit|limit reached|hit your limit|out of (quota|credits|tokens)|quota[_ ](exhausted|exceeded)|resource[_ ]exhausted|rate[_ ]limited|resets? (at|in|on)|try again (at|in|after)/i;
/** True when a CLI/model text looks like a usage-limit message. */
export function looksLikeLimitText(text) { return LIMIT_TEXT.test(String(text ?? '')); }

const LIMIT_KIND = { five_hour: 'five_hour', seven_day: 'seven_day', seven_day_opus: 'seven_day', seven_day_sonnet: 'seven_day', overage: 'quota' };

/** Best-effort extraction of "resets <time>" hints from limit text -> ms epoch (undefined when not parseable). */
export function parseResetFromText(text, now = Date.now()) {
  const t = String(text ?? '');
  const iso = /\b(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})?)/.exec(t);
  if (iso) { const ms = Date.parse(iso[1]); if (Number.isFinite(ms)) return ms; }
  const epoch = /\|(\d{10})\b/.exec(t); // claude legacy "Claude AI usage limit reached|<epoch seconds>"
  if (epoch) return Number(epoch[1]) * 1000;
  const hm = /\bin\s+(\d+)\s*h\w*(?:\s*(\d+)\s*m\w*)?/i.exec(t); // "in 2h 30m", "in 2 hours"
  if (hm) return now + (Number(hm[1]) * 60 + Number(hm[2] || 0)) * 60000;
  const m = /\bin\s+(\d+)\s*m\w*/i.exec(t); // "in 45 minutes"
  if (m) return now + Number(m[1]) * 60000;
  return undefined;
}

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
    if (j.error && j.is_api_error_message !== false) {
      // API-level error rendered by the CLI as an assistant message (e.g. error: 'rate_limit'): keep the CLI's own text.
      const text = j.message?.content?.find((c) => c.type === 'text')?.text ?? '';
      if (j.error === 'rate_limit' || looksLikeLimitText(text)) {
        out.push({ type: 'limit', agent: 'claude', kind: 'unknown', status: 'rejected', resetsAt: parseResetFromText(text), message: text || 'Usage limit reached' });
        return out;
      }
    }
    for (const c of j.message?.content ?? []) {
      if (c.type === 'text' && c.text) out.push({ type: 'text', text: c.text });
      else if (c.type === 'thinking' && c.thinking) out.push({ type: 'thinking', text: c.thinking });
      else if (c.type === 'tool_use') {
        out.push({ type: 'tool-use', id: c.id, name: c.name, kind: classifyTool('claude', c.name), input: c.input });
        if (c.name === 'TodoWrite' && Array.isArray(c.input?.todos)) {
          out.push({
            type: 'todos',
            items: c.input.todos.filter((t) => t && typeof t.content === 'string').slice(0, 100)
              .map((t) => ({ content: t.content, status: ['pending', 'in_progress', 'completed'].includes(t.status) ? t.status : 'pending' })),
          });
        } else if (c.name === 'Task') {
          out.push({ type: 'subagent', id: c.id, name: String(c.input?.subagent_type ?? 'agent'), description: c.input?.description, state: 'running' });
        }
      }
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
    const info = j.rate_limit_info ?? {};
    out.push({ type: 'rate-limit', status: info.status, windows: info.unifiedWindows });
    if (info.status && info.status !== 'allowed') {
      // allowed_warning = approaching the limit, rejected = limit hit. rateLimitType names the window that triggered it.
      out.push({
        type: 'limit', agent: 'claude', kind: LIMIT_KIND[info.rateLimitType] ?? 'unknown',
        status: info.status === 'rejected' ? 'rejected' : 'warning',
        resetsAt: Number.isFinite(info.resetsAt) ? info.resetsAt * 1000 : undefined,
        utilization: typeof info.utilization === 'number' ? info.utilization : undefined,
      });
    }
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
      if (s.state === 'ACTIVE') {
        out.push({ type: 'tool-use', id, name: s.tool_name, kind, input: s.tool_info?.parameters });
        if (s.tool_name === 'invoke_subagent') {
          const p = s.tool_info?.parameters ?? {};
          out.push({ type: 'subagent', id, name: String(p.Name ?? p.name ?? p.AgentName ?? 'subagent'), description: p.Task ?? p.task ?? p.Prompt, state: 'running' });
        }
      }
      else if (s.state === 'DONE') {
        const ev = { type: 'tool-result', id, name: s.tool_name, kind, output: s.tool_info?.output, durationMs: Math.round((s.duration_seconds ?? 0) * 1000) };
        if (kind === 'command') Object.assign(ev, parseAgyCommandOutput(s.tool_info?.output));
        out.push(ev);
      }
    }
    // step_type 'user_input' and 'system_message' carry no content in the stream: ignored.
  } else if (j.event === 'result') {
    const r = j.result ?? {};
    const ok = r.status === 'SUCCESS';
    const blob = [r.response, r.error, r.message, r.status].filter((x) => typeof x === 'string').join(' ');
    // agy reports quota problems as a failed result / error text ('Usage limit reached', 'out of quota until <time>', QUOTA_EXHAUSTED ...)
    if (!ok && looksLikeLimitText(blob)) {
      out.push({ type: 'limit', agent: 'agy', kind: 'quota', status: 'rejected', resetsAt: parseResetFromText(blob), message: String(r.response ?? r.error ?? r.message ?? r.status) });
    }
    out.push({ type: 'result', ok, text: r.response, durationMs: (r.duration_seconds ?? 0) * 1000, usage: r.usage });
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
