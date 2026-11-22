// Pure logic behind the approval card: classify "blocked by permissions" tool results, collect the blocked
// actions of a turn, decide what "Allow this once" can narrowly allow, and build the per-turn allow rules.
// No DOM. Mirrors the validation of src/main/permissions.js (the main process stays the authority).
import { kindOf, commandOf, displayPath, changeOf, baseName } from './activity.js';

export const ALLOW_TOOLS = Object.freeze(['Bash', 'PowerShell', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
export const MAX_RULES = 5;
export const MAX_PATTERN = 300;

const BLOCKED_RE = /requires?\s+(?:your\s+)?(?:approval|permission)|needs?\s+(?:your\s+)?(?:approval|permission)|permission\s+(?:required|to\s+use)|requested\s+permissions?|was\s+blocked|not\s+allowed\s+(?:to|in)|haven'?t\s+(?:granted|been\s+granted)|(?:hasn'?t|has\s+not)\s+been\s+granted|user\s+(?:has\s+)?(?:denied|rejected|doesn'?t\s+want)/i;
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

/**
 * The narrow allow rule for one blocked item, or null when it cannot be allowed one-at-a-time:
 * Bash / PowerShell -> the exact command; Write / Edit / MultiEdit / NotebookEdit -> the exact file path.
 */
export function ruleFor(item) {
  if (!item || !ALLOW_TOOLS.includes(item.tool)) return null;
  const isCmd = item.tool === 'Bash' || item.tool === 'PowerShell';
  const pattern = (isCmd ? commandInput(item.input) : pathInput(item.input)).trim();
  if (!validPattern(pattern)) return null;
  return { tool: item.tool, pattern };
}

/**
 * What the primary button does for the selected items (selectedIds: Set of item ids, or null for all).
 *   { mode: 'once', rules }       re-send with allow:[...]   (claude only, every selected item narrowable, 1..5 rules)
 *   { mode: 'switch', rules: [] } no narrow rule is possible: offer "Switch to Accept edits and retry"
 *   { mode: 'none', rules: [] }   nothing selected
 */
export function allowPlan(items, selectedIds, agent) {
  const sel = (items || []).filter((it) => !selectedIds || selectedIds.has(it.id));
  if (!sel.length) return { mode: 'none', rules: [] };
  if (agent !== 'claude') return { mode: 'switch', rules: [] };
  const rules = [];
  for (const it of sel) {
    const r = ruleFor(it);
    if (!r) return { mode: 'switch', rules: [] };
    if (!rules.some((x) => x.tool === r.tool && x.pattern === r.pattern)) rules.push(r);
  }
  if (rules.length > MAX_RULES) return { mode: 'switch', rules: [] };
  return { mode: 'once', rules };
}

/** Plain-language description of one blocked item: { key, vars } for i18n 'approval.wants.*'. `root` = project folder. */
export function describeItem(item, root) {
  const m = item.msg;
  const path = m ? displayPath(m, root) : pathInput(item.input).replace(/\\/g, '/');
  const file = path ? baseName(path) : '';
  if (item.kind === 'command') return { key: 'approval.wants.run', vars: {} };
  if (item.kind === 'write') {
    const ch = m ? changeOf(m) : null;
    const create = ch ? ch.op === 'create' : true;
    return file ? { key: create ? 'approval.wants.create' : 'approval.wants.edit', vars: { file } } : { key: 'approval.wants.createNoFile', vars: {} };
  }
  if (item.kind === 'edit') return file ? { key: 'approval.wants.edit', vars: { file } } : { key: 'approval.wants.editNoFile', vars: {} };
  return { key: 'approval.wants.use', vars: { tool: item.tool } };
}

/** i18n key of the plain-words reason. */
export function whyKey(reason) {
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
