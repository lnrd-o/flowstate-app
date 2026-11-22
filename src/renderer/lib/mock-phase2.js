// Phase 2 part of the browser mock (prompts, files, dashboard, prereq install, auth, remote, history).
// Hash flags: #nogit #nonode #nopython (default: python missing) #installfail #noremote #nologin #noclaude.

const has = (re) => typeof location !== 'undefined' && re.test(location.hash);

const T = (id, name, description, tags, body, vars = []) => ({
  id, source: 'default', name, description, tags, body, vars,
});

const DEFAULT_TEMPLATES = [
  T('bug-fix', { en: 'Fix a bug', es: 'Arreglar un error' },
    { en: 'Find the root cause of a failing behaviour and fix it with a regression test.', es: 'Encuentra la causa ra\u00edz de un comportamiento fallido y corr\u00edgelo con una prueba de regresi\u00f3n.' },
    ['debug', 'tests'],
    'There is a bug: {{symptom}}\n\nSteps to reproduce:\n{{steps}}\n\nFind the root cause, fix it, and add a regression test. Explain what you changed.',
    [
      { key: 'symptom', label: { en: 'What goes wrong', es: 'Qu\u00e9 falla' }, type: 'text', required: true },
      { key: 'steps', label: { en: 'Steps to reproduce', es: 'Pasos para reproducir' }, type: 'textarea', default: '1. ...' },
    ]),
  T('code-review', { en: 'Review code', es: 'Revisar c\u00f3digo' },
    { en: 'A focused review of the current changes.', es: 'Una revisi\u00f3n enfocada de los cambios actuales.' },
    ['quality'],
    'Review {{scope}} focusing on {{focus}}. List issues by severity and propose concrete fixes.',
    [
      { key: 'scope', label: { en: 'Scope', es: 'Alcance' }, type: 'select', options: ['the uncommitted changes', 'the last commit', 'the whole project'], default: 'the uncommitted changes' },
      { key: 'focus', label: { en: 'Focus', es: 'Enfoque' }, type: 'select', options: ['correctness', 'security', 'performance', 'readability'], default: 'correctness' },
    ]),
  T('explain-code', { en: 'Explain this code', es: 'Explicar este c\u00f3digo' },
    { en: 'A plain-language walkthrough of a file or function.', es: 'Una explicaci\u00f3n en lenguaje sencillo de un archivo o funci\u00f3n.' },
    ['learning'], 'Explain {{target}} step by step, as if I were new to this codebase.',
    [{ key: 'target', label: { en: 'File or function', es: 'Archivo o funci\u00f3n' }, type: 'text', required: true }]),
  T('refactor', { en: 'Refactor', es: 'Refactorizar' },
    { en: 'Clean up code without changing behaviour.', es: 'Limpia el c\u00f3digo sin cambiar su comportamiento.' },
    ['quality', 'tests'], 'Refactor {{target}} to improve readability. Keep the behaviour identical and keep the tests green.',
    [{ key: 'target', label: { en: 'What to refactor', es: 'Qu\u00e9 refactorizar' }, type: 'text', required: true }]),
  T('python-dashboard', { en: 'Build a Python dashboard', es: 'Crear un dashboard en Python' },
    { en: 'A Streamlit dashboard saved in the project so it can run from the Dashboard tab.', es: 'Un dashboard de Streamlit guardado en el proyecto para ejecutarlo desde la pesta\u00f1a Dashboard.' },
    ['dashboard', 'python', 'data'],
    'Build a Streamlit dashboard in dashboard.py about {{topic}}.\nData source: {{source}}.\n{{notes}}\nUse plotly for the charts and pandas for the data. It must run with: streamlit run dashboard.py',
    [
      { key: 'topic', label: { en: 'Dashboard topic', es: 'Tema del dashboard' }, type: 'text', required: true },
      { key: 'source', label: { en: 'Data source', es: 'Fuente de datos' }, type: 'select', options: ['a CSV file in this project', 'generated sample data', 'a public API'], default: 'generated sample data' },
      { key: 'notes', label: { en: 'Extra notes', es: 'Notas extra' }, type: 'textarea', default: '' },
    ]),
  T('release-notes', { en: 'Write release notes', es: 'Escribir notas de versi\u00f3n' },
    { en: 'Summarise recent commits for users.', es: 'Resume los commits recientes para los usuarios.' },
    ['docs'], 'Write release notes for the changes since the last tag. Group them as Added, Changed and Fixed.'),
  T('hello', { en: 'Quick check-in', es: 'Revisi\u00f3n r\u00e1pida' },
    { en: 'A template without variables.', es: 'Una plantilla sin variables.' }, ['misc'],
    'Give me a two-line summary of what this project does and what to work on next.'),
];

