# Phase 0 spikes — findings

Captured on Windows 11 with `claude.exe` 2.1.328 (bundled in the Claude desktop app) and `agy.exe` (on PATH).
Raw captures stay local in `spikes/captures/` (git-ignored: contain local paths and session ids).
Re-run with `npm run spike:claude` / `npm run spike:agy` (set `CLAUDE_EXE` to the claude path).

## claude.exe
- **Location:** not on PATH. Found at `%LOCALAPPDATA%\Claude-Data\<id>\claude-code\<version>\<hash>\claude.exe` (version- and hash-specific). FlowState must discover it (PATH, `~/.local/bin`, that Claude-Data tree, npm global) and let the user browse to it.
- **Headless protocol works:** `claude -p --output-format stream-json --verbose --input-format stream-json`, prompt sent as one NDJSON user message on stdin:
  `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}`.
- **Events seen:** `system/init` (session_id, model, tools, permissionMode, slash_commands, claude_code_version), `assistant` (message.content blocks), `result` (is_error, result, total_cost_usd, duration_ms, usage, session_id).
- **Flags relevant to FlowState:** `--resume <id>`, `-c`, `--include-partial-messages` (text deltas), `--replay-user-messages`, `--permission-mode`, **`--permission-prompts host|none`** (in print mode, `host` = the SDK host answers via control requests / `--permission-prompt-tool`; `none` = anything that would prompt is auto-denied), **`--remote-control [name]`** (interactive session with Remote Control on), `--add-dir`, `--settings`, `--mcp-config`, `--no-session-persistence`, `--fork-session`.
- **Auth:** `claude auth status` prints JSON (`loggedIn`, `authMethod`, ...). On this machine it reported `loggedIn: false`; a run returned `assistant` with `error: "authentication_failed"` ("OAuth session expired and could not be refreshed") followed by `result` with `is_error: true`, `terminal_reason: "api_error"`.
  -> FlowState needs a **Sign in** step: detect via `claude auth status` / the error event, then open an embedded terminal tab running the CLI's login. We never read or store credentials.
- **NOT yet verified (blocked by expired login):** a real tool-use turn, the `control_request` (`can_use_tool`) permission handshake, and what `--remote-control` does in `-p` mode. `normalizeClaude` already maps the expected `control_request` shape — mark as unverified until captured. **Action for the user:** run `claude auth login` (or `claude` once) so these can be captured.

## agy.exe
- **Headless protocol works:** `agy --output-format stream-json -p=<prompt>`. Note: `-p` consumes the next token as its prompt, so the prompt must be attached (`-p=...`). `--input-format stream-json` is documented for multi-turn over stdin (not yet exercised).
- **Different schema from claude:** `{"event":"init"|"step_update"|"result", ...}`; session id is `conversation_id`. Streaming text arrives as `step_update` / `agent_response` / `ACTIVE` with `text_delta`; tools as `step_type:"tool"` with `ACTIVE` (tool_name, parameters) then `DONE` (output summary, duration).
- **Safety finding:** in print mode `init.permission_mode` was **`always-proceed`** — it wrote `hello.txt` with no prompt. FlowState must show this clearly, default agy projects to `--mode plan`/`accept-edits` or `--sandbox` where possible, and warn on `always-proceed`.
- **Other surface:** `--continue`, `--conversation <id>`, `--remote-control`, `remote-control start|status|stop` daemon, `--sandbox`, `--mode`, and an `acp` stdio server (Agent Client Protocol) as the likely route for interactive permission prompts. ACP not yet spiked.

## Decisions
1. One `AgentAdapter` per CLI mapping native events into `src/shared/events.js` (covered by `tests/unit/events.test.js`). Renderer is CLI-agnostic.
2. claude: raw stream-json, `--permission-prompts host` with the control-request handshake (to verify), fallback to `--permission-mode` + embedded terminal.
3. agy: stream-json for display now; evaluate ACP for approvals; default to a restrictive `--mode`.
4. Prereq wizard checks: claude path + `auth status`, agy on PATH, node, git, python, winget.

## Open items for the next spike pass
- [ ] Re-capture claude with a valid login: tool turn, permission handshake, partial messages, `--resume`.
- [ ] `--remote-control` behaviour for both CLIs; agy `remote-control` daemon lifecycle.
- [ ] agy `--input-format stream-json` multi-turn; `--conversation` resume; ACP permission flow.
- [ ] `node-pty` prebuilt works inside Electron (terminal tab).
