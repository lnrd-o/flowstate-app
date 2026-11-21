# FlowState

Desktop GUI for [Claude Code](https://claude.com/claude-code) (`claude.exe`) and Antigravity (`agy.exe`).
Electron + plain JavaScript. Windows first.

**Goals:** run the CLI agents without a terminal, Claude-style 3-column UI (projects · chat · artifacts),
per-project resume, git auto-versioning, VPN warning, adjustable prompt templates, EN/ES, and a
*Methodology* system that records a project pipeline, visualises it and saves it for reuse.

## Status
Phase 0 (spikes). See `docs/spikes.md` once available and the plan in the repo history.

## Layout
```
src/main/      Electron main process (agents, projects, git, vpn, prereqs, ...)
src/renderer/  UI (vanilla ES modules, styles, i18n)
src/shared/    Event contract + JSON schemas shared by both sides
prompts/       Default prompt templates
methodologies/ Bundled methodology examples
spikes/        Throwaway scripts that capture real CLI output
tests/         Unit + E2E tests (fake agent fixture)
docs/          Architecture, design, security, spikes
```
