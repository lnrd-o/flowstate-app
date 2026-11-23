# FlowState

Desktop GUI for [Claude Code](https://claude.com/claude-code) (`claude.exe`) and Antigravity (`agy.exe`).
Electron + plain JavaScript (ES modules, no framework, no bundler). Windows first; macOS and Linux builds exist but are unverified (see Platforms).

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
Requirements: Node 20+, Git. FlowState finds the `claude` and `agy` CLIs itself (PATH, the
Claude desktop app's bundled copy, common install dirs) and you can override the paths in Settings.
Sign in to each CLI from inside the app (Settings > Accounts, the banners, or the setup walkthrough): Claude gets a
native dialog (browser link + code box), AGY an embedded terminal for its own login screen. Credentials stay in each CLI's store.

## Platforms
| Platform | Status |
|----------|--------|
| Windows 10/11 x64 | **Verified end-to-end** (app, installer/portable build, real CLIs). |
| macOS (arm64, x64) | Built by CI (`.dmg`/`.zip`, unsigned). **Not yet verified on a real Mac.** |
| Linux x64 | Built by CI (`.AppImage`/`.deb`/`.tar.gz`). **Not yet verified on a real machine.** |

macOS/Linux logic (CLI discovery, PATH for Finder/desktop launches, VPN detection, installers via Homebrew/apt/dnf/pacman/zypper,
terminal launching, process-group kill) is unit-tested with injected platform data only. Downloads are unsigned: see
[docs/building.md](docs/building.md) for the first-launch steps (SmartScreen, Gatekeeper, `chmod +x`) and how to build or release.

## Features
- **Agents:** Claude / Antigravity / OpenCode switch per project, streaming chat, markdown + highlighted code (7 code themes). Each agent has its own identity: Claude in orange with an animated burst, AGY with a flowing rainbow sparkle.
- **What the agent did:** rich cards with real diffs (computed by FlowState, since AGY only reports file paths), command output with exit codes, thinking time, a turn summary and an Activity timeline.
- **Developer / Simple mode:** Developer shows code, diffs, commands and exact details; Simple shows plain-language steps ("Created hello.py", "Tested your project, it worked"). One click in the top bar.
- **Approvals:** blocked actions show exactly what they are; "Allow this once" lets Claude run just that one command for one turn (never saved), no need to switch the whole project to auto-edit.
- **Look:** white on black (dark), black on white (light), or Dark Gold.
- **First launch:** a setup wizard asks your language first (auto-detected from Windows), then Simple/Developer mode, theme, sign-in to Claude and AGY, tools (Git, Node, Python) and optional extras.
- **New project in two questions:** pick what you need help with (an Excel file, an HTML page, analysis or a dashboard from a CSV/TXT, online research, documents, automation ...) and type a name. FlowState creates the folder for you in `Documents\Proyectos` (Spanish) or `Documents\Projects` (English) with a safe name like `Analisis_De_Ventas_2026`, copies your files into the project's `data` folder (originals are never changed) and starts the work.
- **Usage, models, images:** Claude 5-hour and weekly usage, model and effort selectors, image attach with suggestions, optional DeepSeek balance, a Tasks panel and a File/Edit/View/Help menu.
- **Your work travels with the folder:** settings, history and progress are saved in `<project>/.flowstate`.
- **Projects:** registry, resume the last session automatically, saved chat history, project menu.
- **Git:** optional auto-commit to a `claude/auto` branch after each turn (secret-safe), one-click undo of the last turn.
- **Health:** detects Claude/AGY/Node/Git/Python, sign-in state, VPN adapters and whether Anthropic is reachable; banner asks you to leave the VPN.
- **Prompts:** 10 bundled prompts (EN/ES) with `{{variables}}`, your own templates, export to `.claude/commands`, `/` picker in the composer.
- **Artifacts pane:** Files (live tree + previews), Preview (last file the agent wrote), Dashboard (per-project Python venv + Streamlit), Git.
- **Remote control:** per-project toggle (claude: the project folder must be trusted once via `claude`).
- **Methodologies:** record from a session, edit as a graph, run with checkpoints, start new projects from one.
- **Sources:** Claude Code, Antigravity, OpenCode (found automatically, also inside the OpenCode desktop app; one-click install from opencode.ai; sign-in in the built-in terminal) and DeepSeek models, each with an on/off switch in Settings.
- **Conversations:** several conversations per project, each with its own agent and history; Markdown context notes let any provider continue the work.
- **Work easier:**
  - **Drop a file anywhere** (Excel, CSV, PDF, Word, PowerPoint, images): FlowState asks what to do (analyze, clean, dashboard, summarize ...), copies it into the project's data folder and starts.
  - **Quick ask:** Ctrl+Space inside FlowState, Ctrl+Shift+Space from anywhere in Windows.
  - **After each turn:** what changed, **Undo**, **Compare** changed spreadsheets cell by cell, **Export** the answer to PDF, Word or PowerPoint, **Save as recipe** (a reusable one-click methodology).
  - **Plan first:** the agent proposes the steps without changing anything; untick or edit them, then **Run plan**.
  - **Ask about this file** from the file viewer: explain, find errors, make charts, summarize.
  - **Notifications** when a turn finishes or needs approval while FlowState is in the background.
  - **Scheduled tasks:** run a request or a recipe on a timer (every hour, every day, some weekdays).
- **Auto-update:** installed builds download new versions from GitHub Releases in the background and offer "Restart to update".
- **Project folders:** new projects get `data/` + `outputs/` (`datos/` + `salidas/` in Spanish); code stays in the root.
- **Safety:** "Always ask" protections stay on even in Auto-accept (sensitive files, deleting, installing, network commands, git remote, outside the project).

## Layout
```
src/main/      Electron main process (agents, projects, git, health/vpn, files, dashboards, prompts, methodologies ...)
src/renderer/  UI (vanilla ES modules, styles, i18n, vendored libs)
src/shared/    Contracts used by both sides: events.js, ipc.js, methodology.js
prompts/       Bundled prompt templates        methodologies/  Bundled methodologies
spikes/        Scripts that capture real CLI output (see docs/spikes.md)
tests/         unit/, e2e/, fixtures/ (fake agent)
docs/          architecture.md, building.md, design.md, spikes.md
```

## Docs
- [docs/architecture.md](docs/architecture.md) - how the pieces fit, security model, platform support
- [docs/building.md](docs/building.md) - build per OS, unsigned-app notes, cutting a release
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
