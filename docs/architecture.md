# FlowState architecture

```
Renderer (sandboxed, vanilla ES modules)           Main process (Node)
  sidebar | chat | artifacts pane | run view   <--IPC-->   ipc.js (validates every argument)
  window.flowstate (preload.cjs allow-list)                 |
                                                            +-- agents/manager.js  one child per project
                                                            |     claude.js / agy.js  -> normalise to shared/events.js
                                                            +-- projects.js, settings.js, history.js (JSONL)
                                                            +-- git.js (auto-commit on claude/auto, undo turn)
                                                            +-- health.js (CLIs, auth, VPN adapters, reachability)
                                                            +-- files.js (path-guarded list/read/watch/open)
                                                            +-- prompts.js, dashboards.js, prereq.js, auth.js, remote.js
                                                            +-- methodologies.js, recorder.js, runner.js
```

## Contracts (src/shared)
- `events.js` - every CLI's stream-json is mapped to one event vocabulary: `session`, `text-delta`, `text`, `tool-use`,
  `tool-result`, `permission-denied`, `permission-request`, `rate-limit`, `result`, `error`.
  claude emits `{type,subtype}` events; agy emits `{event:'init'|'step_update'|'result'}`; adapters hide that.
- `ipc.js` - channel names (`CH`), the shape of `window.flowstate` (`API_SHAPE`) and JSDoc types. `preload.cjs` mirrors the
  channel names (a sandboxed preload cannot import ES modules); a unit test keeps it in sync.
- `methodology.js` - model, validator and pure helpers (layout, variable substitution) shared by main and renderer.

## Agent turn lifecycle
1. Renderer `agent.send({projectId, text})`.
2. Manager resolves the real long project path, builds args (claude: `-p --output-format stream-json --verbose
   --include-partial-messages --input-format stream-json [--resume id] --permission-mode m`; agy:
   `--output-format stream-json [--conversation id] --mode m -p=<prompt>`), spawns with `shell:false`.
3. stdout NDJSON -> normaliser -> events pushed to the renderer, recorded to history, session id persisted.
4. On `result`: optional auto-commit; renderer refreshes git status.

## Security model
- Sandbox + `contextIsolation`, CSP on `file://` pages (plus `frame-src 127.0.0.1` for the Streamlit embed), https allow-list for external links.
- Renderer never receives absolute paths outside the project and never builds shell strings.
- Model output is untrusted: sanitized markdown, HTML previews in `sandbox=""` iframes.
- Methodologies from outside are untrusted: validated, command nodes need per-run confirmation and a program deny-list.
- Credentials: never read or stored; sign-in happens in the CLI's own console flow.

## Known behaviours of the CLIs (verified, see spikes.md)
- claude headless default mode denies writes with `system/permission_denied` (no inline approval); FlowState shows an
  "approve & retry" card. agy's `init` always says `always-proceed` but obeys `--mode`.
- claude refuses Windows 8.3 short paths ("suspicious path pattern"), so FlowState always resolves real long paths.
- `claude remote-control` needs the folder trusted once through an interactive `claude` session.
