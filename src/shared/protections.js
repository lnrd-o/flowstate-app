// "Always ask" protections: actions that still need the user's OK even when the project runs in Auto-accept mode.
// Pure (no node / DOM imports): used by the main process (CLI args) and by the renderer (approval card wording).
//
// Mechanism, verified with the real claude CLI 2.1.330 (-p):
//  - `--disallowedTools "Bash(curl:*)"` deny rules DO still apply under --permission-mode bypassPermissions, and also under
//    acceptEdits. Deny beats allow. Read(...) deny rules also stop `cat .env` run through Bash. Prefix matching is
//    case-insensitive (`remove-item` == `Remove-Item`) and sees through `a && rm x` compound commands.
//  - bypassPermissions also writes/reads OUTSIDE the project and no deny glob can say "everything but the project", so when the
//    "outside the project" protection is on, Auto runs as `acceptEdits` + broad `--allowedTools` (Bash, PowerShell, WebFetch,
//    WebSearch, ...): everything still runs unattended, but a path outside the project is blocked and surfaces as a normal
//    permission request (-> approval card).
//  - "Allow this once" cannot add an exception to a deny rule (deny wins), so the retried turn is built WITHOUT the deny rules the
//    approved action matches (see unprotect in protectionPlan). Every other deny rule stays.

export const CATEGORIES = Object.freeze(['files', 'delete', 'install', 'network', 'git', 'outside']);

/** @returns {Record<string, boolean>} every category, missing / non-boolean values default to ON */
export function normalizeProtections(p) {
  const src = p && typeof p === 'object' ? p : {};
  const out = {};
  for (const c of CATEGORIES) out[c] = typeof src[c] === 'boolean' ? src[c] : true;
  return out;
}

/** Strict check for a stored/patched value: plain object, only known categories, boolean values. */
export function validProtections(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return false;
  return Object.keys(p).every((k) => CATEGORIES.includes(k) && typeof p[k] === 'boolean');
}

