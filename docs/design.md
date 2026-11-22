# FlowState design system

Files (load in this order in `index.html`): `styles/tokens.css`, `base.css`, `layout.css`, `components.css`, `chat.css`, `code-themes.css`.
Static check page (no JS): open `src/renderer/styles/preview.html` in a browser (dark, light, every code theme).
Icons: inline SVG with class `icon` (16px, stroke = currentColor); `icon--lg` is 20px.

## Theme switching
- `document.documentElement.dataset.theme = 'dark' | 'light'` (dark is the default when unset).
- `document.documentElement.dataset.codeTheme = 'vs-dark' | 'github-dark' | 'github-light' | 'dracula' | 'one-dark' | 'solarized-dark' | 'monokai'`.
  If unset: `vs-dark` in dark, `github-light` in light. Code themes work independently of the app theme.
- Panel widths: `.app` reads `--sidebar-w` and `--artifacts-w`; set them inline on `.app` (e.g. `style="--artifacts-w:520px"`) when the splitter is dragged. Clamp artifacts to `--artifacts-min-w`..60vw in JS.

## Tokens (tokens.css)
Surfaces `--bg --bg-panel --bg-card --bg-elev --bg-input --bg-hover --bg-active --bg-overlay`; borders `--border --border-strong`;
text `--text --text-2 --text-3`; accent `--accent --accent-hover --accent-btn --accent-btn-hover --accent-soft --accent-text --on-accent` (monochrome: white on black in dark, black on white in light; gold overrides it);
agent identity `--claude --claude-soft --claude-text --gemini-red|yellow|green|blue --gemini-soft --gemini-*-t (text-safe variants) --gemini-gradient --gemini-gradient-v --gemini-flow --gemini-flow-text` (no purple; the flow gradients are palindromic so blue never blends into red);
status `--green|amber|red|blue` + `-soft` (translucent bg) + `-text` (text on soft bg); `--focus --selection`;
code `--code-bg --code-header-bg --code-inline-bg --diff-add-bg --diff-del-bg`;
radii `--radius-xs/sm/md(8)/lg(12)/xl/pill`; spacing `--space-1..12` (4px grid: 1=4, 2=8, 3=12, 4=16, 5=20, 6=24, 8=32, 10=40, 12=48);
type `--font-sans --font-mono --fs-xs(11) sm(12) md(13) base(14) lg(16) xl(20) 2xl(24) 3xl(30) --lh-* --fw-*`;
shadows `--shadow-sm/md/lg`; z `--z-base/splitter/sticky/banner/menu/modal/toast`; motion `--ease --dur-fast --dur --dur-slow --transition`;
sizes `--rail-w 52px --sidebar-w 264px --artifacts-w 420px --artifacts-min-w --splitter-w --topbar-h --control-h 32px --control-h-sm 26px --chat-max-w`.
Use text on soft badges as `--*-text`, never raw `--green` etc. (raw colors are for dots, borders, bars).

## Class catalogue (the contract)

### Utilities (base.css)
`.row` (flex row, centered, gap 8) `.col` (flex column) `.grow` `.shrink-0` `.wrap` `.gap-1..4` `.between` `.center` `.muted` `.faint` `.small` `.xs` `.strong` `.mono` `.truncate` `.icon` `.icon--lg` `.sr-only`.