const chartSvg = (c1) => 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="260"><rect width="480" height="260" fill="#ffffff"/>'
  + '<g fill="' + c1 + '"><rect x="40" y="140" width="50" height="90"/><rect x="110" y="90" width="50" height="140"/>'
  + '<rect x="180" y="120" width="50" height="110"/><rect x="250" y="50" width="50" height="180"/><rect x="320" y="100" width="50" height="130"/>'
  + '<rect x="390" y="70" width="50" height="160"/></g><text x="40" y="30" font-family="sans-serif" font-size="16" fill="#333">Weekly signups</text></svg>');

const FILES = {
  '': [
    ['artifacts', 'dir'], ['src', 'dir'], ['docs', 'dir'], ['README.md', 'file', 1800], ['package.json', 'file', 420],
    ['logo.bin', 'file', 20480], ['build.log', 'file', 2200000],
  ],
  artifacts: [['report.md', 'file', 3100], ['chart.png', 'file', 18000], ['dashboard.html', 'file', 2400], ['data.csv', 'file', 900]],
  src: [['utils.js', 'file', 640], ['app.py', 'file', 1300], ['dashboard.py', 'file', 1500], ['index.html', 'file', 800]],
  docs: [['guide.md', 'file', 2600]],
};

const CONTENT = {
  'README.md': '# ClaudeClient\n\nA **desktop GUI** for coding agents.\n\n- Fast\n- Private\n\n```bash\nnpm install\nnpm start\n```\n\n| Command | What it does |\n|---|---|\n| `npm test` | runs tests |\n',
  'package.json': '{\n  "name": "flowstate",\n  "version": "0.1.0",\n  "scripts": { "test": "node --test" }\n}\n',
  'artifacts/report.md': '# Weekly report\n\nSignups grew **18%** week over week.\n\n## Highlights\n\n1. Onboarding completion is up\n2. Churn is flat\n\n> Numbers are from the sample dataset.\n\n```python\nimport pandas as pd\ndf = pd.read_csv("data.csv")\nprint(df.describe())\n```\n',
  'artifacts/data.csv': 'week,signups,churn\n1,120,3\n2,141,4\n3,166,3\n4,196,5\n',
  'artifacts/dashboard.html': '<!doctype html><html><head><title>Static</title><style>body{font-family:sans-serif;padding:24px;background:#f5f1e6;color:#222}h1{color:#7a5c00}</style></head><body><h1>Static dashboard</h1><p>Rendered without scripts.</p><ul><li>Signups: 196</li><li>Churn: 5</li></ul><script>document.body.append("never runs")</script></body></html>',
  'src/utils.js': 'export function same(a, b) {\n  // compare trimmed values, ignoring case\n  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();\n}\n',
  'src/app.py': 'import streamlit as st\n\nst.title("App")\nst.write("hello")\n',
  'src/dashboard.py': 'import pandas as pd\nimport plotly.express as px\nimport streamlit as st\n\ndf = pd.read_csv("artifacts/data.csv")\nst.plotly_chart(px.bar(df, x="week", y="signups"))\n',
  'src/index.html': '<h1>Hello</h1>',
  'docs/guide.md': '# Guide\n\nStart here.\n',
  'build.log': Array.from({ length: 60 }, (_, i) => '[' + String(i).padStart(2, '0') + '] building module ' + i).join('\n'),
};
const LANGS = { js: 'javascript', json: 'json', py: 'python', csv: 'plaintext', log: 'plaintext' };

