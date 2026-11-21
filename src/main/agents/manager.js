import crypto from 'node:crypto';
import { ClaudeAdapter } from './claude.js';
import { AgyAdapter } from './agy.js';

/**
 * Owns one running child per project. Deps are injected:
 *  projects {get, update}, resolveLauncher(agent) -> Promise<{command, baseArgs?}|null>, emit(projectId, event),
 *  git {autoCommit}, spawn, kill.
 */
export function createAgentManager({ projects, resolveLauncher, emit, git, spawn, kill, adapters }) {
  const ad = adapters ?? { claude: new ClaudeAdapter(), agy: new AgyAdapter() };
  const running = new Map(); // projectId -> handle | null (starting)

  return {
    status: (projectId) => ({ running: running.has(projectId) }),

    async send({ projectId, text }) {
      const project = projects.get(projectId);
      if (!project) throw new Error('Unknown project');
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
            if (projects.get(projectId)?.sessionId !== sessionId) projects.update(projectId, { sessionId });
          },
        });
      } catch (e) {
        running.delete(projectId);
        throw e;
      }
      running.set(projectId, handle);
      handle.done.then(async (r) => {
        running.delete(projectId);
        if (r.ok && project.autoCommit) {
          try { await git?.autoCommit(project.path, text); } catch { /* best effort */ }
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
