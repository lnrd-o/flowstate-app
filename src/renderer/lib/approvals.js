// Pure logic behind the approval card: classify "blocked by permissions" tool results, collect the blocked
// actions of a turn, decide what "Allow this once" can narrowly allow, and build the per-turn allow rules.
// No DOM. Mirrors the validation of src/main/permissions.js (the main process stays the authority).
import { kindOf, commandOf, displayPath, changeOf, baseName } from './activity.js';
import { protectedCategory } from '../../shared/protections.js';

export const ALLOW_TOOLS = Object.freeze(['Bash', 'PowerShell', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Read', 'WebFetch', 'WebSearch']);
export const MAX_RULES = 5;
export const MAX_PATTERN = 300;

const BLOCKED_RE = /requires?\s+(?:your\s+)?(?:approval|permission)|needs?\s+(?:your\s+)?(?:approval|permission)|permission\s+(?:required|to\s+use)|requested\s+permissions?|was\s+blocked|not\s+allowed\s+(?:to|in)|haven'?t\s+(?:granted|been\s+granted)|(?:hasn'?t|has\s+not)\s+been\s+granted|user\s+(?:has\s+)?(?:denied|rejected|doesn'?t\s+want)|has\s+been\s+denied|denied\s+by\s+your\s+permission/i;
const OUTSIDE_RE = /outside\s+(?:of\s+)?(?:the\s+)?(?:project|working|allowed)|working\s+director|workingDir/i;
const SAFETY_RE = /safety\s*check|safetyCheck|dangerous|sensitive|protected\s+(?:file|path)/i;

/** Normalise a reason (event reason code or message text) to 'workingDir' | 'safetyCheck' | 'approval'. */
export function reasonOf(reason, text) {
  const r = String(reason || '');
  const s = r + ' ' + String(text || '');
  if (/workingDir/i.test(r) || OUTSIDE_RE.test(s)) return 'workingDir';
  if (/safetyCheck/i.test(r) || SAFETY_RE.test(s)) return 'safetyCheck';
  return 'approval';
}

/**
 * Does this tool-result text say the action was blocked because it needs approval / permission?
 * Returns { blocked: true, reason } or { blocked: false }. Only meaningful for error results.
 */
export function classifyBlocked(text) {
  const s = String(text == null ? '' : text);
  if (!s || !BLOCKED_RE.test(s)) return { blocked: false };
  return { blocked: true, reason: reasonOf('', s) };
}

function toolKindByName(name) {
  const n = String(name || '').toLowerCase();
  if (n === 'bash' || n === 'powershell' || n === 'run_command') return 'command';
  if (n === 'write') return 'write';
  if (n === 'edit' || n === 'multiedit' || n === 'notebookedit') return 'edit';
  if (n === 'read') return 'read';
  if (n === 'webfetch' || n === 'websearch') return 'web';
  return 'other';
}

function pathInput(input) {
  if (!input || typeof input !== 'object') return '';
  for (const k of ['file_path', 'notebook_path', 'path', 'TargetFile']) if (typeof input[k] === 'string' && input[k]) return input[k];
  return '';
}

function commandInput(input) {
  if (!input || typeof input !== 'object') return '';
  for (const k of ['command', 'CommandLine']) if (typeof input[k] === 'string' && input[k]) return input[k];
  return '';
}

/**
 * Blocked actions of one turn, in order: [{ id, toolId, tool, kind, input, reason, message, source: 'tool'|'permission', msg }].
 * Sources: tool cards with status 'blocked' and orphan permission messages (denied without a matching tool card).
 */
export function blockedItems(messages, turnId) {
  const out = [];
  for (const m of messages || []) {
    if (!m || m.turn !== turnId) continue;
    if (m.role === 'tool' && m.status === 'blocked') {
      const kind = kindOf(m);
      out.push({
        id: m.id, toolId: m.toolId, tool: m.name, kind: kind === 'write' || kind === 'edit' || kind === 'command' ? kind : toolKindByName(m.name), input: m.input ?? null,
        reason: (m.blocked && m.blocked.reason) || 'approval', message: (m.blocked && m.blocked.message) || '', source: 'tool', msg: m,
      });
    } else if (m.role === 'permission' && m.status === 'pending' && m.kind === 'denied') {
      const tool = m.tool || 'tool';
      out.push({
        id: m.id, toolId: m.toolId, tool, kind: toolKindByName(tool), input: m.input ?? null, reason: reasonOf(m.reason, m.message), message: m.message || '', source: 'permission', msg: null,
      });
    }
  }
  return out;
}

/** Valid pattern per the main process rules (exact, no wildcards, no parentheses, no control chars, <= 300). */
export function validPattern(p) {
  if (typeof p !== 'string' || !p.trim()) return false;
  if (p.length > MAX_PATTERN) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(p)) return false;
  if (/[*()]/.test(p)) return false;
  return true;
}

/** Strict hostname (mirror of main validDomain): lowercase DNS name with a dot, or an IPv4 literal. */
export function validDomain(d) {
  if (typeof d !== 'string') return false;
  const s = d.trim().toLowerCase();
  if (/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(s)) return true;
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(s) && s.split('.').every((n) => Number(n) <= 255);
}

/** Hostname of a URL ('' when it is not a plain http(s) URL with a valid host). */
export function hostOf(url) {
  if (typeof url !== 'string' || !url.trim()) return '';
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url.trim()) ? url.trim() : 'https://' + url.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    const host = u.hostname.toLowerCase();
    return validDomain(host) ? host : '';
  } catch { return ''; }
}