export function createPhase2({ projects, emitAgent, flags }) {
  const clone = (o) => JSON.parse(JSON.stringify(o));
  let templates = clone(DEFAULT_TEMPLATES);
  const subs = { files: new Set(), dashboard: new Set(), install: new Set(), remote: new Set() };
  const fire = (kind, payload) => subs[kind].forEach((cb) => cb(payload));
  const later = (ms, fn) => setTimeout(fn, ms);
  const dash = new Map(); // projectId -> { venv, deps, running, url, app }
  const remote = new Map();
  const history = new Map();
  const pending = new Map(); // projectId -> accumulated text-delta

  const proj = (id) => projects().find((p) => p.id === id);

  history.set('p1', [
    ...(has(/#images/) ? [
      { ts: Date.now() - 7300000, t: 'user', text: 'Why does the header overflow in these two screenshots?', images: ['.flowstate/attachments/layout-before.png', '.flowstate/attachments/layout-after.png'] },
      { ts: Date.now() - 7299000, t: 'event', event: { type: 'text', text: 'In the first screenshot the header has a fixed width of 1200px, so it overflows narrow windows. Use `max-width: 100%` and let it wrap.' } },
      { ts: Date.now() - 7298000, t: 'event', event: { type: 'result', ok: true } },
    ] : []),
    { ts: Date.now() - 3600000, t: 'user', text: 'Summarise what this project does' },
    { ts: Date.now() - 3599000, t: 'event', event: { type: 'session', sessionId: 'abc' } },
    { ts: Date.now() - 3598000, t: 'event', event: { type: 'tool-use', id: 'h1', name: 'Read', input: { file_path: 'README.md' } } },
    { ts: Date.now() - 3597000, t: 'event', event: { type: 'tool-result', id: 'h1', output: '# ClaudeClient ...' } },
    { ts: Date.now() - 3596000, t: 'event', event: { type: 'text', text: 'This is **FlowState**, a desktop GUI for coding agents.\n\n- Chat with Claude or AGY\n- Review files and dashboards' } },
    { ts: Date.now() - 3595000, t: 'event', event: { type: 'result', ok: true } },
    { ts: Date.now() - 1800000, t: 'user', text: 'Write the weekly report' },
    { ts: Date.now() - 1799000, t: 'event', event: { type: 'tool-use', id: 'h2', name: 'Write', input: { file_path: 'C:\\Users\\leo\\Code\\ClaudeClient\\artifacts\\report.md', content: '# Weekly report' } } },
    { ts: Date.now() - 1798000, t: 'event', event: { type: 'tool-result', id: 'h2', output: 'File created' } },
    { ts: Date.now() - 1797000, t: 'event', event: { type: 'text', text: 'Done. The report is saved in `artifacts/report.md`.' } },
    { ts: Date.now() - 1796000, t: 'event', event: { type: 'result', ok: true } },
  ]);

  const listDir = (pid, rel) => {
    if (pid === 'p3' && rel === '') return [{ name: 'README.md', rel: 'README.md', isDir: false, size: 120, mtimeMs: Date.now() }];
    const key = String(rel || '').replace(/\\/g, '/').replace(/\/$/, '');
    const rows = FILES[key];
    if (!rows) return [];
    return rows.map(([name, kind, size]) => ({ name, rel: key ? key + '/' + name : name, isDir: kind === 'dir', size: size || 0, mtimeMs: Date.now() }));
  };

  const readFile = (rel) => {
    const key = String(rel).replace(/\\/g, '/');
    const ext = (key.split('.').pop() || '').toLowerCase();
    const size = ((FILES[key.includes('/') ? key.slice(0, key.lastIndexOf('/')) : ''] || []).find((r) => r[0] === key.split('/').pop()) || [0, 0, 100])[2];
    if (ext === 'png') return { kind: 'image', dataUrl: chartSvg('#4c8bf5'), size, truncated: false };
    if (ext === 'bin') return { kind: 'binary', size, truncated: false };
    if (ext === 'html') return { kind: 'html', content: CONTENT[key] || '<h1>html</h1>', size, truncated: false };
    if (ext === 'md') return { kind: 'markdown', content: CONTENT[key] || '# ' + key, size, truncated: false };
    return { kind: 'text', content: CONTENT[key] || '', size, truncated: key === 'build.log', lang: LANGS[ext] || 'plaintext' };
  };

  const dstate = (pid) => {
    if (!dash.has(pid)) dash.set(pid, { venv: false, deps: false, running: false, url: null, app: null });
    return dash.get(pid);
  };

  const record = (projectId, event) => {
    const list = history.get(projectId) || [];
    if (event.type === 'text-delta') { pending.set(projectId, (pending.get(projectId) || '') + event.text); return; }
    if (pending.get(projectId)) { list.push({ ts: Date.now(), t: 'event', event: { type: 'text', text: pending.get(projectId) } }); pending.delete(projectId); }
    list.push({ ts: Date.now(), t: 'event', event });
    history.set(projectId, list.slice(-500));
  };

  return {
    templates() { return templates; },
    onUserSend(projectId, text, images) {
      const list = history.get(projectId) || [];
      list.push({ ts: Date.now(), t: 'user', text, ...(Array.isArray(images) && images.length ? { images } : {}) });
      history.set(projectId, list);
    },
    record,
    emitFiles(projectId, changed) { fire('files', { projectId, changed }); },
    flagsHealth() {
      return {
        python: { found: flags.pythonInstalled || has(/#python/), version: flags.pythonInstalled || has(/#python/) ? '3.12.4' : null },
        node: { found: flags.nodeInstalled || !has(/#nonode/), version: '22.1.0' },
        git: { found: flags.gitInstalled || !has(/#nogit/), version: '2.45.0' },
        loggedIn: !has(/#nologin/) || flags.loggedIn,
      };
    },
    subscribe: {
      onFiles: (cb) => { subs.files.add(cb); return () => subs.files.delete(cb); },
      onDashboard: (cb) => { subs.dashboard.add(cb); return () => subs.dashboard.delete(cb); },
      onInstall: (cb) => { subs.install.add(cb); return () => subs.install.delete(cb); },
      onRemote: (cb) => { subs.remote.add(cb); return () => subs.remote.delete(cb); },
    },
    api: {
      prompts: {
        list: async () => clone(templates),
        save: async (tpl) => {
          const saved = { ...clone(tpl), source: 'user' };
          templates = [...templates.filter((x) => x.id !== saved.id), saved];
          return clone(saved);
        },
        delete: async (id) => { templates = templates.filter((x) => !(x.id === id && x.source === 'user')); },
        export: async (projectId, id) => ({ path: (proj(projectId) || { path: 'C:\\proj' }).path + '\\.claude\\commands\\' + id + '.md' }),
      },
      files: {
        list: async (pid, rel = '') => clone(listDir(pid, rel)),
        read: async (pid, rel) => clone(readFile(rel)),
        reveal: async () => {},
        open: async () => {},
        watch: async () => {},
      },
      dashboard: {
        status: async (pid) => {
          const s = dstate(pid);
          const py = has(/#python/) || flags.pythonInstalled;
          return {
            python: { found: py, version: py ? '3.12.4' : null }, venv: s.venv, deps: s.deps, running: s.running, url: s.url, app: s.app,
            apps: pid === 'p3' ? [] : ['src/dashboard.py', 'src/app.py'],
          };
        },
        setup: async (pid) => {
          const lines = ['Creating virtual environment in .venv ...', 'Collecting streamlit', 'Downloading streamlit-1.39.0-py2.py3-none-any.whl (8.7 MB)', 'Collecting plotly', 'Collecting pandas', 'Installing collected packages: pandas, plotly, streamlit', 'Successfully installed pandas-2.2.3 plotly-5.24.1 streamlit-1.39.0'];
          for (let i = 0; i < lines.length; i++) await new Promise((r) => later(380, r)).then(() => fire('dashboard', { projectId: pid, kind: 'log', text: lines[i] }));
          const s = dstate(pid);
          s.venv = true; s.deps = true;
          fire('dashboard', { projectId: pid, kind: 'done' });
          return { ok: true };
        },
        start: async (pid, app) => {
          const s = dstate(pid);
          await new Promise((r) => later(600, r));
          s.running = true; s.url = 'http://127.0.0.1:8501'; s.app = app;
          return { url: s.url };
        },
        stop: async (pid) => { const s = dstate(pid); s.running = false; s.url = null; },
      },
      prereq: {
        install: async (id) => {
          const lines = ['Found ' + id + ' (winget)', 'Downloading installer ...', 'Successfully verified installer hash', 'Starting package install ...', 'Successfully installed'];
          for (const l of lines) await new Promise((r) => later(450, r)).then(() => fire('install', { id, kind: 'log', text: l }));
          if (has(/#installfail/)) { fire('install', { id, kind: 'error', text: 'winget exited with code 1603' }); return { ok: false, log: '' }; }
          if (id === 'python') flags.pythonInstalled = true;
          if (id === 'git') flags.gitInstalled = true;
          if (id === 'node') flags.nodeInstalled = true;
          fire('install', { id, kind: 'done' });
          return { ok: true, log: lines.join('\n') };
        },
      },
      auth: { login: async () => { flags.loggedIn = true; return { ok: true }; } },
      remote: {
        status: async (pid) => ({ ...(remote.get(pid) || { running: false }), supported: !has(/#noremote/) }),
        start: async (pid) => {
          if (has(/#noremote/)) return { running: false, supported: false };
          await new Promise((r) => later(700, r));
          const p = proj(pid);
          const info = p && p.agent === 'agy'
            ? 'AGY daemon registered (login scoped).\nSession: ' + p.name + '\nManage it with: agy remote-control status'
            : 'Remote session ready.\nName: ' + (p ? p.name : pid) + '\nOpen: https://claude.ai/code/session_01MockSession123';
          remote.set(pid, { running: true, info });
          return { running: true, info };
        },
        stop: async (pid) => { remote.set(pid, { running: false }); return { running: false }; },
      },
      history: {
        get: async (pid) => clone(history.get(pid) || []),
        clear: async (pid) => { history.set(pid, []); },
      },
    },
  };
}
