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

export function createMockApi() {
  const clone = (o) => JSON.parse(JSON.stringify(o));
  let settings = {
    language: 'en', theme: 'dark', codeTheme: 'vs-dark', claudePath: null, agyPath: null,
    lastProjectId: null, autoLaunch: false,
    walkthroughDone: !/#(walkthrough|first)/.test(location.hash),
  };
  let projects = [
    { id: 'p1', name: 'ClaudeClient', path: 'C:\\Users\\leo\\Code\\ClaudeClient', agent: 'claude', mode: 'default', sessionId: 'abc', lastOpened: new Date().toISOString(), autoCommit: true },
    { id: 'p2', name: 'dashboards-with-a-rather-long-project-name', path: 'C:\\Users\\leo\\Code\\dashboards', agent: 'agy', mode: 'plan', sessionId: null, lastOpened: new Date().toISOString(), autoCommit: false },
    { id: 'p3', name: 'notes', path: 'C:\\Users\\leo\\Notes', agent: 'claude', mode: 'acceptEdits', sessionId: null, lastOpened: new Date().toISOString(), autoCommit: false },
  ];
  const agentSubs = new Set();
  const healthSubs = new Set();
  const running = new Map();
  const emit = (projectId, event) => agentSubs.forEach((cb) => cb({ projectId, event }));

  const health = () => ({
    claude: { found: !/#noclaude/.test(location.hash), path: 'C:\\bin\\claude.exe', version: '2.1.0', loggedIn: !/#nologin/.test(location.hash) },
    agy: { found: true, path: 'C:\\bin\\agy.exe', version: '0.9.2' },
    node: { found: true, version: '22.1.0' },
    git: { found: true, version: '2.45.0' },
    python: { found: false, version: null },
    vpn: { active: /#vpn/.test(location.hash), adapters: /#vpn/.test(location.hash) ? ['Corp VPN'] : [] },
    anthropicReachable: !/#vpn/.test(location.hash),
  });
  window.addEventListener('hashchange', () => healthSubs.forEach((cb) => cb(health())));

  function runTurn(projectId, text) {
    const proj = projects.find((p) => p.id === projectId);
    const timers = [];
    const at = (ms, fn) => timers.push(setTimeout(fn, ms));
    let t = 100;
    at(t, () => emit(projectId, { type: 'session', sessionId: 'abc', warning: proj.agent === 'agy' ? 'always-proceed' : undefined }));
    // streamed text in small chunks
    const chunks = [];
    for (const part of MOCK_REPLY.slice(0, 3)) for (let i = 0; i < part.length; i += 9) chunks.push(part.slice(i, i + 9));
    for (const c of chunks) { t += 12; at(t, () => emit(projectId, { type: 'text-delta', text: c })); }
    t += 200;
    at(t, () => emit(projectId, { type: 'tool-use', id: 'tool1', name: 'Edit', input: { file_path: 'src/utils.js', old_string: 'a == b', new_string: 'a.trim() === b.trim()' } }));
    t += 900;
    at(t, () => emit(projectId, { type: 'tool-result', id: 'tool1', output: 'File edited successfully.' }));
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

  return {
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
          autoCommit: !!p.autoCommit,
        };
        projects = [...projects, proj];
        return clone(proj);
      },
      update: async (id, patch) => {
        projects = projects.map((p) => (p.id === id ? { ...p, ...patch } : p));
        return clone(projects.find((p) => p.id === id));
      },
      remove: async (id) => { projects = projects.filter((p) => p.id !== id); },
      pickFolder: async () => 'C:\\Users\\leo\\Code\\NewProject',
    },
    agent: {
      send: async ({ projectId, text }) => { runTurn(projectId, text); return { turnId: 't' + Date.now() }; },
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
    onAgentEvent: (cb) => { agentSubs.add(cb); return () => agentSubs.delete(cb); },
    onHealth: (cb) => { healthSubs.add(cb); return () => healthSubs.delete(cb); },
  };
}