/** URL / search query of a web item (for display). */
export function webTarget(item) {
  const i = item && item.input && typeof item.input === 'object' ? item.input : {};
  if (item && item.tool === 'WebSearch') return typeof i.query === 'string' ? i.query : '';
  return typeof i.url === 'string' ? i.url : '';
}

/** Does this shell command write through a redirect ( > or >> )? Such a command cannot be narrowed by a command rule (verified with claude). */
export function hasRedirect(cmd) {
  return />/.test(String(cmd || ''));
}

/**
 * The narrow allow rule for one blocked item, or null when it cannot be allowed one-at-a-time:
 * Bash / PowerShell -> the exact command (null when it redirects output into a file: claude ignores command rules then);
 * Write / Edit / MultiEdit / NotebookEdit -> the exact file path (main emits Edit(path));
 * WebFetch -> its domain; WebSearch -> tool-wide (it has no pattern).
 */
export function ruleFor(item) {
  if (!item || !ALLOW_TOOLS.includes(item.tool)) return null;
  if (item.tool === 'WebSearch') return { tool: 'WebSearch', pattern: '' };
  if (item.tool === 'WebFetch') {
    const host = hostOf(webTarget(item));
    return host ? { tool: 'WebFetch', pattern: 'domain:' + host } : null;
  }
  const isCmd = item.tool === 'Bash' || item.tool === 'PowerShell';
  const pattern = (isCmd ? commandInput(item.input) : pathInput(item.input)).trim();
  if (!validPattern(pattern)) return null;
  if (isCmd && hasRedirect(pattern)) return null;
  return { tool: item.tool, pattern };
}

/**
 * Mode "Allow for this project" switches to: 'acceptEdits' when everything selected is a file edit / redirect write,
 * otherwise 'auto' (commands and web access are not covered by Accept edits).
 */
export function projectModeFor(items, selectedIds) {
  const sel = (items || []).filter((it) => !selectedIds || selectedIds.has(it.id));
  return sel.length && sel.every((it) => it.kind === 'write' || it.kind === 'edit') ? 'acceptEdits' : 'auto';
}

/**
 * The "Always asked" category of a blocked item (files|delete|install|network|git|outside) or null. Only claude in Auto-accept mode
 * has protections. ctx = { agent, mode, protections (project setting, missing = all ON), root (project folder) }.
 */
export function protectionOf(item, ctx) {
  if (!ctx || ctx.agent !== 'claude' || ctx.mode !== 'auto' || !item) return null;
  return protectedCategory({ tool: item.tool, input: item.input }, ctx.protections, ctx.root);
}

/** What a protected item hands to the main process so only ITS deny rules are lifted for the retried turn: {tool, value} or null. */
export function unprotectFor(item) {
  if (!item) return null;
  const isCmd = item.tool === 'Bash' || item.tool === 'PowerShell';
  const value = (isCmd ? commandInput(item.input) : pathInput(item.input)).trim();
  return value && value.length <= 4000 ? { tool: item.tool, value } : null;
}

