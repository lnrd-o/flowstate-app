import crypto from 'node:crypto';
import { ClaudeAdapter } from './claude.js';
import { AgyAdapter } from './agy.js';
import { OpencodeAdapter } from './opencode.js';
import { routeOf } from './routes.js';
import { createChangeTracker } from '../changes.js';
import { sanitizeAllow } from '../permissions.js';
import { loadAttachmentImages } from '../svc/attachments.js';

/**
 * Owns one running child per project. Deps are injected:
 *  projects {get, update}, resolveLauncher(agent) -> Promise<{command, baseArgs?}|null>, emit(projectId, event),
 *  git {autoCommit}, spawn, kill, history {recordUser}.
 */
export function createAgentManager({ projects, resolveLauncher, emit, git, spawn, kill, adapters, history, changes = createChangeTracker(), routeEnv, contextNote }) {
  // contextNote(project, text) -> Promise<string|null> : short note appended to the prompt sent to the agent (never stored in history), e.g. which Python interpreter to use.
  // routeEnv(project, route) -> {env}|{error}|null : per-turn child env for a route (DeepSeek key from safeStorage). Main only; the key never leaves it.
  const ad = adapters ?? { claude: new ClaudeAdapter(), agy: new AgyAdapter(), opencode: new OpencodeAdapter() };
  const running = new Map(); // projectId -> handle | null (starting)
  const committing = new Map(); // projectId -> Promise (auto-commit after a finished turn)
  const finished = new Set(); // projectIds whose current turn already emitted result/error (process may still be exiting)
  const meta = new Map(); // projectId -> {agent, startedAt, pid} of the running turn (tasks service: listRunning)
  const commitStart = new Map(); // projectId -> {agent, startedAt} while an auto-commit runs

  return {
    // "running" also covers the post-turn auto-commit so the methodology runner never races it.
    status: (projectId) => ({ running: running.has(projectId) || committing.has(projectId) }),

    /** agent/mode: optional per-turn override (methodology runner); the stored project is never changed by it. */
    /** allow: optional per-turn narrow permission rules [{tool, pattern}] (claude only; validated in permissions.js, never persisted). */
    async send({ projectId, text, agent, mode, allow, images }) {
      const base = projects.get(projectId);
      if (!base) throw new Error('Unknown project');
      const project = { ...base };
      project.allow = sanitizeAllow(allow); // throws TypeError on anything invalid
      const switched = agent !== undefined && agent !== base.agent;
      if (agent !== undefined) project.agent = agent;
      if (mode !== undefined) project.mode = mode;
      if (switched) { project.sessionId = null; project.model = null; project.effort = null; } // a session / model belongs to one agent
      if (typeof text !== 'string' || !text.trim()) throw new TypeError('text must be a non-empty string');
      // A follow-up sent while the previous turn's auto-commit is still running waits for it (instead of being rejected).
      // Likewise when the previous turn already emitted its result/error but its process has not exited yet.
      for (let i = 0; i < 20; i++) {
        if (committing.has(projectId)) { await committing.get(projectId); continue; }
        const h = running.get(projectId);
        if (h && finished.has(projectId)) {
          await Promise.race([Promise.resolve(h.done).catch(() => {}), new Promise((res) => setTimeout(res, 5000))]);
          if (running.get(projectId) === h) break; // did not exit in time: fall through to the 'already running' error
          continue;
        }
        break;
      }
      if (running.has(projectId)) throw new Error('Agent already running for this project');
      const adapter = ad[project.agent];
      if (!adapter) throw new Error(`Unknown agent: ${project.agent}`);
      // Resume ids are not portable between routes: a session started on another route is dropped (fresh session + visible note).
      const route = routeOf(project);
      let routeNote = false;
      if (project.sessionId && (base.sessionRoute ?? 'anthropic') !== route && !(project.agent !== 'claude' && base.sessionRoute == null)) { project.sessionId = null; routeNote = true; }
      let extraEnv;
      if (routeEnv) {
        const r = await routeEnv(project, route);
        if (r?.error) throw new Error(r.error);
        extraEnv = r?.env;
      }
      let imgs = [];
      if (images !== undefined) imgs = loadAttachmentImages(project, images, { withData: project.agent === 'claude' }); // throws before anything starts
      let runText = text;
      if (contextNote) { try { const note = await contextNote({ ...project, id: projectId }, text); if (note) runText = `${text}

${note}`; } catch { /* best effort */ } }
      running.set(projectId, null);
      meta.set(projectId, { agent: project.agent, startedAt: Date.now(), pid: null });
      let handle;
      try {
        const launcher = await resolveLauncher(project.agent);
        if (!launcher) throw new Error(`${project.agent} executable not found`);
        handle = adapter.run({
          project, text: runText, launcher, spawn, kill, images: imgs, env: extraEnv,
          emit: (event) => {
            if (event?.type === 'result' || event?.type === 'error') finished.add(projectId);
            let extra = [];
            try { extra = changes.observe({ ...project, id: projectId }, event) ?? []; } catch { /* best effort */ }
            emit(projectId, event, { agent: project.agent, route });
            for (const fc of extra) emit(projectId, fc, { agent: project.agent, route }); // file-change goes out right after the tool-result that produced it
          },
          onSession: (sessionId) => {
            const cur = projects.get(projectId);
            if (!switched && (cur?.sessionId !== sessionId || cur?.sessionRoute !== route)) projects.update(projectId, { sessionId, sessionRoute: route });
          },
        });
      } catch (e) {
        running.delete(projectId);
        meta.delete(projectId);
        finished.delete(projectId);
        throw e;
      }
      running.set(projectId, handle);
      if (routeNote) { try { emit(projectId, { type: 'notice', key: 'chat.routeChanged' }, { agent: project.agent }); } catch { /* best effort */ } }
      const m = meta.get(projectId);
      if (m) m.pid = handle.child?.pid ?? null;
      try { history?.recordUser(projectId, text, imgs.map((i) => i.rel)); } catch { /* best effort */ }
      handle.done.then((r) => {
        try { changes.endTurn({ ...project, id: projectId }); } catch { /* best effort */ }
        running.delete(projectId);
        meta.delete(projectId);
        finished.delete(projectId);
        if (r.ok && project.autoCommit && git) {
          // Tracked in `committing` (same tick as the delete above, so status() never flickers to idle).
          commitStart.set(projectId, { agent: project.agent, startedAt: Date.now() });
          const p = Promise.resolve().then(() => git.autoCommit(project.path, text, { agent: project.agent })).catch(() => { /* best effort */ })
            .finally(() => { committing.delete(projectId); commitStart.delete(projectId); });
          committing.set(projectId, p);
        }
      });
      return { turnId: crypto.randomUUID() };
    },

    /** Running turns + post-turn commits, for the tasks service. */
    listRunning() {
      const out = [];
      for (const [projectId, h] of running) {
        const m = meta.get(projectId);
        if (m) out.push({ projectId, agent: m.agent, state: 'running', startedAt: m.startedAt, pid: h?.child?.pid ?? m.pid ?? undefined });
      }
      for (const [projectId, c] of commitStart) if (!running.has(projectId)) out.push({ projectId, agent: c.agent, state: 'committing', startedAt: c.startedAt });
      return out;
    },

    stop(projectId) {
      running.get(projectId)?.stop();
    },

    stopAll() { for (const h of running.values()) h?.stop(); },
  };
}
