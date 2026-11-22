# "Always ask" protections (Auto-accept mode)

Auto-accept ("auto") normally means `claude --permission-mode bypassPermissions` / `agy --mode auto`: nothing is asked. Protections keep a
short list of risky actions behind the user's OK even there. Pure logic: `src/shared/protections.js` (used by main for CLI args and by the
renderer for the approval card wording). Per-project toggles live in `project.protections` (`{files, delete, install, network, git, outside}`,
missing = ON), persisted like the other project settings (`projects.json` + `<project>/.flowstate/project.json`) and edited in
Project settings -> "Always ask, even in Auto-accept".

| Category | Blocked |
|---|---|
| files | Read/Edit/Write of `.env*`, `*.pem`, `*.key`, `id_rsa*`, `credentials*`, `secrets*`; writes into `.git/`, `.claude/`, `.flowstate/` |
| delete | `rm rmdir del erase rd Remove-Item ri mv move Move-Item mi` |
| install | `pip/pip3 install`, `python -m pip install`, `npm install/i/add`, `pnpm install/i/add`, `yarn install/add`, `winget/choco/brew/apt/apt-get install`, `npx` |
| network | `curl wget Invoke-WebRequest iwr Invoke-RestMethod irm` (commands only; the WebFetch / WebSearch tools stay allowed) |
| git | `git push`, `git remote`, `git config` |
| outside | Read / Write / Edit outside the project folder |

## Mechanism for claude (verified with claude 2.1.330, `-p`, Windows)

* `--disallowedTools "Bash(curl:*)"` deny rules **do** apply under `bypassPermissions` (and under `acceptEdits`); deny beats allow.
  `Read(**/.env*)` also stops `cat .env` run through Bash. Prefix matching is case-insensitive and sees through `a && rm x`.
  Rules are emitted for both the `Bash` and the `PowerShell` tool.
* `bypassPermissions` also reads/writes outside the project, and no deny glob can express "everything except the project". So with the
  `outside` protection ON (default) Auto runs as `--permission-mode acceptEdits` + `--allowedTools Bash PowerShell WebFetch WebSearch Skill`:
  everything else still runs unattended, an outside path is refused with "requested permissions ..." (same flow as before).
  With `outside` OFF it stays `bypassPermissions` + deny rules. With every category OFF it is the plain `bypassPermissions`.
* Blocked results: Bash deny -> `system/permission_denied` ("Permission to use Bash with command ... has been denied."); Read/Write deny ->
  only a tool_result error ("... denied by your permission settings."). Both are recognised as blocked (`classifyBlocked`), so the
  approval card appears.
* "Allow this once": a deny rule cannot have an exception, so the retried turn (`agent.send({..., unprotect:[{tool, value}]})`) is built
  WITHOUT the deny rules the approved command/path matches (`protectionPlan`); all other deny rules stay. For an outside path the usual
  per-turn `Edit(path)` / `Read(path)` allow rule is sent too. `unprotect` is validated (`sanitizeUnprotect`), never reaches the CLI as a
  rule and is never persisted. Side effect: within that one turn the whole matching rule is lifted (e.g. approving `rm a.txt` lifts
  `Bash(rm:*)` for that turn).
* "Allow for this project" is not offered for protected items (it would only be refused again).

## agy

`agy --help` (1.5.x) has no deny/allow rule flag (`--settings` takes "settings.json keys" but no permission schema is documented, and a test
with `permissions.deny` did not block `curl`; also `--mode auto` printed "not available for this account" in that test). So `--mode auto` has
**no** guard: protections apply to Claude only. The Auto confirmation dialog and the project settings say so explicitly.

## Known limits

* Prefix rules, not a shell parser: `python -c "import os; os.remove('x')"`, `cmd /c del x`, PowerShell aliases not listed, or a script that
  deletes files are not caught. Writes by a shell redirect into `.env` are only caught when claude's own Edit rule sees them.
* Sensitive-file rules match by name anywhere in the tree (`**/`); `.git/`, `.claude/`, `.flowstate/` guards are for the project root only.
* MCP tools and anything outside `BASE_ALLOW` are not auto-allowed in the acceptEdits form of Auto (they would surface as a normal request).