/**
 * What the primary button does for the selected items (selectedIds: Set of item ids, or null for all).
 *   { mode: 'once', rules, unprotect, protectedSelected } re-send with allow:[...] (+ unprotect:[...] for protected items)  (claude only)
 *   { mode: 'switch', rules: [] }  no narrow rule is possible: offer "Switch to Accept edits and retry"
 *   { mode: 'none', rules: [] }    nothing selected
 * ctx (optional, see protectionOf): a protected item can be allowed once even when its command / path cannot be a narrow CLI rule
 * (in Auto only its deny rules are lifted), but it can NEVER be allowed "for the project": protectedSelected hides that button.
 */
export function allowPlan(items, selectedIds, agent, ctx) {
  const sel = (items || []).filter((it) => !selectedIds || selectedIds.has(it.id));
  if (!sel.length) return { mode: 'none', rules: [] };
  if (agent !== 'claude') return { mode: 'switch', rules: [] };
  const rules = [];
  const unprotect = [];
  let protectedSelected = false;
  for (const it of sel) {
    const cat = protectionOf(it, ctx);
    const r = ruleFor(it);
    if (cat) {
      protectedSelected = true;
      const u = unprotectFor(it);
      if (!u) return { mode: 'switch', rules: [], protectedSelected };
      if (!unprotect.some((x) => x.tool === u.tool && x.value === u.value)) unprotect.push(u);
    }
    if (!r) { if (cat) continue; return { mode: 'switch', rules: [] }; }
    if (!rules.some((x) => x.tool === r.tool && x.pattern === r.pattern)) rules.push(r);
  }
  if (rules.length > MAX_RULES || unprotect.length > 10) return { mode: 'switch', rules: [], protectedSelected };
  return protectedSelected ? { mode: 'once', rules, unprotect, protectedSelected } : { mode: 'once', rules };
}

/** Plain-language description of one blocked item: { key, vars } for i18n 'approval.wants.*'. `root` = project folder. */
export function describeItem(item, root) {
  const m = item.msg;
  const path = m ? displayPath(m, root) : pathInput(item.input).replace(/\\/g, '/');
  const file = path ? baseName(path) : '';
  if (item.kind === 'command') return { key: 'approval.wants.run', vars: {} };
  if (item.kind === 'read') return file ? { key: 'approval.wants.read', vars: { file } } : { key: 'approval.wants.readNoFile', vars: {} };
  if (item.kind === 'web') {
    if (item.tool === 'WebSearch') return { key: 'approval.wants.search', vars: {} };
    const host = hostOf(webTarget(item));
    return host ? { key: 'approval.wants.fetch', vars: { site: host } } : { key: 'approval.wants.fetchNoSite', vars: {} };
  }
  if (item.kind === 'write') {
    const ch = m ? changeOf(m) : null;
    const create = ch ? ch.op === 'create' : true;
    return file ? { key: create ? 'approval.wants.create' : 'approval.wants.edit', vars: { file } } : { key: 'approval.wants.createNoFile', vars: {} };
  }
  if (item.kind === 'edit') return file ? { key: 'approval.wants.edit', vars: { file } } : { key: 'approval.wants.editNoFile', vars: {} };
  return { key: 'approval.wants.use', vars: { tool: item.tool } };
}

/** i18n key of the plain-words reason. */
export function whyKey(reason, category) {
  if (category) return 'approval.why.protected.' + category;
  return reason === 'workingDir' ? 'approval.why.workingDir' : reason === 'safetyCheck' ? 'approval.why.safetyCheck' : 'approval.why.approval';
}

/** Command text of an item (for the terminal block), '' when it is not a command. */
export function itemCommand(item) {
  if (item.kind !== 'command') return '';
  return item.msg ? commandOf(item.msg) : commandInput(item.input);
}

/** Fixed (not localised) note appended to the re-sent prompt so the agent knows it may proceed. */
export const RETRY_NOTE = 'Permission granted for this step: please go ahead and retry the request above.';

/** Remove a trailing RETRY_NOTE (so a second retry does not stack notes). */
export function stripRetryNote(text) {
  const s = String(text == null ? '' : text);
  const tail = '\n\n' + RETRY_NOTE;
  return s.endsWith(tail) ? s.slice(0, -tail.length) : s;
}
