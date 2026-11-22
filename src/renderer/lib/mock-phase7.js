// Phase 7 part of the browser mock: models, usage, DeepSeek, menu, tasks, project store, UI state, attachments, app.
// Hash flags: #limit5h (claude hits the 5-hour limit mid-turn: "You've hit your limit - resets 3pm"), #limitweek (weekly limit),
//   #usagehigh (windows at 82% and 95%), #deepseek (configured, balance, models; also turns settings.deepseekEnabled on),
//   #tasks (running agent, dashboard, remote session, watcher, todo lists, subagents), #images (history with screenshots),
//   #nostore (fresh folder: nothing saved in .flowstate yet), #agyout (agy models need sign-in; set by the Phase 4 flag).
import { MENU } from '../../shared/menu.js';
import { base64Bytes } from './images.js';

const has = (re) => typeof location !== 'undefined' && re.test(location.hash);
const clone = (o) => JSON.parse(JSON.stringify(o));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function wantsLimit(hash) {
  if (/#limitweek/.test(hash)) return 'seven_day';
  if (/#limit5h/.test(hash)) return 'five_hour';
  return null;
}

/** A deterministic colourful SVG that stands in for an attached screenshot. */
export function placeholderImage(label, seed = 0) {
  const hues = [[210, 260], [160, 200], [20, 50], [320, 350], [90, 130]];
  const [a, b] = hues[Math.abs(seed) % hues.length];
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400">'
    + '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(' + a + ',70%,45%)"/><stop offset="1" stop-color="hsl(' + b + ',70%,35%)"/></linearGradient></defs>'
    + '<rect width="640" height="400" fill="url(#g)"/><rect x="24" y="24" width="592" height="44" rx="8" fill="rgba(255,255,255,0.85)"/>'
    + '<rect x="24" y="92" width="280" height="284" rx="8" fill="rgba(255,255,255,0.7)"/><rect x="324" y="92" width="292" height="130" rx="8" fill="rgba(255,255,255,0.7)"/>'
    + '<rect x="324" y="246" width="292" height="130" rx="8" fill="rgba(255,255,255,0.55)"/>'
    + '<text x="320" y="52" font-family="Segoe UI, Arial, sans-serif" font-size="22" text-anchor="middle" fill="#222">' + String(label).replace(/[<>&"]/g, '') + '</text></svg>';
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

const next3pm = (now) => { const d = new Date(now); d.setHours(15, 0, 0, 0); if (d.getTime() <= now + 60000) d.setDate(d.getDate() + 1); return d.getTime(); };
const nextMonday9 = (now) => { const d = new Date(now); d.setHours(9, 0, 0, 0); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); return d.getTime(); };

export function createPhase7({ projects, getSettings, addProject, emitAgent, getRunning, stopAgent, isSigned, history }) {
  const now = () => Date.now();
  const subs = { usage: new Set(), tasks: new Set(), menu: new Set(), quit: new Set() };
  const fire = (k, p) => subs[k].forEach((cb) => { try { cb(clone(p)); } catch { /* ignore */ } });

  // ---------------- usage ----------------
  const high = has(/#usagehigh/);
  const usage = {
    at: now(),
    claude: {
      windows: {
        five_hour: { utilization: high ? 0.82 : has(/#limit5h|#limitweek/) ? 0.62 : 0.15, resetsAt: now() + (2 * 60 + 14) * 60000, status: high ? 'allowed_warning' : 'allowed' },
        seven_day: { utilization: high ? 0.95 : 0.38, resetsAt: now() + (3 * 24 * 60 + 5 * 60) * 60000, status: high ? 'allowed_warning' : 'allowed' },
      },
      today: { costUsd: 1.84, inputTokens: 182340, outputTokens: 41210, turns: 23 },
      lastLimit: null, updatedAt: now() - 90000,
    },
    agy: { today: { inputTokens: 90210, outputTokens: 12400, thinkingTokens: 31800, turns: 9 }, lastLimit: null, updatedAt: now() - 600000 },
    deepseek: { configured: has(/#deepseek/) },
  };
  const pushUsage = () => { usage.at = now(); fire('usage', usage); };

  function applyLimit(projectId, kind) {
    const t0 = now();
    const resetsAt = kind === 'seven_day' ? nextMonday9(t0) : next3pm(t0);
    const message = kind === 'seven_day' ? "You've hit your weekly limit - resets Mon 9am" : "You've hit your limit - resets 3pm";
    usage.claude.windows[kind] = { utilization: 1, resetsAt, status: 'rejected' };
    usage.claude.lastLimit = { at: t0, kind, status: 'rejected', resetsAt, utilization: 1, message, projectId };
    usage.claude.updatedAt = t0;
    pushUsage();
    return { resetsAt, message };
  }

  /** Script of a claude turn that hits the limit half way: [[ms, event]]. */
  function limitScript(projectId, kind) {
    const out = [];
    let t = 100;
    const at = (d, e) => { t += d; out.push([t, e]); };
    at(0, { type: 'session', sessionId: 'limit-1' });
    for (const c of ['Let me look ', 'at the failing ', 'test first.\n\n']) at(30, { type: 'text-delta', text: c });
    at(200, { type: 'tool-use', id: 'lim-r', name: 'Read', input: { file_path: 'src/utils.js' } });
    at(400, { type: 'tool-result', id: 'lim-r', output: 'export function same(a, b) { return a == b; }' });
    at(500, { type: 'rate-limit', status: 'rejected' });
    out.push([t + 1, { __limit: kind }]); // replaced by the real event once the reset time is computed
    at(150, { type: 'result', ok: false, text: kind === 'seven_day' ? "You've hit your weekly limit - resets Mon 9am" : "You've hit your limit - resets 3pm" });
    return out;
  }
  function realiseLimit(projectId, ev) {
    const { resetsAt, message } = applyLimit(projectId, ev.__limit);
    return { type: 'limit', agent: 'claude', kind: ev.__limit, status: 'rejected', resetsAt, utilization: 1, message };
  }

  // ---------------- models ----------------
  const CLAUDE_MODELS = [
    { id: 'default', name: 'Default (recommended)', description: 'Opus 4.7 for complex work' },
    { id: 'opus', name: 'Opus', description: 'Most capable, best for hard problems' },
    { id: 'sonnet', name: 'Sonnet', description: 'Balanced speed and quality' },
    { id: 'haiku', name: 'Haiku', description: 'Fastest, for simple tasks' },
    { id: 'fable', name: 'Fable', description: 'Newest alias' },
    { id: 'claude-sonnet-5-5', name: 'claude-sonnet-5-5', description: 'Seen in the last session', current: true },
  ];
  const AGY_MODELS = [
    { id: 'gemini-3-pro', name: 'Gemini 3 Pro' }, { id: 'gemini-3-flash', name: 'Gemini 3 Flash' },
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)' }, { id: 'gpt-oss-120b', name: 'GPT-OSS 120B (Medium)' },
  ];
  const efforts = ['low', 'medium', 'high', 'xhigh', 'max'];
  const models = {
    list: async (agent) => {
      if (agent === 'claude') { await sleep(120); return { agent, source: 'static', models: clone(CLAUDE_MODELS), efforts, defaultModel: 'default' }; }
      await sleep(700);
      if (!isSigned('agy')) return { agent, source: 'live', models: [], efforts, error: 'not-signed-in' };
      return { agent, source: 'live', models: clone(AGY_MODELS.map((m, i) => ({ ...m, current: i === 0 }))), efforts, defaultModel: 'gemini-3-pro' };
    },
  };

  // ---------------- deepseek ----------------
  const ds = { key: has(/#deepseek/) ? 'sk-mock-key' : null, updatedAt: has(/#deepseek/) ? now() - 30000 : undefined };
  const deepseek = {
    setKey: async (key) => {
      await sleep(250);
      if (key === null) { ds.key = null; usage.deepseek = { configured: false }; pushUsage(); return { ok: true }; }
      const k = String(key || '').trim();
      if (!k) return { ok: false, error: 'invalid-key' };
      if (/^enc/i.test(k)) return { ok: false, error: 'encryption-unavailable' };
      if (/^bad/i.test(k)) { ds.key = k; return { ok: true }; } // saved, rejected on the first status call
      ds.key = k; ds.updatedAt = now();
      usage.deepseek = { configured: true, balance: BALANCE, updatedAt: ds.updatedAt }; pushUsage();
      return { ok: true };
    },
    status: async () => {
      await sleep(300);
      const enabled = !!getSettings().deepseekEnabled;
      if (!ds.key) return { configured: false, enabled };
      if (/offline/i.test(ds.key)) return { configured: true, enabled, error: 'offline' };
      if (/^bad/i.test(ds.key)) return { configured: true, enabled, error: 'invalid-key' };
      if (/http/i.test(ds.key)) return { configured: true, enabled, error: 'http-429' };
      ds.updatedAt = now();
      return { configured: true, enabled, balance: BALANCE, models: [{ id: 'deepseek-chat', ownedBy: 'deepseek' }, { id: 'deepseek-reasoner', ownedBy: 'deepseek' }, { id: 'deepseek-coder', ownedBy: 'deepseek' }], updatedAt: ds.updatedAt };
    },
  };
  const BALANCE = { available: true, currency: 'USD', total: '12.45', granted: '2.00', toppedUp: '10.45' };
  if (ds.key) usage.deepseek = { configured: true, balance: BALANCE, updatedAt: ds.updatedAt };

  // ---------------- menu ----------------
  const menu = {
    model: async () => {
      const recent = [...projects()].sort((a, b) => String(b.lastOpened).localeCompare(String(a.lastOpened))).slice(0, 8)
        .map((p) => ({ id: 'file.recent:' + p.id, label: p.name, literal: true, handler: 'renderer' }));
      const items = clone(MENU).map((m) => (m.id === 'file' ? { ...m, submenu: m.submenu.map((i) => (i.id === 'file.recent' ? { ...i, submenu: recent } : i)) } : m));
      const s = getSettings();
      return { items, state: { developerMode: s.developerMode !== false, theme: s.theme, platform: has(/#mac\b/) ? 'darwin' : has(/#linux\b/) ? 'linux' : 'win32', packaged: false } };
    },
    invoke: async (id) => {
      const roles = { 'edit.undo': 'undo', 'edit.redo': 'redo', 'edit.cut': 'cut', 'edit.copy': 'copy', 'edit.paste': 'paste', 'edit.selectAll': 'selectAll' };
      if (roles[id]) { try { document.execCommand(roles[id]); } catch { /* ignore */ } return { ok: true }; }
      if (id === 'file.saveState') { storeApi.save(projects()[0] && projects()[0].id); return { ok: true }; }
      const item = flat(MENU).find((i) => i.id === id);
      if (item && item.url) { window.open(item.url, '_blank'); return { ok: true }; }
      return { ok: id !== 'file.quit' };
    },
  };
  function flat(items) { return items.flatMap((i) => (i.submenu ? flat(i.submenu) : [i])); }

  // ---------------- tasks ----------------
  const wantTasks = has(/#tasks/);
  const started = new Map();
  const fakeAgents = wantTasks ? [{ projectId: 'p2', projectName: 'dashboards-with-a-rather-long-project-name', agent: 'agy', state: 'running', startedAt: now() - 83000, pid: 18244 }] : [];
  let fakeServices = wantTasks ? [
    { kind: 'dashboard', id: 'p1', projectId: 'p1', label: 'Streamlit dashboard - 127.0.0.1:8501 (pid 12044)', state: 'running', url: 'http://127.0.0.1:8501', startedAt: now() - 600000, stoppable: true },
    { kind: 'remote', id: 'p1', projectId: 'p1', label: 'Remote control session "ClaudeClient"', state: 'waiting', startedAt: now() - 1200000, stoppable: true },
    { kind: 'methodology', id: 'run-7', projectId: 'p3', label: 'Weekly report methodology (step 3 of 5)', state: 'running', startedAt: now() - 240000, stoppable: true },
    { kind: 'watcher', id: 'p1', projectId: 'p1', label: 'File watcher (pid 9120)', state: 'running', startedAt: now() - 3600000, stoppable: false },
  ] : [];
  const todos = wantTasks ? {
    p1: [
      { content: 'Read the failing test', status: 'completed' }, { content: 'Fix the trim comparison', status: 'completed' },
      { content: 'Add a regression test', status: 'in_progress' }, { content: 'Update the docs', status: 'pending' }, { content: 'Run the full suite', status: 'pending' },
    ],
    p2: [{ content: 'Sketch the layout', status: 'completed' }, { content: 'Wire the data source', status: 'pending' }],
  } : {};
  const subagents = wantTasks ? [
    { projectId: 'p1', id: 'sa1', name: 'Explore', description: 'Find where the comparison helper is used', state: 'running', startedAt: now() - 20000 },
    { projectId: 'p1', id: 'sa2', name: 'Plan', description: 'Draft the migration steps', state: 'done', startedAt: now() - 90000 },
  ] : [];

  function snapshot() {
    const t0 = now();
    const agents = [];
    for (const pid of getRunning()) {
      if (!started.has(pid)) started.set(pid, t0);
      const p = projects().find((x) => x.id === pid);
      agents.push({ projectId: pid, projectName: p ? p.name : pid, agent: p ? p.agent : 'claude', state: 'running', startedAt: started.get(pid), elapsedMs: t0 - started.get(pid) });
    }
    for (const pid of [...started.keys()]) if (!getRunning().includes(pid)) started.delete(pid);
    for (const a of fakeAgents) agents.push({ ...a, elapsedMs: t0 - a.startedAt });
    return { at: t0, agents, services: fakeServices.map((s) => ({ ...s })), todos: clone(todos), subagents: clone(subagents) };
  }
  let lastSig = '';
  setInterval(() => {
    const s = snapshot();
    const sig = JSON.stringify([s.agents.map((a) => [a.projectId, a.state]), s.services, s.todos, s.subagents]);
    if (sig !== lastSig) { lastSig = sig; fire('tasks', s); }
  }, 1000);

  const tasks = {
    list: async () => snapshot(),
    stop: async ({ kind, id }) => {
      await sleep(150);
      if (kind === 'agent') {
        const i = fakeAgents.findIndex((a) => a.projectId === id);
        if (i >= 0) fakeAgents.splice(i, 1); else stopAgent(id);
        return { ok: true };
      }
      const before = fakeServices.length;
      fakeServices = fakeServices.filter((s) => !(s.kind === kind && s.id === id && s.stoppable));
      return fakeServices.length < before ? { ok: true } : { ok: false, error: 'not-stoppable' };
    },
  };

  /** Called for every agent event: keeps the mock task snapshot in sync with todos / subagents. */
  function observe(projectId, ev) {
    if (!ev) return;
    if (ev.type === 'todos') todos[projectId] = ev.items;
    if (ev.type === 'subagent') {
      const i = subagents.findIndex((s) => s.projectId === projectId && s.id === ev.id);
      if (i >= 0) subagents[i] = { ...subagents[i], ...ev, projectId }; else subagents.push({ projectId, startedAt: now(), ...ev });
    }
    if (ev.type === 'result' && ev.ok !== false && usage.claude) {
      const p = projects().find((x) => x.id === projectId);
      if (p && p.agent === 'claude') {
        usage.claude.today = { ...usage.claude.today, turns: usage.claude.today.turns + 1, costUsd: usage.claude.today.costUsd + (ev.costUsd || 0.012) };
        const w = usage.claude.windows.five_hour;
        w.utilization = Math.min(0.99, w.utilization + 0.01);
        usage.claude.updatedAt = now();
        pushUsage();
      } else if (p) { usage.agy.today = { ...usage.agy.today, turns: usage.agy.today.turns + 1 }; usage.agy.updatedAt = now(); pushUsage(); }
    }
  }

  // ---------------- project store ----------------
  const saved = new Map(); // projectId -> lastSavedAt
  const cleared = new Set();
  const fresh = has(/#nostore/);
  const storeApi = {
    status: async (pid) => {
      await sleep(80);
      const p = projects().find((x) => x.id === pid);
      const exists = !cleared.has(pid) && (!fresh || saved.has(pid));
      return {
        dir: (p ? p.path : 'C:\\project') + '\\.flowstate', exists, hasProject: exists, hasState: exists, historyBytes: exists ? 48210 : 0,
        attachmentsBytes: exists ? 1400000 : 0, gitignored: exists, lastSavedAt: exists ? (saved.get(pid) || now() - 120000) : null,
      };
    },
    save: async (pid) => { saved.set(pid, now()); cleared.delete(pid); return { ok: true, files: ['project.json', 'state.json', 'history.jsonl'] }; },
    openFolder: async () => {
      const proj = await addProject({ name: 'imported-project', path: 'C:\\Users\\leo\\Code\\imported-project', agent: 'claude', mode: 'default' });
      return { project: proj, created: false, loaded: { projectJson: true, state: true, history: true } };
    },
    clear: async (pid, what) => { if (what === 'all') cleared.add(pid); else if (history) await history.clear(pid); },
  };

  // ---------------- ui state ----------------
  const readUi = (k) => { try { return JSON.parse(sessionStorage.getItem('mock-ui-' + k) || '{}'); } catch { return {}; } };
  const writeUi = (k, v) => { try { sessionStorage.setItem('mock-ui-' + k, JSON.stringify(v)); } catch { /* ignore */ } };
  const ui = {
    get: async () => readUi('global'),
    set: async (patch) => { writeUi('global', { ...readUi('global'), ...patch }); },
    projectGet: async (pid) => readUi('p-' + pid),
    projectSet: async (pid, patch) => { writeUi('p-' + pid, { ...readUi('p-' + pid), ...patch }); },
  };

  // ---------------- attachments ----------------
  const images = new Map(); // `${pid}|${rel}` -> dataUrl
  let n = 0;
  const attachments = {
    save: async (pid, { name, mime, dataBase64 }) => {
      await sleep(350 + (n % 3) * 250);
      n += 1;
      if (/fail/i.test(name)) throw new Error('disk full');
      const id = 'att' + n;
      const rel = '.flowstate/attachments/' + id + '-' + String(name).replace(/[^\w.-]/g, '_');
      images.set(pid + '|' + rel, 'data:' + mime + ';base64,' + dataBase64);
      return { id, rel, name, mime, size: base64Bytes(dataBase64) };
    },
    read: async (pid, rel) => {
      await sleep(60);
      return { dataUrl: images.get(pid + '|' + rel) || placeholderImage(/([^/]+)$/.exec(rel)[1].replace(/\.\w+$/, ''), rel.length) };
    },
  };

  // ---------------- app ----------------
  const app = {
    info: async () => ({
      name: 'FlowState', version: '0.1.1', electron: '45.4.1', chrome: '142.0.7444.0', node: '24.1.0',
      platform: has(/#mac\b/) ? 'darwin' : has(/#linux\b/) ? 'linux' : 'win32', arch: 'x64', userData: 'C:\\Users\\leo\\AppData\\Roaming\\FlowState', packaged: false,
    }),
    ready: async () => { window.__mockApp = { ...(window.__mockApp || {}), ready: true }; },
    flushed: async () => { window.__mockApp = { ...(window.__mockApp || {}), flushed: (window.__mockApp && window.__mockApp.flushed || 0) + 1 }; },
  };
  window.__mockBeforeQuit = () => fire('quit', {});

  const sub = (k) => (cb) => { subs[k].add(cb); return () => subs[k].delete(cb); };
  return {
    api: { models, usage: { get: async () => clone(usage) }, deepseek, menu, tasks, store: storeApi, ui, attachments, app },
    subscribe: { onUsage: sub('usage'), onTasks: sub('tasks'), onMenu: sub('menu'), onBeforeQuit: sub('quit') },
    limitScript, realiseLimit, observe, seedImages: (pid) => {
      const rels = ['.flowstate/attachments/layout-before.png', '.flowstate/attachments/layout-after.png'];
      return rels;
    },
    emitMenu: (id) => fire('menu', { id }),
  };
}