### Layout (layout.css)
```html
<div id="root">
  <div class="banner-slot"><div class="banner banner--danger" role="alert"><svg class="banner__icon icon"/><span class="banner__text">..</span><span class="banner__actions"><button class="btn btn--sm">..</button></span></div></div>
  <div class="app [is-sidebar-collapsed] [is-artifacts-collapsed] [is-resizing]">
    <nav class="rail"><div class="rail__logo">F</div><button class="rail__btn [is-active]"/><div class="rail__spacer"></div>..</nav>
    <aside class="sidebar">
      <div class="sidebar__header">
        <button class="workspace-switcher"><span class="workspace-switcher__avatar">F</span><span class="grow truncate">..</span></button>
        <div class="search-box"><svg class="search-box__icon"/><input class="input"><span class="kbd">Ctrl K</span></div></div>
      <div class="sidebar__scroll"> nav-section-label + nav-item ... </div>
      <div class="sidebar__footer"> <div class="row"><span class="dot dot--green"></span>Connected</div> <div class="user-chip"><span class="user-chip__avatar">L</span>..</div></div>
    </aside>
    <main class="main">
      <div class="topbar"><span class="topbar__crumbs">A <span class="sep">/</span></span><span class="topbar__title">..</span><span class="badge ..">..</span><div class="topbar__actions">buttons</div></div>
      <div class="chat"><div class="chat-scroll"><div class="chat-scroll__inner">messages</div></div>
        <div class="composer-wrap"><div class="composer-wrap__inner"><div class="composer">..</div></div></div></div>
      <!-- or overview page: <div class="page"><div class="page__inner"><div class="grid-stats">stat-cards</div><div class="grid-2">cards</div></div></div> -->
    </main>
    <div class="splitter" role="separator" aria-orientation="vertical" tabindex="0"></div>
    <aside class="artifacts"><div class="artifacts__header"><div class="pill-tabs">..</div></div><div class="artifacts__body">..</div></aside>
  </div>
</div>
```
Splitter: add `.is-dragging` to `.splitter` and `.is-resizing` to `.app` while dragging. Collapse classes hide sidebar/artifacts and reclaim the grid column. Min supported width 1000px (side widths shrink at 1280 and 1100).

### Components (components.css)
- `.btn` + `--primary --ghost --danger --icon --sm` (combine: `btn btn--ghost btn--icon btn--sm`).
- `.input` `.select` `.select--sm` `.textarea`; wrap in `.field` with `.field__label`, `.field__hint`, `.field__error`.
- `.badge` + `--green --amber --red --accent --muted`; dot: `<span class="badge badge--green"><span class="badge__dot"></span>Idle</span>`. Standalone `.dot` + `--green --amber --red --muted`.
- `.pill-tabs > .pill-tab(.is-active)` (add `role="tablist"`/`role="tab"`, `aria-selected`).
- `.card` (`.card--flush`), `.card__header`, `.card__title`, `.card__sub`; `.stat-card > .stat-card__label + .stat-card__value + .stat-card__sub` (`--up` green, `--down` red); `.bars > .bars__bar(.is-active)` with inline `height:%`.
- `.nav-section-label`; `.nav-item(.is-active)` with `.nav-item__icon .nav-item__label .nav-item__count .nav-item__dot(--green|--amber|--red)`; `.nav-item--sub` for sessions under a project.
- `.list-row > .list-row__main(.list-row__title + .list-row__sub)` + trailing badge/button.
- `.kbd`; `.toggle` = `<label class="toggle"><input type="checkbox"><span class="toggle__track"></span>text</label>`.
- `.segmented > .segmented__item(.is-active)` (Claude | AGY switch; `role="radiogroup"`, items `role="radio" aria-checked`).
- Modal: `<div class="modal" role="dialog" aria-modal="true"><div class="modal__backdrop"></div><div class="dialog [dialog--lg]"><div class="dialog__header"><h2 class="dialog__title"/></div><div class="dialog__body"/><div class="dialog__footer"/></div></div>`.
- Toast: container `.toast-stack` > `.toast` (`--success --error --warn`), `role="status"`.
- `.empty-state > .empty-state__icon .empty-state__title .empty-state__text`.
- `.spinner` (`--lg`); `.menu > .menu__item(--danger) .menu__sep` (absolutely positioned: set top/left inline; parent `position:relative`).
- `.progress > .progress__bar` (inline width; `.progress--indeterminate`).
- `.stepper(--horizontal) > .stepper__step(.is-active|.is-done) > .stepper__num + label`.
- `.divider`, `.chip-path` (mono path text).

