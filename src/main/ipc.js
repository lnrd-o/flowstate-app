import path from 'node:path';
import { CH } from '../shared/ipc.js';
import { ID_RE, KEY_RE, LIMITS } from '../shared/methodology.js';

const isStr = (v) => typeof v === 'string' && v.length > 0;
const isRel = (v) => typeof v === 'string' && v.length <= 1024;
const isId = (v) => typeof v === 'string' && v.length > 0 && v.length <= 64;

/**
 * Registers every CH invoke channel. All collaborators are injected so this is testable without Electron.
 * getWindow() -> object with webContents.send / isDestroyed (or null).
 */
export function registerIpc({ ipcMain, getWindow, dialog, settings, projects, agents, health, git, onSettings,
  prompts, files, dashboards, prereq, auth, remote, history, methodologies, recorder, runner, login, windowCtl }) {
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
  const isMid = (v) => typeof v === 'string' && ID_RE.test(v);
  const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const isAgent = (a) => a === 'claude' || a === 'agy';
  const needAgent = (a) => { if (!isAgent(a)) throw new TypeError('invalid agent'); return a; };
  const optInt = (v, lo, hi, name) => {
    if (v === undefined) return undefined;
    if (!Number.isInteger(v) || v < lo || v > hi) throw new TypeError(`invalid ${name}`);
    return v;
  };
  const phase4 = () => ({
    [CH.loginStart]: (_e, agent, opts = {}) => {
      needAgent(agent);
      if (!isPlain(opts)) throw new TypeError('options must be an object');
      const { kind, email } = opts;
      if (kind !== undefined && !['claudeai', 'console', 'sso'].includes(kind)) throw new TypeError('invalid kind');
      if (email !== undefined && (typeof email !== 'string' || email.length > 254)) throw new TypeError('invalid email');
      const clean = { kind, email: email || undefined, cols: optInt(opts.cols, 20, 300, 'cols'), rows: optInt(opts.rows, 5, 100, 'rows') };
      return login.start(agent, clean);
    },
    [CH.loginInput]: (_e, agent, data) => {
      needAgent(agent);
      if (typeof data !== 'string') throw new TypeError('data must be a string');
      if (data.length > 8192) throw new TypeError('data too long');
      login.input(agent, data);
    },
    [CH.loginResize]: (_e, agent, cols, rows) => {
      needAgent(agent);
      if (!Number.isInteger(cols) || !Number.isInteger(rows)) throw new TypeError('cols and rows must be integers');
      login.resize(agent, cols, rows);
    },
    [CH.loginCancel]: (_e, agent) => { needAgent(agent); login.cancel(agent); },
    [CH.loginStatus]: () => login.status(),
    [CH.loginLogout]: (_e, agent) => login.logout(needAgent(agent)),
    [CH.windowInfo]: () => windowCtl.windowInfo(),
    [CH.windowSetTheme]: (_e, theme) => {
      if (!isPlain(theme)) throw new TypeError('theme required');
      windowCtl.setTheme({ color: theme.color, symbolColor: theme.symbolColor, height: theme.height });
    },
    [CH.windowAction]: (_e, name) => {
      if (!['minimize', 'toggle-maximize', 'close'].includes(name)) throw new TypeError('invalid action');
      windowCtl.action(name);
    },
  });
  const phase3 = () => ({
    [CH.methodList]: () => methodologies.list(),
    [CH.methodGet]: (_e, id) => { if (!isMid(id)) throw new TypeError('invalid methodology id'); return methodologies.get(id); },
    [CH.methodSave]: (_e, m) => { if (!isPlain(m)) throw new TypeError('methodology required'); return methodologies.save(m); },
    [CH.methodDelete]: (_e, id) => { if (!isMid(id)) throw new TypeError('invalid methodology id'); methodologies.delete(id); },
    [CH.methodRecord]: (_e, projectId, opts = {}) => {
      need(projectId);
      if (!isPlain(opts)) throw new TypeError('options must be an object');
      const { name, fromTs, toTs } = opts;
      if (name !== undefined && (typeof name !== 'string' || name.length > 200)) throw new TypeError('invalid name');
      for (const t of [fromTs, toTs]) if (t !== undefined && !Number.isFinite(t)) throw new TypeError('invalid timestamp');
      return recorder.record(projectId, { name, fromTs, toTs });
    },
    [CH.methodImport]: () => methodologies.import(),
    [CH.methodExport]: (_e, id) => { if (!isMid(id)) throw new TypeError('invalid methodology id'); return methodologies.export(id); },
    [CH.methodRun]: (_e, projectId, methodologyId, vars = {}) => {
      need(projectId);
      if (!isMid(methodologyId)) throw new TypeError('invalid methodology id');
      if (!isPlain(vars)) throw new TypeError('vars must be a plain object');
      const keys = Object.keys(vars);
      if (keys.length > LIMITS.vars) throw new TypeError('too many vars');
      if (keys.some((k) => !KEY_RE.test(k))) throw new TypeError('invalid var name');
      return runner.run(projectId, methodologyId, vars);
    },
    [CH.methodRespond]: (_e, runId, nodeId, response) => {
      if (!isId(runId)) throw new TypeError('run id required');
      if (typeof nodeId !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(nodeId)) throw new TypeError('invalid node id');
      if (!isPlain(response)) throw new TypeError('response required');
      return runner.respond(runId, nodeId, response);
    },
    [CH.methodStop]: (_e, runId) => { if (!isId(runId)) throw new TypeError('run id required'); runner.stop(runId); },
    [CH.methodRunState]: (_e, id) => { need(id); return runner.state(id); },
  });
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
      runner?.forgetProject(p.id);
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
      // `allow` = optional per-turn narrow rules [{tool, pattern}]; strictly validated by the agent manager (permissions.js)
      return agents.send({ projectId: req.projectId, text: req.text, ...(req.allow !== undefined ? { allow: req.allow } : {}) });
    },
    [CH.agentStop]: (_e, id) => { need(id); agents.stop(id); },
    [CH.agentStatus]: (_e, id) => { need(id); return agents.status(id); },
    [CH.healthCheck]: () => health.poll(),
    [CH.gitStatus]: (_e, id) => git.status(need(id).path),
    [CH.gitUndoTurn]: (_e, id) => git.undoTurn(need(id).path),
    ...phase2(),
    ...phase3(),
    ...phase4(),
  };
  for (const [ch, fn] of Object.entries(handlers)) ipcMain.handle(ch, fn);

  return {
    handlers,
    pushAgentEvent: (projectId, event) => push(CH.evAgent, { projectId, event }),
    pushHealth: (h) => push(CH.evHealth, h),
    push,
  };
}
