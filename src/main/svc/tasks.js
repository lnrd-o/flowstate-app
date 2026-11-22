// Tasks snapshot: running agent turns, background services (dashboards, remote control, methodology runs, sign-in, file watcher),
// the agents' own todo lists and sub-agents. Rebuilt on a 1 s unref'd timer; pushed on change, at most twice per second.
import { CH } from '../../shared/ipc.js';

export const POLL_MS = 1000;
export const PUSH_MIN_MS = 500;
const MAX_SUBAGENTS = 50;
const SUBAGENT_KEEP_MS = 5 * 60 * 1000;

const safe = (fn, fallback) => { try { return fn() ?? fallback; } catch { return fallback; } };

export function createTasks({
  projects, agents, dashboards = null, remote = null, runner = null, login = null, files = null, push = () => {},
  now = Date.now, setIntervalFn = setInterval, clearIntervalFn = clearInterval, pollMs = POLL_MS,
} = {}) {
  const todos = new Map();      // projectId -> items
  const subagents = [];         // {projectId, id, name, description, state, startedAt, endedAt?}
  let timer = null;
  let lastSig = '';
  let lastPushAt = 0;

  const label = (projectId) => projects.get(projectId)?.name ?? projectId;

  function snapshot() {
    const t = now();
    const agentRows = safe(() => agents.listRunning(), []).map((a) => ({
      projectId: a.projectId, projectName: label(a.projectId), agent: a.agent, state: a.state, startedAt: a.startedAt,
      elapsedMs: Math.max(0, t - (a.startedAt ?? t)), ...(a.pid ? { pid: a.pid } : {}),
    }));
    const services = [];
    for (const d of safe(() => dashboards?.list(), [])) {
      services.push({ kind: 'dashboard', id: d.projectId, projectId: d.projectId, label: `${label(d.projectId)}: ${d.app ?? 'dashboard'}`, state: 'running', url: d.url, startedAt: d.startedAt, stoppable: true });
    }
    for (const r of safe(() => remote?.list(), [])) {
      services.push({ kind: 'remote', id: r.projectId, projectId: r.projectId, label: `${label(r.projectId)}: remote control (${r.agent})`, state: 'running', startedAt: r.startedAt, stoppable: true });
    }
    for (const r of safe(() => runner?.listActive(), [])) {
      services.push({ kind: 'methodology', id: r.runId, projectId: r.projectId, label: `${label(r.projectId)}: ${r.methodologyId}`, state: r.status === 'waiting' ? 'waiting' : 'running', startedAt: r.startedAt, stoppable: true });
    }
    for (const s of safe(() => login?.sessions(), [])) {
      services.push({ kind: 'login', id: s.agent, label: `Sign-in: ${s.agent}`, state: 'waiting', startedAt: s.startedAt, stoppable: true });
    }
    for (const w of safe(() => files?.watching(), [])) {
      services.push({ kind: 'watcher', id: w.projectId, projectId: w.projectId, label: `${label(w.projectId)}: file watcher`, state: 'running', startedAt: w.startedAt, stoppable: true });
    }
    const cutoff = t - SUBAGENT_KEEP_MS;
    for (let i = subagents.length - 1; i >= 0; i--) if (subagents[i].endedAt && subagents[i].endedAt < cutoff) subagents.splice(i, 1);
    return {
      at: t, agents: agentRows, services,
      todos: Object.fromEntries([...todos].map(([k, v]) => [k, v.map((x) => ({ ...x }))])),
      subagents: subagents.map(({ endedAt, ...rest }) => ({ ...rest })),
    };
  }

  const sigOf = (s) => JSON.stringify({ ...s, at: 0, agents: s.agents.map(({ elapsedMs, ...r }) => r) });

  function tick(force = false) {
    const s = snapshot();
    const sig = sigOf(s);
    if (sig === lastSig) return;
    if (!force && now() - lastPushAt < PUSH_MIN_MS) return; // next tick retries (lastSig unchanged)
    lastSig = sig;
    lastPushAt = now();
    try { push(CH.evTasks, s); } catch { /* ignore */ }
  }

  const ensureTimer = () => {
    if (timer) return;
    timer = setIntervalFn(() => tick(), pollMs);
    timer?.unref?.();
  };
  ensureTimer();

  return {
    snapshot,
    list: () => snapshot(),
    tick,
    onAgentEvent(projectId, ev, meta) {
      if (!ev || typeof ev !== 'object') return;
      if (ev.type === 'todos' && Array.isArray(ev.items)) {
        if (ev.items.length) todos.set(projectId, ev.items.map((i) => ({ content: String(i.content), status: i.status })));
        else todos.delete(projectId);
      } else if (ev.type === 'subagent' && typeof ev.id === 'string') {
        const cur = subagents.find((x) => x.projectId === projectId && x.id === ev.id);
        if (cur) { cur.state = ev.state ?? cur.state; if (cur.state !== 'running') cur.endedAt = now(); }
        else {
          subagents.push({ projectId, id: ev.id, name: String(ev.name ?? 'agent'), ...(ev.description ? { description: String(ev.description) } : {}), state: ev.state ?? 'running', startedAt: now(), ...(ev.state && ev.state !== 'running' ? { endedAt: now() } : {}) });
          while (subagents.length > MAX_SUBAGENTS) subagents.shift();
        }
      } else if (ev.type === 'tool-result') {
        const cur = subagents.find((x) => x.projectId === projectId && x.id === ev.id && x.state === 'running');
        if (cur) { cur.state = ev.isError ? 'error' : 'done'; cur.endedAt = now(); }
      } else if (ev.type === 'result' || ev.type === 'error') {
        // a turn ended: anything still running under it is over
        for (const x of subagents) if (x.projectId === projectId && x.state === 'running') { x.state = ev.type === 'error' ? 'error' : 'done'; x.endedAt = now(); }
      } else return;
      tick();
    },
    /** -> {ok, error?} */
    async stop({ kind, id } = {}) {
      try {
        // only things that are actually running can be stopped
        const s = snapshot();
        const listed = kind === 'agent' ? s.agents.some((a) => a.projectId === id) : s.services.some((x) => x.kind === kind && x.id === id);
        if (!['agent', 'dashboard', 'remote', 'methodology', 'login', 'watcher'].includes(kind)) return { ok: false, error: 'unknown-kind' };
        if (!listed) return { ok: false, error: 'not-running' };
        switch (kind) {
          case 'agent': agents.stop(id); break;
          case 'dashboard': dashboards.stop(id); break;
          case 'remote': await remote.stop(id); break;
          case 'methodology': runner.stop(id); break;
          case 'login': login.cancel(id); break;
          case 'watcher': files.closeWatcher(id); break;
          default: return { ok: false, error: 'unknown-kind' };
        }
      } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
      tick(true);
      return { ok: true };
    },
    dispose() { if (timer) { clearIntervalFn(timer); timer = null; } },
  };
}

export function create(deps) {
  return createTasks({
    projects: deps.projects, agents: deps.agents, dashboards: deps.dashboards, remote: deps.remote, runner: deps.runner, login: deps.login, files: deps.files,
    push: deps.push,
  });
}