### Chat (chat.css)
- `.msg.msg--user|--assistant|--system|--error` > `.msg__meta` + `.msg__body` (assistant body: add `.md`; user body is plain text, pre-wrap).
- `.thinking-dots` = `<span class="thinking-dots"><span></span><span></span><span></span></span>`.
- Tool card: `<div class="tool-card [is-open] [tool-card--running|--error]"><button class="tool-card__header"><svg class="tool-card__icon"/><span class="tool-card__name">Edit</span><span class="tool-card__summary">path</span><span class="badge badge--accent">Running</span><svg class="tool-card__chevron"/></button><div class="tool-card__body">mono output</div></div>`. Status badge: running = `badge--accent` (+ spinner), done = `badge--green`, error = `badge--red`, blocked = `badge--amber` + lock icon (`tool-card--blocked`). Toggle `.is-open` and `aria-expanded`.
- Permission card: `.permission-card > .permission-card__title + .permission-card__detail + .permission-card__actions` (Deny `btn`, Approve `btn btn--primary`); add `.is-resolved` after answering.
- Composer: `<div class="composer"><textarea class="composer__input" rows="1"></textarea><div class="composer__toolbar"><div class="segmented">..</div><select class="select select--sm" style="width:auto"/><span class="composer__spacer"></span><button class="composer__send [composer__send--stop]"/></div></div>` + `.composer__hint`. Autosize: set `style.height` from scrollHeight (max 240px via CSS).
- Markdown: wrap sanitized HTML in `.md` (h1-h4, p, ul/ol, blockquote, table, hr, a, img, code).
- Code block: `<div class="code-block [code-block--lines]"><div class="code-block__header"><span class="code-block__lang">js</span><button class="code-block__copy btn btn--ghost btn--sm">Copy</button></div><pre><code class="hljs language-js">..</code></pre></div>`. For line numbers wrap each line in `<span class="line">`. Copied state: `.is-copied` on the button. Diff lines: `<span class="line diff-add">` / `diff-del` (or hljs `.hljs-addition/.hljs-deletion`).

### Code themes (code-themes.css)
Styles every `.hljs-*` class listed in the brief via `--c-*` variables per theme (real palettes of VS Code Dark+, GitHub, Dracula, One Dark, Solarized Dark, Monokai). Do not load vendored hljs-styles CSS.

## Accessibility
Contrast ratios computed (WCAG, text on its actual background; blended for translucent badges):
| Pair | Dark | Light |
|---|---|---|
| text / page bg | 19.8 | 21.0 |
| text / card | 18.1 | 19.1 |
| text-2 / panel | 7.5 | 7.4 |
| text-2 / card | 7.2 | 7.0 |
| text-3 / panel | 5.5 | 5.0 |
| text-3 / card | 5.2 | 4.8 |
| accent-text / accent-soft badge | 13.8 | 16.7 |
| --on-accent on primary button (hover) | 21.0 (16.7) | 21.0 (14.9) |
| green / amber / red badge text | 8.4 / 8.0 / 6.0 | 5.1 / 4.7 / 5.0 |
| --claude-text / card | 7.5 | 4.5 |
| Gemini text variants (red / yellow / green / blue) / panel | 7.5 / 11.1 / 9.6 / 8.5 | 5.6 / 4.8 / 5.7 / 5.9 |
- Focus: global `:focus-visible` 2px ring in `--focus` with 2px offset; inputs also get a soft accent glow. Never remove outlines without a replacement.
- Reduced motion: base.css `@media (prefers-reduced-motion: reduce)` neutralises all animation/transition.
- Required ARIA from the frontend: icon-only buttons need `aria-label` (and `title`), tabs/segmented use roles above, banners `role="alert"`, toasts `role="status"`, modals `aria-modal` + focus trap + Esc.
- Always pair status color with text or an icon (never color alone).

## i18n
`src/renderer/lib/i18n.js`: `await setLanguage('es')`, `t('chat.permissionText', {agent, tool})`, `applyTranslations(root)` for `data-i18n`, `data-i18n-placeholder`, `data-i18n-title`, `data-i18n-aria-label`, `onChange(cb)` returns unsubscribe, `detectLanguage(osLocale)`. JSON in `src/renderer/i18n/{en,es}.json`; add every key to both (test enforces parity and placeholders). Spanish strings run ~20-30% longer: let buttons/labels truncate or wrap, do not set fixed widths.

## Phase 3 additions (app.css)
- Graph (`components/graph.js`): `.graph > svg.graph__svg` with `.gedge(.is-selected|.is-walked)`, `.gnode.gnode--<type>(.is-selected|.is-source|.st-<state>)`; node tone via `--nc`/`--nct` (accent, amber, green, blue, muted). Run states always add a badge glyph, never color alone. Pulse only under `prefers-reduced-motion: no-preference`.
- Editor: `.me` (head, toolbar, `.me__body` = canvas + `.me__side` inspector with `.pill-tabs`), `.chip(--ok|--warn)`, `.me__warn`, `.me__suggest`. Stacks under 780px of container width.
- List: `.methods`, `.method-card`. Run panel above the chat: `.rp` (`.rp__card` waiting card, `.rp__cmd` command block, `.rp__steps`). Dialog helpers: `.vf` (variables form), `.wt-opt` (walkthrough starting point).
- The methodologies view adds `.is-wide-view` to `.app` (artifacts pane hidden).
- Browser mock: `lib/mock-phase3.js`; hash flags `#runfail`, `#fastrun`.

