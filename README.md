# FlowState

Desktop GUI for [Claude Code](https://claude.com/claude-code) (`claude.exe`) and Antigravity (`agy.exe`).
Electron + plain JavaScript (ES modules, no framework, no bundler). Windows first.

Run your coding agents without a terminal: a Claude-style 3-column UI (projects / chat / artifacts),
per-project session resume, git auto-versioning, a VPN warning, adjustable prompt templates, EN/ES,
three themes (Dark, Light, Dark Gold) and a **Methodology** system that records a project's workflow,
shows it as a graph and replays it on new projects.

## Quick start
```powershell
npm install
npm start            # launch the app
npm test             # unit tests (node:test)
npm run e2e          # real-Electron smoke test, isolated profile (E2E_REAL=1 adds a real agy turn)
npm run vendor       # re-copy marked / dompurify / highlight.js into src/renderer/vendor
```
Requirements: Windows, Node 20+, Git. FlowState finds `claude.exe` and `agy.exe` itself (PATH, the
Claude desktop app's bundled copy, common install dirs) and you can override the paths in Settings.
Sign in once with each CLI (the app has a Sign-in button that opens a console for the login).

## Features
- **Agents:** Claude / AGY switch per project, streaming chat, markdown + highlighted code (7 code themes), tool cards.
- **Projects:** registry, resume the last session automatically, saved chat history, project menu.
- **Git:** optional auto-commit to a `claude/auto` branch after each turn (secret-safe), one-click undo of the last turn.
- **Health:** detects Claude/AGY/Node/Git/Python, sign-in state, VPN adapters and whether Anthropic is reachable; banner asks you to leave the VPN.
- **Prompts:** 10 bundled prompts (EN/ES) with `{{variables}}`, your own templates, export to `.claude/commands`, `/` picker in the composer.
- **Artifacts pane:** Files (live tree + previews), Preview (last file the agent wrote), Dashboard (per-project Python venv + Streamlit), Git.
- **Remote control:** per-project toggle (claude: the project folder must be trusted once via `claude`).
- **Methodologies:** record from a session, edit as a graph, run with checkpoints, start new projects from one.

## Layout
```
src/main/      Electron main process (agents, projects, git, health/vpn, files, dashboards, prompts, methodologies ...)
src/renderer/  UI (vanilla ES modules, styles, i18n, vendored libs)
src/shared/    Contracts used by both sides: events.js, ipc.js, methodology.js
prompts/       Bundled prompt templates        methodologies/  Bundled methodologies
spikes/        Scripts that capture real CLI output (see docs/spikes.md)
tests/         unit/, e2e/, fixtures/ (fake agent)
docs/          architecture.md, design.md, spikes.md
```

## Docs
- [docs/architecture.md](docs/architecture.md) - how the pieces fit, security model
- [docs/design.md](docs/design.md) - design tokens and component class catalogue
- [docs/spikes.md](docs/spikes.md) - what the real CLIs emit and what was verified

## Security notes
Renderer is sandboxed (`contextIsolation`, no Node integration, strict CSP, channel allow-list in `preload.cjs`).
All model output is sanitized with DOMPurify. File access is confined to the project folder (traversal, UNC,
absolute paths and alternate data streams are rejected). Methodology `command` steps always require
confirmation and a deny-list blocks shells and downloaders. FlowState never reads or stores your
Claude/Antigravity credentials; it spawns your own CLIs.

## License
Apache-2.0
