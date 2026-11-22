// Mock window.flowstate used when the renderer is opened in a plain browser (no Electron preload).
// Add #vpn to the URL hash to simulate an active VPN; #noclaude / #nologin for the other banners.

const MOCK_REPLY = [
  '## Plan\n\nI looked at the failing test and found the cause. Here is the fix, with a few **supporting** snippets:\n\n',
  '1. Trim the input before comparing\n2. Add a regression test\n3. Update the docs\n\n',
  '```js\nexport function same(a, b) {\n  // compare trimmed values, ignoring case\n  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();\n}\n```\n\n',
  'The Python helper is equivalent:\n\n```python\ndef same(a: str, b: str) -> bool:\n    """Compare trimmed, case-insensitive."""\n    return a.strip().lower() == b.strip().lower()\n```\n\n',
  'Run it from PowerShell:\n\n```powershell\nnpm test -- --watch\nGet-ChildItem -Recurse src | Select-Object -First 5\n```\n\n',
  'Configuration and styles:\n\n```json\n{ "name": "flowstate", "strict": true, "retries": 3 }\n```\n\n```css\n.btn:hover { background: var(--bg-hover); color: #fff; }\n```\n\n',
  'The diff looks like this:\n\n```diff\n--- a/src/utils.js\n+++ b/src/utils.js\n@@ -1,3 +1,3 @@\n export function same(a, b) {\n-  return a == b;\n+  return String(a).trim() === String(b).trim();\n }\n```\n\n',
  '| File | Change |\n|------|--------|\n| `src/utils.js` | trim input |\n| `tests/utils.test.js` | new case |\n\n',
  'See the [Node.js docs](https://nodejs.org/api/) for details. Unsafe link: [x](javascript:alert(1)).\n\n',
  '<img src=x onerror=alert(1)><script>alert(2)</script>\n\n',
  'Finally an unfinished block that must not break layout:\n\n```ts\nconst answer: number = 4',
  '2;\nconsole.log(answer);\n```\n\nDone.',
];

import { mockVersions } from './mock-versions.js';
import { createPhase2 } from './mock-phase2.js';
import { createPhase3 } from './mock-phase3.js';
import { createPhase4 } from './mock-phase4.js';
import { wantsRich, richScript } from './mock-phase5.js';
import { wantsBlocked, devPreset, allowCovers, blockedNeeds, blockedScript } from './mock-phase6.js';
import { createPhase7, wantsLimit } from './mock-phase7.js';
import { createPhase8 } from './mock-phase8.js';