## Phase 4 additions (app.css)
- Title bar (`components/titlebar.js`): `header.titlebar` is the first row of `#root` (above `.banner-slot` and `.app`), height `var(--titlebar-h)` (40px, must equal the `height` sent with `window.setTheme`). Children: `.titlebar__left` (`.titlebar__logo` F mark, `.titlebar__name`, `.titlebar__crumbs` with `.sep`), `.titlebar__center > .search-box.titlebar__search` (the Ctrl+K input, `#project-search`, drives `store.search`, moved out of the sidebar), `.titlebar__right` (`.titlebar__chips` > `.badge.titlebar__chip(--vpn|--remote|--conn|--btn)`, then `.titlebar__controls` with `.titlebar__ctl--min|--max|--close`, shown only when there is no native overlay, e.g. the plain-browser mock).
- Drag: the bar is `-webkit-app-region: drag`; buttons, inputs, `.search-box`, `.badge` and `.titlebar__controls` are `no-drag`. Never put an interactive element in the bar without covering it by those selectors.
- Reserved space: `--tb-left` / `--tb-right` (set inline by the component from `lib/titlebar-state.js computeInsets`). win32/linux use `env(titlebar-area-x/width)` with fallback to `--tb-right` (140px); darwin reserves `--tb-left` (80px) for the traffic lights. `<html>` gets `platform-win32|darwin|linux` and `is-fullscreen` (hides the reserved space). Theme: after every theme change the component reads the computed bar colours, converts them with `lib/colors.js` and calls `window.setTheme`.
- Responsive: crumbs hide under 1180px, the connection chip becomes dot-only under 1060px (text stays for screen readers).
- Sign-in dialog (`components/login-dialog.js`, state in `lib/login-state.js`): `.login` > `.login__tabs.pill-tabs` (`.login__tab` = label + status `.badge`), `.login__pane` (one per agent). Claude: `.segmented` account type, email `.field`, `.login-steps > .login-step(.is-active|.is-done)` with `.login-step__num`, `.login-url` (`.login-url__field` read-only mono + open/copy buttons). AGY: `.login-url--bar` above `.login-term` (xterm host, 320px, themed from tokens by `terminalTheme()`; xterm.css is vendored in `vendor/`). States: `.login-success`, `.login-error` (`role=alert`), `.login-note`. Footer: `.login__foot`.
- Entry points: `.wt-note` (walkthrough prerequisites), `.settings-accounts` (Settings > Accounts), `.composer__signin` (button inside the composer hint).
- Browser mock: `lib/mock-phase4.js`; hash flags `#mac #linux #overlay #fullscreen #needlogin #claudeout #agyout #noterm #badcode`.

## Phase 5 additions (app.css)
- Tool card (`components/tool-card.js`): `.tool-card.tool-card--<kind>` > `.tool-card__bar` (`.tool-card__header` button with icon, `.tool-card__title`, `.tc-delta` +/-, `.tool-card__dur`, status badge, chevron; `.tool-card__raw` toggle) + `.tc-body`. Bodies: `.tc-term` (terminal block, `.tc-term__pre` max 320px, `.tc-term__cmd`), `.tc-file` (path button, op badge, Copy diff, diff view), `.tc-info`/`.tc-preview` (read, search, list), `.tc-raw` (normalised event JSON). Generic fallback for kind `other`.
- Diff view (`components/diff-view.js`): `.diffv[role=region][tabindex=0] > table.diffv__table` rows `.diffv__row--add|del|ctx|hunk|meta`, cells `.diffv__num` (old/new gutters, hidden by `.diffv--nonum`), `.diffv__sign`, `.diffv__code`. Colours from `--diff-add-bg/--diff-del-bg`; syntax highlighting via the hljs helper, built without innerHTML.
- Rows (`components/activity-rows.js`): `.think-row` (collapsed "Thought for 17.3 s - 1,600 tokens"), `.turn-summary` (files/commands/thinking + Expand all), `.live-status` (aria-hidden visible line with elapsed counter + sr-only polite status that only announces phase changes).
- Activity tab (`components/activity-tab.js`, i18n `artifacts.activity`): `.act` with `.act__tl` timeline, files changed (inline diff), commands (jump to the card). Dot on the tab while the agent runs.
- Pure logic: `lib/diff.js` (line diff, unified diff writer/parser, diffs derived from claude tool inputs), `lib/activity.js` (titles, ANSI strip, turn stats, timeline, live phase). Reducer: `thinking`, `file-change`, tool kind/duration/exit code, `turn { id, agent, startedAt, lastEventAt }`, `summary` marker; every message carries its turn and agent.
- Browser mock: `lib/mock-phase5.js`; hash flags `#rich` (AGY style events) and `#richclaude` (claude tool inputs, client-side diffs); applies to the first send. `?mock=1` forces the mock inside Electron.


