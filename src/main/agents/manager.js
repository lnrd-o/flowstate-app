import crypto from 'node:crypto';
import { ClaudeAdapter } from './claude.js';
import { AgyAdapter } from './agy.js';

/**
 * Owns one running child per project. Deps are injected:
 *  projects {get, update}, resolveLauncher(agent) -> Promise<{command, baseArgs?}|null>, emit(projectId, event),
 *  git {autoCommit}, spawn, kill, history {recordUser}.
 */
export function createAgentManager({ projects, resolveLauncher, emit, git, spawn, kill, adapters, history }) {
  const ad = adapters ?? { claude: new ClaudeAdapter(), agy: new AgyAdapter() };
  const running = new Map(); // projectId -> handle | null (starting)

  return {
    status: (projectId) => ({ running: running.has(projectId) }),

    /** agent/mode: optional per-turn override (methodology runner); the stored project is never changed by it. */
    async send({ projectId, text, agent, mode }) {
      const base = projects.get(projectId);
      if (!base) throw new Error('Unknown project');
      const project = { ...base };
      const switched = agent !== undefined && agent !== base.agent;
      if (agent !== undefined) project.agent = agent;
      if (mode !== undefined) project.mode = mode;
      if (switched) project.sessionId = null; // a session belongs to one agent
      if (typeof text !== 'string' || !text.trim()) throw new TypeError('text must be a non-empty string');
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
          emit: (event) => emit(projectId, event),
          onSession: (sessionId) => {
            if (!switched && projects.get(projectId)?.sessionId !== sessionId) projects.update(projectId, { sessionId });
          },
        });
      } catch (e) {
        running.delete(projectId);
        throw e;
      }
      running.set(projectId, handle);
      try { history?.recordUser(projectId, text); } catch { /* best effort */ }
      handle.done.then(async (r) => {
        // Keep the project "running" until the auto-commit finishes: the methodology runner polls status() and a
        // following git-commit node must not race this commit (index.lock / 'nothing to commit').
        try {
          if (r.ok && project.autoCommit) {
            try { await git?.autoCommit(project.path, text); } catch { /* best effort */ }
          }
        } finally { running.delete(projectId); }
      });
      return { turnId: crypto.randomUUID() };
    },

    stop(projectId) {
      running.get(projectId)?.stop();
    },

    stopAll() { for (const h of running.values()) h?.stop(); },
  };
}
