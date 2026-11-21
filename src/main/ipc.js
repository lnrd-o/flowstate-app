import path from 'node:path';
import { CH } from '../shared/ipc.js';

const isStr = (v) => typeof v === 'string' && v.length > 0;
const isRel = (v) => typeof v === 'string' && v.length <= 1024;
const isId = (v) => typeof v === 'string' && v.length > 0 && v.length <= 64;

/**
 * Registers every CH invoke channel. All collaborators are injected so this is testable without Electron.
 * getWindow() -> object with webContents.send / isDestroyed (or null).
 */
export function registerIpc({ ipcMain, getWindow, dialog, settings, projects, agents, health, git, onSettings,
  prompts, files, dashboards, prereq, auth, remote, history }) {
  const need = (id) => {
    if (!isStr(id)) throw new TypeError('projectId required');
    const p = projects.get(id);
    if (!p) throw new Error('Unknown project');
    return p;
  };
  const push = (channel, payload) => {
    const w = getWindow();
    if (w && !w.isDestroyed?.() && !w.webContents?.isDestroyed?.()) w.webContents.send(channel, payload);
  };
  const phase2 = () => ({
    [CH.promptsList]: () => prompts.list(),
    [CH.promptsSave]: (_e, t) => prompts.save(t),
    [CH.promptsDelete]: (_e, id) => { if (!isId(id)) throw new TypeError('template id required'); prompts.delete(id); },
    [CH.promptsExport]: (_e, projectId, id) => { const p = need(projectId); if (!isId(id)) throw new TypeError('template id required'); return prompts.export(p, id); },
    [CH.filesList]: (_e, id, rel = '') => { need(id); if (!isRel(rel)) throw new TypeError('invalid path'); return files.list(id, rel); },
    [CH.filesRead]: (_e, id, rel) => { need(id); if (!isStr(rel) || !isRel(rel)) throw new TypeError('path required'); return files.read(id, rel); },
    [CH.filesReveal]: (_e, id, rel) => { need(id); if (!isStr(rel) || !isRel(rel)) throw new TypeError('path required'); return files.reveal(id, rel); },
    [CH.filesOpen]: (_e, id, rel) => { need(id); if (!isStr(rel) || !isRel(rel)) throw new TypeError('path required'); return files.open(id, rel); },
    [CH.filesWatch]: (_e, id) => { need(id); files.watch(id); },
    [CH.dashboardStatus]: (_e, id) => { need(id); return dashboards.status(id); },
    [CH.dashboardSetup]: (_e, id) => { need(id); return dashboards.setup(id); },
    [CH.dashboardStart]: (_e, id, app) => { need(id); if (!isStr(app) || !isRel(app)) throw new TypeError('app path required'); return dashboards.start(id, app); },
    [CH.dashboardStop]: (_e, id) => { need(id); dashboards.stop(id); },
    [CH.prereqInstall]: (_e, id) => { if (!isStr(id) || id.length > 16) throw new TypeError('prerequisite id required'); return prereq.install(id); },
    [CH.authLogin]: (_e, agent) => { if (agent !== 'claude' && agent !== 'agy') throw new TypeError('invalid agent'); return auth.login(agent); },
    [CH.remoteStatus]: (_e, id) => { need(id); return remote.status(id); },
    [CH.remoteStart]: (_e, id) => { need(id); return remote.start(id); },
    [CH.remoteStop]: (_e, id) => { need(id); return remote.stop(id); },
    [CH.historyGet]: (_e, id) => { need(id); return history.get(id); },
    [CH.historyClear]: (_e, id) => { need(id); history.clear(id); },
  });
  const handlers = {
    [CH.settingsGet]: () => settings.get(),
    [CH.settingsSet]: (_e, patch) => {
      const s = settings.set(patch);
      onSettings?.(s);
      return s;
    },
    [CH.projectsList]: () => projects.list(),
    [CH.projectsAdd]: async (_e, opts) => {
      if (!opts || typeof opts !== 'object') throw new TypeError('options required');
      if (!isStr(opts.path) || !path.isAbsolute(opts.path)) throw new TypeError('path must be an absolute string');
      const p = projects.add(opts);
      if (p.autoCommit) await git.init(p.path);
      return p;
    },
    [CH.projectsUpdate]: async (_e, id, patch) => {
      need(id);
      if (!patch || typeof patch !== 'object') throw new TypeError('patch required');
      const p = projects.update(id, patch);
      if (patch.autoCommit === true) await git.init(p.path);
      return p;
    },
    [CH.projectsRemove]: (_e, id) => {
      const p = need(id);
      agents.stop(p.id);
      files?.closeWatcher(p.id);
      dashboards?.stop(p.id);
      remote?.stopForRemoved(p).catch(() => {});
      history?.clear(p.id);
      projects.remove(id);
    },
    [CH.projectsPickFolder]: async () => {
      const r = await dialog.showOpenDialog(getWindow() ?? undefined, { properties: ['openDirectory', 'createDirectory'] });
      return r.canceled || !r.filePaths?.length ? null : r.filePaths[0];
    },
    [CH.agentSend]: (_e, req) => {
      if (!req || typeof req !== 'object') throw new TypeError('request required');
      need(req.projectId);
      if (!isStr(req.text)) throw new TypeError('text required');
      return agents.send({ projectId: req.projectId, text: req.text });
    },
    [CH.agentStop]: (_e, id) => { need(id); agents.stop(id); },
    [CH.agentStatus]: (_e, id) => { need(id); return agents.status(id); },
    [CH.healthCheck]: () => health.poll(),
    [CH.gitStatus]: (_e, id) => git.status(need(id).path),
    [CH.gitUndoTurn]: (_e, id) => git.undoTurn(need(id).path),
    ...phase2(),
  };
  for (const [ch, fn] of Object.entries(handlers)) ipcMain.handle(ch, fn);

  return {
    handlers,
    pushAgentEvent: (projectId, event) => push(CH.evAgent, { projectId, event }),
    pushHealth: (h) => push(CH.evHealth, h),
    push,
  };
}