## Phase 6: monochrome accent, agent identity, Developer / Simple mode, approvals
Stylesheet `styles/agents.css` (loaded after `app.css`); every colour comes from tokens.css.

### Monochrome theme
Dark = near-black surfaces (`--bg #0a0a0a`, panel `#101010`, card `#161616`, elev `#1c1c1c`), text `#fff / #a3a3a3 / #8a8a8a`, accent white (`--accent-btn #fff` with `--on-accent #000`).
Light = white surfaces (`--bg #fff`, panel `#fafafa`, card `#f4f4f5`), text `#000 / #52525b / #6b6b75`, accent black (`--accent-btn #000` with `--on-accent #fff`). Gold is unchanged.
`--text-3` in light is #6b6b75 (not #71717a) so it stays >= 4.5:1 on `#f4f4f5` cards. Methodology node colours: prompt/condition = accent (neutral), command/checkpoint = amber, git-commit = green, ask-user = blue, artifact = muted (the type label and icon always accompany the colour).
The default dark code palettes (vs-dark, github-dark) are not applied under the light app theme (the CSS auto github-light is used); explicit choices (dracula, ...) are kept. Code text inside tool cards uses the code palette foreground (`--c-fg`).

### Agent identity
`components/agent-icon.js`: `agentIcon('claude' | 'agy', { size = 16, state = 'idle' | 'running' })` returns `<span class="agent-icon agent-icon--<agent> [is-running]">` with an inline SVG (aria-hidden). `setIconState(span, state)` toggles `is-running`.
- Claude: 12 rounded rays of different lengths/angles from a core, colour `--claude` (#D97757). Running: 10 s linear rotation of the SVG + a 3.2 s breathing scale/opacity pulse on the wrapper.
- AGY: original 4-point sparkle star. Four soft colour blobs (red top, yellow left, green bottom, blue right) are blurred and clipped to the star (unique `agy-clip-N` / `agy-blur-N` ids per icon; blobs instead of a linearGradient because a linear gradient cannot give one colour per tip). Running: the blob group rotates inside the static clip (colours circulate) + a twinkle scale/rotate pulse.
- Used by: assistant message label (agent of that turn), thinking rows, live status line, composer agent switch (selected segment = icon + orange outline for Claude / gradient border for AGY), sidebar project rows (replaces the folder glyph; the running dot is orange / conic gradient and pulses), title-bar chip `.titlebar__agent`, Activity tab dot (`.dot--agent.dot--claude|agy`), tool cards (`.tool-card[data-agent]` gets a 2px left stripe: orange / vertical gradient), method run panel header (`.rp[data-agent]`, 2px top rule).
- Running composer: `.composer[data-agent].is-running` glows (Claude: pulsing orange box-shadow; AGY: rotating conic gradient border via `@property --fs-angle` + soft glow).
- Live status text (`.live-status--claude|agy .live-status__text`): orange shimmer / flowing rainbow gradient with `background-clip:text`; without support the solid `--claude-text` / `--gemini-blue-t` shows. Everything animated stops under `prefers-reduced-motion`.

### Developer vs Simple mode
Setting `developerMode` (default true; `isDev(state)` in `lib/store.js`). Switch: pill `.titlebar__mode` in the title bar (`aria-pressed`, icon </> + "Dev" or smile + "Simple"), Settings toggle (`#set-devmode`), walkthrough step `mode` (two `.wt-mode` radio cards, step 2).
Developer = everything as before. Simple:
- `lib/plain.js` (pure): tool kind + path -> plain steps (`plain.step.*`: Created / Changed / Read / Searched the project / Looked around the folder / Tested your project - it worked or something failed / Ran your program / Waiting for your OK) and `summaryParts` ("I created 1 file and changed 1 file."). No code, diffs, commands, exit codes, tokens or tool names.
- Per turn: user message, `.plain-steps` ("What I did", status icons, "Show details" expands that turn's tool cards only; raw toggles stay hidden), the answer (markdown code blocks folded in `details.show-code` "Show code"), then `.plain-summary` with one "Open file" button per file (opens the Files tab). Thinking rows are hidden; the live line just says "Thinking..." / "Working on it...".
- Hidden: Activity tab, remote-control row and menu item, permission-mode jargon (friendly `mode.friendly.*` labels). The Git tab becomes "Changes" without the branch row.

### Approvals (blocked actions)
A tool result that says it needs approval/permission (`lib/approvals.js classifyBlocked`) or a `permission-denied` event for a known tool card puts that card in status `blocked` (amber, lock, never red). When the turn ends with blocked actions the reducer appends one `{ role: 'approval', status }` message; its items are derived from the turn (`blockedItems`).
```html
<div class="approval-card [is-resolved]" role="group">
  <div class="approval-card__head"><span class="approval-card__lock"/><div class="approval-card__titles">title + sub</div>[agent icon]</div>
  <ul class="approval-list"><li class="approval-item [approval-item--multi]">
    [<label class="approval-item__check"><input type="checkbox"></label>]   <!-- only with 2+ actions -->
    <div class="approval-item__body">
      <div class="approval-item__what">icon + <strong>Claude wants to run a command</strong></div>
      <div class="approval-item__why">plain reason (needs approval / outside the project / safety check)</div>
      <div class="approval-item__code">pre.approval-term "$ cmd" | .approval-diff (createDiffView) | pre.approval-raw</div>  <!-- Simple: wrapped in details.approval-more "See exactly what it will do" -->
    </div></li></ul>
  <div class="approval-card__actions">[Allow this once | Allow selected once] [Allow for this project] [Don't allow] <span class="approval-card__hint">Enter / Esc (Developer only)</span></div>
</div>
```
- Allow this once = re-send the last prompt of the turn with `allow: [{tool, pattern}]` (`allowPlan`/`ruleFor`: exact command for Bash/PowerShell, exact path for Write/Edit/MultiEdit/NotebookEdit; claude only, max 5, no `*`/parentheses). When a narrow rule is impossible (AGY, WebFetch, commands with parentheses...) the primary button becomes "Switch to Accept edits and retry" with an explanation.
- Allow for this project = confirm dialog, then `mode: acceptEdits` and retry. Don't allow = card resolved + a system note. The retry text carries a fixed note (`RETRY_NOTE`), shown in the chat as a small "Sent again with your permission" tag.
- Buttons exist only on the last turn while idle (`ctx.isActionable`); older approvals render without buttons ("no longer open").
- Browser mock: `lib/mock-phase6.js`; hash flags `#blocked` (blocked command, then the retry succeeds), `#blocked2` (blocked command + blocked file write = grouped card), `#simple` / `#dev` (preset developerMode). Combine with `#rich` flags using extra hashes, e.g. `#richclaude#simple`.

## Phase 7: images, models, usage, DeepSeek, menu bar, tasks, project store (styles/phase7.css)
New tokens (tokens.css): `--thumb-size` (attachment thumbnails, bubbles use 1.6x), `--gauge-h` (usage gauges). Everything else uses existing tokens (no raw colours), works in dark / light / gold, Developer + Simple, EN/ES, reduced motion.
- **Images** (`components/attachments.js`, `lib/images.js`): paste (Ctrl+V), drop on the chat (`.drop-overlay`, announced via a `role=status` sr-only line), paperclip + hidden `.att-input`, menu `edit.attachImage`. `.att-strip > .att` thumbnails with `.progress` and `.att__remove`; <= 5 images, <= 8 MB, png/jpeg/gif/webp. FileReader -> data: URL only (CSP has no blob:). `.chips > .chip` suggestions (5 with images, 3 starters on an empty chat); clicking inserts the prompt, never sends. User bubbles show `.msg__images`; click opens `components/lightbox.js` (dialog, Esc, focus trap).
- **Model + effort** (`components/model-picker.js`, `lib/models.js`): `.mp` menu button + `.mp__panel`, effort `select`. Simple mode: friendly names, "Speed vs quality" Fast / Balanced / Thorough; Developer: ids + five levels. Default model is stored as `null`.
- **Usage** (`lib/usage.js`, `components/usage-dialog.js`, `limit-card.js`): title-bar chip `.titlebar__usage--ok|amber|red`; `.gauge` (role=progressbar, `--ok|amber|red`); `.limit-card` (rejected, CLI text verbatim in a blockquote, aria-hidden live countdown every 30 s) and `.limit-note` (warning); banner via `computeBanners(..., usage)`. Reducer handles `limit` (one card per kind/status per turn, suppresses the duplicate error), `todos`, `subagent` (state only, no messages).
- **DeepSeek** (Settings, `lib/deepseek.js`): `.settings-ds`; the key is a password field, cleared after saving, never shown or logged.
- **Menu bar** (`components/menubar.js`, `lib/menu-state.js`, `lib/menu-actions.js`): `.mb` role=menubar in the title bar on win32/linux; ARIA keyboard table in `keyAction`, Alt+F/E/V/H, hover switches on real pointer moves; one action map for renderer actions, `menu.invoke` for main ones. Recent entries come with `literal:true`.
- **Tasks** (`components/tasks-panel.js`, `lib/tasks.js`): view `tasks` (rail, sidebar badge, title-bar chip, Ctrl+Shift+T).
- **Project store**: `project-data-dialog.js`, `project-settings-dialog.js` (developer override via `effectiveDeveloperMode(project, settings)`), header badge `.topbar__saved`.
- **UI state** (`lib/ui-state.js`, `lib/ui-persist.js`): restored before the first render, saved debounced 400 ms, flushed on `onBeforeQuit`, then `app.flushed()`; `app.ready()` after the first render.
- Mock flags: `#limit5h #limitweek #usagehigh #deepseek #tasks #images #nostore` (`lib/mock-phase7.js`).

## Phase 8: first-run setup + "What do you need help with?" (styles/phase8.css)
- **Setup wizard** (`components/setup-wizard.js`, pure steps in `lib/setup-steps.js`): opens at boot while `settings.walkthroughDone` is false and from Settings > "Run the setup walkthrough again" (`actions.openSetup`). Steps: language (two radio cards, heading in both languages, applies live), welcome, mode, look (dark / light / gold cards with fixed-palette previews), AI helpers, tools (Git / Node / Python with plain reasons), optional extras (usage, DeepSeek), storage, all set. Footer: Skip setup, Back, Skip this step, Next; Esc and Skip setup ask to confirm; finishing or leaving sets `walkthroughDone`. "Create my first project" opens the new-project wizard.
- **New-project wizard** (`components/walkthrough.js`, pure logic in `lib/cases.js`; `actions.openWalkthrough`): help (4 quick picks, searchable grid of `meta.kind === 'case'` methodologies with category chips, "Empty project") -> questions (generated from vars; only when the case has vars) -> name (prefilled "<case> - yyyy-mm-dd"; read-only line "Folder: <default dir>\<folderNameFromTitle>"; Developer mode only: "Advanced: choose another folder") -> AI helper (signed-in one preselected) -> ready (summary; files are COPIED into <project>/data, originals untouched). Start: `projects.newDir(name)` -> `projects.add` -> `files.import` per file var -> `method.run`; errors are inline with "Try again" (the created project and imported files are not repeated).
- **File vars** (`components/vars-form.js`): drop zone button + "Choose file..." (`files.pick({kind:'office'})`), chip with remove; drops only give a name hint, the picker gives the real path. The run dialog imports into the ACTIVE target project (`importFileVars`). Select vars with <= 4 short options render as segmented controls; textarea placeholders come from `var.placeholder`.
- Methodologies view: case methodologies show a "Case - <category>" badge.
- Mock: `lib/mock-phase8.js` (10 cases, files.pick/import, projects.defaultDir/newDir). Hash `#first` re-opens the setup.
