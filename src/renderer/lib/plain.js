// Simple mode: plain-language "What I did" steps built from the same chat events as the technical cards.
// Pure (no DOM). Sentences are i18n keys 'plain.step.*' with vars; no code, commands, exit codes, tokens or tool names.
import { kindOf, changeOf, displayPath, commandOf, baseName } from './activity.js';

const TEST_RE = /(?:^|[\s;&|(])(?:pytest|py\.test|jest|vitest|mocha|unittest|rspec|phpunit|tox|nox|ctest)(?:\s|$)|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|t)\b|\bnode\s+--test\b|\bcargo\s+test\b|\bgo\s+test\b|\bdotnet\s+test\b|\bmvn\s+test\b|\bgradle(?:w)?\s+test\b|\bpython3?\s+-m\s+(?:pytest|unittest)\b|\bmake\s+test\b/i;

/** Does this command line look like running a project's tests? */
export function isTestCommand(cmd) {
  return TEST_RE.test(String(cmd || ''));
}

const PROGRESSIVE = { created: 'creating', changed: 'changing', deleted: 'deleting', read: 'reading', searched: 'searching', looked: 'looking', tested: 'testing', ran: 'running' };

/**
 * One plain step for a tool message:
 * { id, kind, key, vars, state: 'running'|'done'|'failed'|'blocked' }.
 */
export function plainStep(m, root) {
  const kind = kindOf(m);
  const running = m.status === 'running';
  const blocked = m.status === 'blocked';
  const failed = m.status === 'error' || (kind === 'command' && typeof m.exitCode === 'number' && m.exitCode !== 0);
  const state = blocked ? 'blocked' : running ? 'running' : failed ? 'failed' : 'done';
  const path = displayPath(m, root);
  const file = path ? baseName(path) : '';
  const out = (name, vars) => {
    let key = name;
    if (state === 'running' && PROGRESSIVE[name]) key = PROGRESSIVE[name];
    return { id: m.id, kind, key: 'plain.step.' + key, vars: vars || {}, state };
  };
  if (blocked) {
    if (kind === 'command') return { id: m.id, kind, key: 'plain.step.blockedRun', vars: {}, state };
    if (kind === 'write' || kind === 'edit') return { id: m.id, kind, key: 'plain.step.blockedFile', vars: { file: file || '?' }, state };
    return { id: m.id, kind, key: 'plain.step.blocked', vars: {}, state };
  }

  if (kind === 'command') {
    if (isTestCommand(commandOf(m))) {
      if (state === 'failed') return { id: m.id, kind, key: 'plain.step.testFailed', vars: {}, state };
      return out('tested');
    }
    if (state === 'failed') return { id: m.id, kind, key: 'plain.step.ranFailed', vars: {}, state };
    return out('ran');
  }
  if (kind === 'write' || kind === 'edit') {
    const ch = changeOf(m);
    const op = ch ? ch.op : kind === 'write' ? 'create' : 'modify';
    const f = file || '?';
    if (state === 'failed') return { id: m.id, kind, key: op === 'create' ? 'plain.step.createFailed' : 'plain.step.changeFailed', vars: { file: f }, state };
    if (op === 'delete') return out('deleted', { file: f });
    return out(op === 'create' ? 'created' : 'changed', { file: f });
  }
  if (kind === 'read') return state === 'failed' ? { id: m.id, kind, key: 'plain.step.stepFailed', vars: {}, state } : file ? out('read', { file }) : out('readNoFile');
  if (kind === 'search') return state === 'failed' ? { id: m.id, kind, key: 'plain.step.stepFailed', vars: {}, state } : out('searched');
  if (kind === 'list') return state === 'failed' ? { id: m.id, kind, key: 'plain.step.stepFailed', vars: {}, state } : out('looked');
  if (state === 'failed') return { id: m.id, kind, key: 'plain.step.stepFailed', vars: {}, state };
  return { id: m.id, kind, key: state === 'running' ? 'plain.step.otherRunning' : 'plain.step.other', vars: {}, state };
}

/** Plain steps for one turn, in order (tool messages only). */
export function plainSteps(messages, turnId, root) {
  const out = [];
  for (const m of messages || []) {
    if (m && m.role === 'tool' && m.turn === turnId) out.push(plainStep(m, root));
  }
  return out;
}

/** Friendly overall state of the steps list: 'running' | 'blocked' | 'failed' | 'done'. */
export function stepsState(steps) {
  if (steps.some((s) => s.state === 'running')) return 'running';
  if (steps.some((s) => s.state === 'blocked')) return 'blocked';
  return steps.some((s) => s.state === 'failed') ? 'failed' : 'done';
}

/**
 * Parts of the summary sentence from turn stats (lib/activity turnStats): [{ key, vars: { count } }] using
 * 'plain.sum.createdOne|createdMany|changedOne|changedMany|deletedOne|deletedMany'. Empty when no file changed.
 */
export function summaryParts(stats) {
  const files = (stats && stats.files) || [];
  const created = files.filter((f) => f.op === 'create').length;
  const deleted = files.filter((f) => f.op === 'delete').length;
  const changed = files.length - created - deleted;
  const parts = [];
  const add = (n, base) => { if (n > 0) parts.push({ key: 'plain.sum.' + base + (n === 1 ? 'One' : 'Many'), vars: { count: n } }); };
  add(created, 'created');
  add(changed, 'changed');
  add(deleted, 'deleted');
  return parts;
}

/** Files the user can open from the summary (not deleted ones): [{ path, op }]. */
export function openableFiles(stats) {
  return ((stats && stats.files) || []).filter((f) => f.op !== 'delete').map((f) => ({ path: f.path, op: f.op }));
}
