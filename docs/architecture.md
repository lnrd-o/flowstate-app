# FlowState architecture

```
Renderer (sandboxed, vanilla ES modules)           Main process (Node)
  sidebar | chat | artifacts pane | run view   <--IPC-->   ipc.js (validates every argument)
  window.flowstate (preload.cjs allow-list)                 |
                                                            +-- agents/manager.js  one child per project
                                                            |     claude.js / agy.js  -> normalise to shared/events.js
                                                            +-- projects.js, settings.js, history.js (JSONL)
                                                            +-- git.js (auto-commit on claude/auto, undo turn); versions.js via svc/versions.js (timeline, named versions = checkpoint/* tags, compare, restore, branch handler)
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
- Credentials: never read or stored. Sign-in runs the CLI's own flow inside the app (`login.js`): claude over pipes
  (`claude auth login` prints a URL and a paste-code prompt), agy in a PTY (`@lydell/node-pty` + xterm.js) because its login
  is part of the interactive TUI. Signed-in state comes from `claude auth status` and `agy models`. Only allow-listed https
  sign-in hosts are opened automatically (`auth-check.js`).

## Known behaviours of the CLIs (verified, see spikes.md)
- claude headless default mode denies writes with `system/permission_denied` (no inline approval); FlowState shows an
  "approve & retry" card. agy's `init` always says `always-proceed` but obeys `--mode`.
- claude refuses Windows 8.3 short paths ("suspicious path pattern"), so FlowState always resolves real long paths.
- `claude remote-control` needs the folder trusted once through an interactive `claude` session.

## Platform support (src/main/platform.js and friends)
Every platform-dependent function takes `platform`/`env`/`fs`/runner parameters so macOS and Linux logic is unit-tested
from Windows (`tests/unit/main-platform.test.js`, fake fs in `tests/fixtures/fake-fs.js`). Only Windows has run for real.
- **Discovery** (`health.js`): settings path, PATH, then per-OS install dirs and the Claude desktop app's bundled copy
  (newest version first). Only launchable files count: win32 `.exe` (never `.cmd/.bat` shims), posix files with an exec bit.
- **PATH:** apps launched from Finder/the desktop do not inherit the shell PATH. `platform.js` builds a search PATH
  (inherited + /usr/local/bin, /opt/homebrew/bin, ~/.local/bin, ~/.npm-global/bin, ~/.volta/bin, ~/.cargo/bin, nvm default)
  and passes it to every spawned CLI via `spawnEnv()` (run.js, proc.js, agents/base.js, remote.js).
- **VPN:** win32 Get-NetAdapter; macOS `scutil --nc list` (Connected) + VPN-named UP interfaces with IPv4 (bare `utun` never
  counts); Linux `ip -o link show up` + `nmcli` active vpn/wireguard/tun connections.
- **Installers** (`prereq.js`): winget / `brew install` / pkexec + apt-get|dnf|pacman|zypper with fixed package names; when no GUI
  privilege prompt exists the exact `sudo ...` command is returned for the user to run. Nothing is ever piped into a shell.
- **Terminals** (`terminal.js`): cmd `start`, Terminal.app via osascript (strictly quoted), or the first available Linux emulator.
- **Process trees:** Windows `taskkill /T /F`; posix children are spawned `detached` (own process group) and killed with
  SIGTERM to the group, SIGKILL after 2 s. Children not started by FlowState's spawn helper fall back to signalling the pid only.
- **Files:** opening is refused for Windows executables, posix scripts/bundles (.sh, .command, .app, .AppImage ...) and any file with an exec bit.
- **Packaging/CI:** see building.md.

## Phase 7 services (`src/main/svc/*.js`)

Loaded by `services.js` (`export function create(deps)`), listening to agent events through `onAgentEvent(projectId, event, meta)`
where `meta.agent` is the agent that produced the turn (methodology overrides included).

| service | role |
| --- | --- |
| `store` | `<project>/.flowstate` write-through + auto-load, open folder, clear (see project-store.md) |
| `ui` | global UI state (userData) + per-project UI state (via store) |
| `models` | claude static aliases (+ model id seen in `session`), agy live `agy models` (60 s cache); the adapters add `--model/--effort` |
| `usage` | claude rate-limit windows, per-turn cost/tokens per agent (daily buckets, 30 days, `usage.json`), verbatim `limit` messages, `claude -p /usage` refresh (at most every 5 min), DeepSeek balance; pushes `ev:usage` (1/s) |
| `deepseek` | optional balance/models; key only via Electron `safeStorage` in `deepseek.key`, fixed `https://api.deepseek.com` origin |
| `attachments` | images in `.flowstate/attachments` (magic bytes, <= 8 MB, header size parsing); `agent.send({images})` becomes base64 blocks (claude) or `[Image attached: path]` lines (agy) |
| `tasks` | running agent turns + dashboards / remote / methodology / sign-in / watcher + agent todos and sub-agents; `ev:tasks` on change (<= 2/s) |
| `menu` | one model (`src/shared/menu.js`) for the native menu (EN/ES labels in `menu-labels.js`) and the HTML bar (`menu:model` / `menu:invoke`) |
| `boot` | splash window (`src/main/splash/`), window state (`window-state.json`), show-on-`app:ready` (10 s fallback), quit flow |

### Boot and quit

`main.js` opens the splash first (steps: modules, settings, projects, resume, services, tools, open), creates the main window with
`show:false` at the saved bounds (validated against the connected displays; maximized restored, fullscreen never) and shows it when the
renderer has called `app:ready` AND the first health poll is done (or after 10 s); the splash then closes (minimum 700 ms visible).
Closing the window on win/linux, `file.quit` or any quit runs one guarded flow: push `ev:before-quit`, wait for `app:flushed` (max 2 s),
`store.saveAll`, flush usage, stop agents / runner / dashboards / remote / login / watcher / services, then `app.quit()`.
E2E launchers must pick the CDP target whose URL ends with `index.html` (the splash is a second page while booting).