export const SHELLS = Object.freeze(['Bash', 'PowerShell']);
export const READ_TOOLS = Object.freeze(['Read']);
export const EDIT_TOOLS = Object.freeze(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

/** Command prefixes per category (matched case-insensitively at the start of every command segment). */
export const COMMAND_PREFIXES = Object.freeze({
  delete: ['rm', 'rmdir', 'del', 'erase', 'rd', 'Remove-Item', 'ri', 'mv', 'move', 'Move-Item', 'mi'],
  install: [
    'pip install', 'pip3 install', 'python -m pip install', 'python3 -m pip install', 'py -m pip install',
    'npm install', 'npm i', 'npm add', 'pnpm install', 'pnpm i', 'pnpm add', 'yarn install', 'yarn add',
    'winget install', 'choco install', 'brew install', 'apt install', 'apt-get install', 'npx',
  ],
  network: ['curl', 'wget', 'Invoke-WebRequest', 'iwr', 'Invoke-RestMethod', 'irm'],
  git: ['git push', 'git remote', 'git config'],
});

/** Sensitive file names (basename, case-insensitive) as claude globs + matching regexes. */
export const SENSITIVE_FILES = Object.freeze([
  { glob: '**/.env*', re: /^\.env/i },
  { glob: '**/*.pem', re: /\.pem$/i },
  { glob: '**/*.key', re: /\.key$/i },
  { glob: '**/id_rsa*', re: /^id_rsa/i },
  { glob: '**/credentials*', re: /^credentials/i },
  { glob: '**/secrets*', re: /^secrets/i },
]);
/** Folders (relative to the project) the agent must not write into. */
export const GUARDED_DIRS = Object.freeze(['.git', '.claude', '.flowstate']);

/** Tools that Auto-accept keeps allowed when it has to run as acceptEdits (the "outside the project" protection). */
export const BASE_ALLOW = Object.freeze(['Bash', 'PowerShell', 'WebFetch', 'WebSearch', 'Skill']);

// ---- path helpers (slash / backslash agnostic, case-insensitive: Windows is the primary platform) ----
export function normPath(p) {
  const s = String(p == null ? '' : p).replace(/\\/g, '/');
  const m = /^([a-z]:)?(\/)?(.*)$/i.exec(s);
  const drive = (m[1] || '').toLowerCase();
  const abs = !!m[2] || !!drive;
  const parts = [];
  for (const seg of m[3].split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { if (parts.length && parts[parts.length - 1] !== '..') parts.pop(); else if (!abs) parts.push('..'); continue; }
    parts.push(seg.toLowerCase());
  }
  return { drive, abs, parts };
}

/** Path relative to root as lowercase segments, or null when it is outside root (or not comparable). */
export function relSegments(p, root) {
  const n = normPath(p);
  if (!n.abs) return n.parts[0] === '..' ? null : n.parts;
  const r = normPath(root);
  if (!root || n.drive !== r.drive) return null;
  if (n.parts.length < r.parts.length) return null;
  for (let i = 0; i < r.parts.length; i++) if (n.parts[i] !== r.parts[i]) return null;
  return n.parts.slice(r.parts.length);
}

export const isOutside = (p, root) => !!root && !!p && relSegments(p, root) === null;

/** Does `command` (one string, possibly compound) start any segment with `prefix`? */
export function commandHasPrefix(command, prefix) {
  const pre = prefix.toLowerCase();
  for (const raw of String(command || '').split(/&&|\|\||;|\||\r?\n/)) {
    const seg = raw.trim().replace(/^[&(]\s*/, '').toLowerCase();
    if (seg === pre || seg.startsWith(pre + ' ') || seg.startsWith(pre + '\t')) return true;
  }
  return false;
}

/**
 * All deny entries: { cat, rule, test(call) } where call = { tool, command?, path?, root? }.
 * `rule` is the claude permission rule string; `test` says whether the call is what that rule would block.
 */
export function denyEntries() {
  const out = [];
  for (const f of SENSITIVE_FILES) {
    out.push({ cat: 'files', rule: `Read(${f.glob})`, test: (c) => READ_TOOLS.includes(c.tool) && !!c.path && f.re.test(normPath(c.path).parts.pop() || '') });
    out.push({ cat: 'files', rule: `Edit(${f.glob})`, test: (c) => EDIT_TOOLS.includes(c.tool) && !!c.path && f.re.test(normPath(c.path).parts.pop() || '') });
  }
  for (const d of GUARDED_DIRS) {
    out.push({
      cat: 'files', rule: `Edit(${d}/**)`,
      test: (c) => EDIT_TOOLS.includes(c.tool) && !!c.path && (relSegments(c.path, c.root) || []).slice(0, -1).includes(d),
    });
  }
  for (const [cat, prefixes] of Object.entries(COMMAND_PREFIXES)) {
    for (const prefix of prefixes) {
      for (const shell of SHELLS) out.push({ cat, rule: `${shell}(${prefix}:*)`, test: (c) => c.tool === shell && commandHasPrefix(c.command, prefix) });
    }
  }
  return out;
}

const ENTRIES = denyEntries();

/** Normalise an item/event input into a call for the entry tests. */
export function callOf(tool, input, root) {
  const i = input && typeof input === 'object' ? input : {};
  let path = '';
  for (const k of ['file_path', 'notebook_path', 'path', 'TargetFile']) if (typeof i[k] === 'string' && i[k]) { path = i[k]; break; }
  let command = '';
  for (const k of ['command', 'CommandLine']) if (typeof i[k] === 'string' && i[k]) { command = i[k]; break; }
  return { tool, path, command, root };
}

/**
 * Which protection categories does this action fall under? (ignores whether they are enabled). Ordered; may be empty.
 * @param {{tool:string, input?:object}} item
 */
export function categoriesOf(item, root) {
  if (!item || !item.tool) return [];
  const call = callOf(item.tool, item.input, root);
  const cats = [];
  for (const e of ENTRIES) if (e.test(call) && !cats.includes(e.cat)) cats.push(e.cat);
  if ([...READ_TOOLS, ...EDIT_TOOLS].includes(item.tool) && call.path && isOutside(call.path, root) && !cats.includes('outside')) cats.push('outside');
  return CATEGORIES.filter((c) => cats.includes(c));
}

/** The first ENABLED category of an action (the one the card explains), or null. Only meaningful while the project is in Auto mode. */
export function protectedCategory(item, protections, root) {
  const prot = normalizeProtections(protections);
  return categoriesOf(item, root).find((c) => prot[c]) ?? null;
}

/**
 * The CLI plan for Auto-accept mode with protections.
 * @param {object} protections project.protections (missing = all ON)
 * @param {Array<{tool:string, value:string}>} unprotect actions the user just approved ("Allow this once"): their matching deny rules are dropped for this turn only
 * @param {string} root project folder
 * @returns {null | {permissionMode:'bypassPermissions'|'acceptEdits', allow:string[], deny:string[]}} null = no protection active (plain bypassPermissions)
 */
export function protectionPlan(protections, unprotect, root) {
  const prot = normalizeProtections(protections);
  if (!CATEGORIES.some((c) => prot[c])) return null;
  const calls = (unprotect ?? []).map((u) => callOf(u.tool, EDIT_TOOLS.includes(u.tool) || READ_TOOLS.includes(u.tool) ? { file_path: u.value } : { command: u.value }, root));
  const deny = ENTRIES.filter((e) => prot[e.cat] && !calls.some((c) => e.test(c))).map((e) => e.rule);
  return prot.outside
    ? { permissionMode: 'acceptEdits', allow: [...BASE_ALLOW], deny }
    : { permissionMode: 'bypassPermissions', allow: [], deny };
}
