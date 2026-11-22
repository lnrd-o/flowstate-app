import crypto from 'node:crypto';
import { ClaudeAdapter } from './claude.js';
import { AgyAdapter } from './agy.js';
import { createChangeTracker } from '../changes.js';
import { sanitizeAllow } from '../permissions.js';

/**
 * Owns one running child per project. Deps are injected:
 *  projects {get, update}, resolveLauncher(agent) -> Promise<{command, baseArgs?}|null>, emit(projectId, event),
 *  git {autoCommit}, spawn, kill, history {recordUser}.
 */
export function createAgentManager({ projects, resolveLauncher, emit, git, spawn, kill, adapters, history, changes = createChangeTracker() }) {
  const ad = adapters ?? { claude: new ClaudeAdapter(), agy: new AgyAdapter() };
  const running = new Map(); // projectId -> handle | null (starting)
  const committing = new Map(); // projectId -> Promise (auto-commit after a finished turn)
  const finished = new Set(); // projectIds whose current turn already emitted result/error (process may still be exiting)

  return {
    // "running" also covers the post-turn auto-commit so the methodology runner never races it.
    status: (projectId) => ({ running: running.has(projectId) || committing.has(projectId) }),

    /** agent/mode: optional per-turn override (methodology runner); the stored project is never changed by it. */
    /** allow: optional per-turn narrow permission rules [{tool, pattern}] (claude only; validated in permissions.js, never persisted). */
    async send({ projectId, text, agent, mode, allow }) {
      const base = projects.get(projectId);
      if (!base) throw new Error('Unknown project');
      const project = { ...base };
      project.allow = sanitizeAllow(allow); // throws TypeError on anything invalid
      const switched = agent !== undefined && agent !== base.agent;
      if (agent !== undefined) project.agent = agent;
      if (mode !== undefined) project.mode = mode;
      if (switched) project.sessionId = null; // a session belongs to one agent
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
      running.set(projectId, null);
      let handle;
      try {
        const launcher = await resolveLauncher(project.agent);
        if (!launcher) throw new Error(`${project.agent} executable not found`);
        handle = adapter.run({
          project, text, launcher, spawn, kill,
          emit: (event) => {
            if (event?.type === 'result' || event?.type === 'error') finished.add(projectId);
            let extra = [];
            try { extra = changes.observe({ ...project, id: projectId }, event) ?? []; } catch { /* best effort */ }
            emit(projectId, event);
            for (const fc of extra) emit(projectId, fc); // file-change goes out right after the tool-result that produced it
          },
          onSession: (sessionId) => {
            if (!switched && projects.get(projectId)?.sessionId !== sessionId) projects.update(projectId, { sessionId });
          },
        });
      } catch (e) {
        running.delete(projectId);
        finished.delete(projectId);
        throw e;
      }
      running.set(projectId, handle);
      try { history?.recordUser(projectId, text); } catch { /* best effort */ }
      handle.done.then((r) => {
        try { changes.endTurn({ ...project, id: projectId }); } catch { /* best effort */ }
        running.delete(projectId);
        finished.delete(projectId);
        if (r.ok && project.autoCommit && git) {
          // Tracked in `committing` (same tick as the delete above, so status() never flickers to idle).
          const p = Promise.resolve().then(() => git.autoCommit(project.path, text)).catch(() => { /* best effort */ })
            .finally(() => { committing.delete(projectId); });
          committing.set(projectId, p);
        }
      });
      return { turnId: crypto.randomUUID() };
    },

    stop(projectId) {
      running.get(projectId)?.stop();
    },

    stopAll() { for (const h of running.values()) h?.stop(); },
  };
}
