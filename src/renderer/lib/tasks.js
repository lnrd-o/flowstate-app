// Pure model for the Tasks / Agent manager panel. Input: TasksSnapshot (see src/shared/ipc.js) + the project list.
import { t } from './i18n.js';

export const SERVICE_KINDS = Object.freeze(['dashboard', 'remote', 'methodology', 'login', 'install', 'watcher', 'daemon']);

/** "1:23", "12:05", "1:02:09" from milliseconds. */
export function elapsedText(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h > 0 ? h + ':' + p(m) + ':' + p(sec) : m + ':' + p(sec);
}

/** Elapsed of a running agent now: prefer startedAt (ticks live between snapshots), else the snapshot's elapsedMs. */
export function agentElapsed(a, now = Date.now()) {
  if (a && Number.isFinite(a.startedAt)) return Math.max(0, now - a.startedAt);
  return a && Number.isFinite(a.elapsedMs) ? a.elapsedMs : 0;
}

/** { done, total, percent, current } for a todo list. */
export function todoProgress(items) {
  const list = Array.isArray(items) ? items : [];
  const done = list.filter((i) => i && i.status === 'completed').length;
  const cur = list.find((i) => i && i.status === 'in_progress');
  return { done, total: list.length, percent: list.length ? Math.round((done / list.length) * 100) : 0, current: cur ? cur.content : null };
}

const projectName = (projects, id, fallback) => {
  const p = (projects || []).find((x) => x.id === id);
  return (p && p.name) || fallback || id || '';
};

/**
 * Group a snapshot for display.
 * -> { agents, services, todos:[{projectId, projectName, items, done, total, percent, current}], subagents, runningCount, counts }
 * Todo lists with unfinished work come first, then by project name.
 */
export function groupTasks(snapshot, projects) {
  const s = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const agents = (Array.isArray(s.agents) ? s.agents : []).map((a) => ({ ...a, projectName: projectName(projects, a.projectId, a.projectName) }));
  const services = (Array.isArray(s.services) ? s.services : []).map((x) => ({ ...x, projectName: x.projectId ? projectName(projects, x.projectId) : '' }));
  const todos = Object.entries(s.todos && typeof s.todos === 'object' ? s.todos : {})
    .filter(([, items]) => Array.isArray(items) && items.length)
    .map(([projectId, items]) => ({ projectId, projectName: projectName(projects, projectId), items, ...todoProgress(items) }))
    .sort((a, b) => (a.done === a.total) - (b.done === b.total) || a.projectName.localeCompare(b.projectName));
  const subagents = (Array.isArray(s.subagents) ? s.subagents : []).map((x) => ({ ...x, projectName: projectName(projects, x.projectId) }));
  return {
    agents, services, todos, subagents,
    runningCount: agents.length + services.length,
    counts: {
      agents: agents.length, services: services.length, todos: todos.length, subagents: subagents.length,
      runningSubagents: subagents.filter((x) => x.state === 'running').length,
    },
  };
}

/** Number shown in the sidebar badge / title-bar chip: running agents + background tasks. */
export function taskCount(snapshot) {
  const s = snapshot || {};
  return (Array.isArray(s.agents) ? s.agents.length : 0) + (Array.isArray(s.services) ? s.services.length : 0);
}

/** i18n key of a state badge + its tone. */
export function stateBadge(state) {
  const known = ['running', 'waiting', 'starting', 'committing', 'done', 'error'].includes(state);
  const tone = state === 'running' || state === 'committing' ? 'green' : state === 'error' ? 'red' : state === 'done' ? 'muted' : 'amber';
  return { key: 'tasks.state.' + (known ? state : 'running'), tone };
}

/** Title of a background task. Simple mode uses plain wording and hides raw labels (pids, ids). */
export function serviceTitle(svc, dev) {
  const kind = SERVICE_KINDS.includes(svc.kind) ? svc.kind : 'daemon';
  if (dev) return svc.label || t('tasks.kind.' + kind);
  return t('tasks.kindPlain.' + kind);
}

/** Does a stop need a confirm dialog? (stopping an agent turn or a run loses work in progress) */
export function stopNeedsConfirm(kind) { return kind === 'agent' || kind === 'methodology'; }