export function createMockApi() {
  const clone = (o) => JSON.parse(JSON.stringify(o));
  let settings = {
    language: 'en', theme: 'dark', codeTheme: 'vs-dark', claudePath: null, agyPath: null,
    lastProjectId: null, autoLaunch: false,
    walkthroughDone: !/#(walkthrough|first)/.test(location.hash),
    developerMode: devPreset(location.hash) !== false,
    deepseekEnabled: /#deepseek/.test(location.hash),
  };
  let projects = [
    { id: 'p1', name: 'ClaudeClient', path: 'C:\\Users\\leo\\Code\\ClaudeClient', agent: 'claude', mode: 'default', sessionId: 'abc', lastOpened: new Date().toISOString(), autoCommit: true, model: null, effort: null, developerMode: null },
    { id: 'p2', name: 'dashboards-with-a-rather-long-project-name', path: 'C:\\Users\\leo\\Code\\dashboards', agent: 'agy', mode: 'plan', sessionId: null, lastOpened: new Date().toISOString(), autoCommit: false, model: null, effort: null, developerMode: null },
    { id: 'p3', name: 'notes', path: 'C:\\Users\\leo\\Notes', agent: 'claude', mode: 'acceptEdits', sessionId: null, lastOpened: new Date().toISOString(), autoCommit: false, model: null, effort: null, developerMode: null },
  ];
  const agentSubs = new Set();
  const healthSubs = new Set();
  const running = new Map();
  const flags = { pythonInstalled: false, gitInstalled: false, nodeInstalled: false, loggedIn: false };
  let p2 = null;
  let p7 = null;
  const emit = (projectId, event) => {
    if (event && event.__limit) event = p7.realiseLimit(projectId, event);
    if (p2) p2.record(projectId, event);
    if (p7) p7.observe(projectId, event);
    agentSubs.forEach((cb) => cb({ projectId, event }));
  };

  const health = () => ({
    claude: { found: !/#noclaude/.test(location.hash), path: 'C:\\bin\\claude.exe', version: '2.1.0', loggedIn: p4.signed().claude },
    agy: { found: true, path: 'C:\\bin\\agy.exe', version: '0.9.2', loggedIn: p4.signed().agy },
    opencode: /#opencode/.test(location.hash) ? { found: true, path: 'C:\\bin\\opencode.exe', version: '1.0.0', loggedIn: true } : { found: false, path: null, version: null, loggedIn: null },
    node: p2.flagsHealth().node,
    git: p2.flagsHealth().git,
    python: p2.flagsHealth().python,
    vpn: { active: /#vpn/.test(location.hash), adapters: /#vpn/.test(location.hash) ? ['Corp VPN'] : [] },
    anthropicReachable: !/#vpn/.test(location.hash),
  });
  const p4 = createPhase4({ onSignedChange: () => healthSubs.forEach((cb) => cb(health())) });
  p2 = createPhase2({ projects: () => projects, emitAgent: emit, flags });
  p7 = createPhase7({
    projects: () => projects, getSettings: () => settings, emitAgent: emit, isSigned: (a) => p4.signed()[a],
    addProject: async (p) => api.projects.add(p), getRunning: () => [...running.keys()], stopAgent: (id) => api.agent.stop(id), history: { clear: (pid) => p2.api.history.clear(pid) },
  });
  const p3 = createPhase3({ projects: () => projects, getHistory: (pid) => p2.api.history.get(pid), emitAgent: emit });
  window.addEventListener('hashchange', () => healthSubs.forEach((cb) => cb(health())));

  let richUsed = false;
  let blockedRuns = 0;
  function runRich(projectId, text, style) {
    const proj = projects.find((p) => p.id === projectId);
    const timers = [];
    const script = richScript(style, proj.path);
    for (const [ms, ev] of script) {
      timers.push(setTimeout(() => {
        emit(projectId, ev);
        if (ev.type === 'file-change') p2.emitFiles(projectId, [ev.path]);
        if (ev.type === 'result') running.delete(projectId);
      }, ms));
    }
    running.set(projectId, { timers, text });
  }

  function runScript(projectId, text, script) {
    const timers = [];
    for (const [ms, ev] of script) {
      timers.push(setTimeout(() => {
        emit(projectId, ev);
        if (ev.type === 'result') running.delete(projectId);
      }, ms));
    }
    running.set(projectId, { timers, text });
  }

  function runTurn(projectId, text, allow) {
    const limitKind = wantsLimit(location.hash);
    const lproj = projects.find((p) => p.id === projectId);
    if (limitKind && lproj && lproj.agent === 'claude') { runScript(projectId, text, p7.limitScript(projectId, limitKind)); return; }
    const variant = wantsBlocked(location.hash);
    const bproj = projects.find((p) => p.id === projectId);
    if (variant && bproj && bproj.agent === 'claude') {
      const covered = bproj.mode === 'acceptEdits' || bproj.mode === 'auto' || allowCovers(allow, blockedNeeds(bproj.path, variant));
      runScript(projectId, text, blockedScript(bproj.path, variant, covered ? 'allowed' : 'blocked', ++blockedRuns));
      return;
    }
    const style = wantsRich(location.hash);
    if (style && !richUsed) { richUsed = true; runRich(projectId, text, style); return; }
    const proj = projects.find((p) => p.id === projectId);
    const timers = [];
    const at = (ms, fn) => timers.push(setTimeout(fn, ms));
    let t = 100;
    at(t, () => emit(projectId, { type: 'session', sessionId: 'abc', warning: proj.agent === 'agy' ? 'always-proceed' : undefined }));
    if (proj.agent === 'claude') {
      at(t + 40, () => emit(projectId, { type: 'todos', items: [{ content: 'Read the failing test', status: 'completed' }, { content: 'Fix the comparison', status: 'in_progress' }, { content: 'Add a regression test', status: 'pending' }] }));
      at(t + 60, () => emit(projectId, { type: 'subagent', id: 'sa-' + t, name: 'Explore', description: 'Find the helper', state: 'running' }));
      at(t + 1500, () => emit(projectId, { type: 'subagent', id: 'sa-' + t, name: 'Explore', state: 'done' }));
    }
    // streamed text in small chunks
    const chunks = [];
    for (const part of MOCK_REPLY.slice(0, 3)) for (let i = 0; i < part.length; i += 9) chunks.push(part.slice(i, i + 9));
    for (const c of chunks) { t += 12; at(t, () => emit(projectId, { type: 'text-delta', text: c })); }
    t += 200;
    at(t, () => emit(projectId, { type: 'tool-use', id: 'tool1', name: 'Edit', input: { file_path: 'src/utils.js', old_string: 'a == b', new_string: 'a.trim() === b.trim()' } }));
    t += 900;
    at(t, () => emit(projectId, { type: 'tool-result', id: 'tool1', output: 'File edited successfully.' }));
    t += 150;
    at(t, () => emit(projectId, { type: 'tool-use', id: 'toolw', name: 'Write', input: { file_path: proj.path + '\\artifacts\\report.md', content: '# Weekly report' } }));
    t += 300;
    at(t, () => { emit(projectId, { type: 'tool-result', id: 'toolw', output: 'File created successfully.' }); p2.emitFiles(projectId, ['artifacts/report.md', 'src/utils.js']); });
    t += 150;
    at(t, () => emit(projectId, { type: 'tool-use', id: 'tool2', name: 'Bash', input: { command: 'npm test' } }));
    t += 700;
    at(t, () => emit(projectId, { type: 'tool-result', id: 'tool2', output: 'FAIL tests/utils.test.js\n  expected true\n  received false', isError: true }));
    if (proj.mode === 'default') {
      t += 200;
      at(t, () => emit(projectId, { type: 'permission-denied', id: 'tool3', tool: 'Write', reason: 'workingDir', message: 'Write to C:\\outside\\file.txt was blocked' }));
    }
    const rest = [];
    for (const part of MOCK_REPLY.slice(3)) for (let i = 0; i < part.length; i += 14) rest.push(part.slice(i, i + 14));
    for (const c of rest) { t += 10; at(t, () => emit(projectId, { type: 'text-delta', text: c })); }
    t += 100;
    at(t, () => {
      running.delete(projectId);
      emit(projectId, { type: 'result', ok: true, costUsd: 0.0123, durationMs: t });
    });
    running.set(projectId, { timers, text });
  }

  const p8 = createPhase8();
  const api = {
    isMock: true,
    settings: {
      get: async () => clone(settings),
      set: async (patch) => { settings = { ...settings, ...patch }; return clone(settings); },
    },
    projects: {
      list: async () => clone(projects),
      add: async (p) => {
        const proj = {
          id: 'p' + (projects.length + 10), name: p.name || String(p.path).split(/[\\/]/).pop(), path: p.path,
          agent: p.agent || 'claude', mode: p.mode || 'default', sessionId: null, lastOpened: new Date().toISOString(),
          autoCommit: !!p.autoCommit, model: null, effort: null, developerMode: null,
        };
        projects = [...projects, proj];
        return clone(proj);
      },
      update: async (id, patch) => {
        projects = projects.map((p) => (p.id === id ? { ...p, ...patch } : p));
        return clone(projects.find((p) => p.id === id));
      },
      remove: async (id) => { projects = projects.filter((p) => p.id !== id); },
      ...p8.projects,
      pickFolder: async () => 'C:\\Users\\leo\\Code\\NewProject',
    },
    agent: {
      send: async ({ projectId, text, allow, images }) => { p2.onUserSend(projectId, text, images); runTurn(projectId, text, allow); return { turnId: 't' + Date.now() }; },
      stop: async (projectId) => {
        const r = running.get(projectId);
        if (r) r.timers.forEach(clearTimeout);
        running.delete(projectId);
        emit(projectId, { type: 'result', ok: false, stopped: true });
      },
      status: async (projectId) => ({ running: running.has(projectId) }),
    },
    health: { check: async () => health() },
    git: {
      status: async () => ({ isRepo: true, branch: 'main', dirty: 3 }),
      undoTurn: async () => ({ ok: true, message: 'Reverted 1 commit' }),
    },
    versions: mockVersions(),
    ...p2.api,
    ...p7.api,
    auth: { login: async () => { const r = await p2.api.auth.login(); p4.setSigned('claude', true); return r; } },
    ...p4.api,
    onLogin: p4.subscribe.onLogin,
    onWindow: p4.subscribe.onWindow,
    method: p3.api,
    onMethod: p3.subscribe.onMethod,
    onFiles: p2.subscribe.onFiles,
    onDashboard: p2.subscribe.onDashboard,
    onInstall: p2.subscribe.onInstall,
    onRemote: p2.subscribe.onRemote,
    onUsage: p7.subscribe.onUsage,
    onTasks: p7.subscribe.onTasks,
    onMenu: p7.subscribe.onMenu,
    onBeforeQuit: p7.subscribe.onBeforeQuit,
    onAgentEvent: (cb) => { agentSubs.add(cb); return () => agentSubs.delete(cb); },
    onHealth: (cb) => { healthSubs.add(cb); return () => healthSubs.delete(cb); },
  };
  api.files = { ...api.files, ...p8.files };
  return api;
}
