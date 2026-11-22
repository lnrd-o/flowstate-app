// Phase 3 part of the browser mock: methodologies (list/get/save/delete/record/import/export) and a runner simulation.
// Hash flags: #runfail (the second prompt node fails), #fastrun (short delays).
import { CASES } from './mock-phase8.js';
import { validateMethodology, nextNodeId, startNodes, evalCondition, substitute, ID_RE } from '../../shared/methodology.js';

const has = (re) => typeof location !== 'undefined' && re.test(location.hash);
const clone = (o) => JSON.parse(JSON.stringify(o));
const iso = (d) => new Date(d).toISOString();
const DAY = 86400000;

const N = (id, type, en, es, fields = {}) => ({ id, type, title: { en, es }, ...fields });

const BUNDLED = [
  {
    id: 'data-dashboard', version: 1, source: 'bundled',
    name: { en: 'Data dashboard', es: 'Dashboard de datos' },
    description: { en: 'Explore a dataset, plan a Streamlit dashboard, build it, test it and commit.', es: 'Explora un conjunto de datos, planifica un dashboard de Streamlit, constr\u00fayelo, pru\u00e9balo y haz commit.' },
    tags: ['dashboard', 'python', 'data'],
    vars: [
      { key: 'dataPath', label: { en: 'Data file or folder', es: 'Archivo o carpeta de datos' }, type: 'path', required: true },
      { key: 'topic', label: { en: 'Dashboard topic', es: 'Tema del dashboard' }, type: 'text', required: true, default: 'weekly signups' },
      { key: 'style', label: { en: 'Style', es: 'Estilo' }, type: 'select', options: ['minimal', 'detailed', 'executive'], default: 'minimal' },
      { key: 'runTests', label: { en: 'Run the tests?', es: '\u00bfEjecutar las pruebas?' }, type: 'select', options: ['yes', 'no'], default: 'yes' },
      { key: 'notes', label: { en: 'Extra notes', es: 'Notas extra' }, type: 'textarea', default: '' },
    ],
    nodes: [
      N('n1', 'prompt', 'Explore the data', 'Explorar los datos', { text: 'Read {{dataPath}} and summarise columns, ranges and quality problems for {{topic}}.', mode: 'plan' }),
      N('n2', 'prompt', 'Plan the dashboard', 'Planificar el dashboard', { text: 'Propose a {{style}} Streamlit dashboard about {{topic}}. List the charts and filters.\n{{notes}}', mode: 'plan' }),
      N('n3', 'checkpoint', 'Review the plan', 'Revisar el plan', { message: 'Does the plan look right? Approve to start building.' }),
      N('n4', 'prompt', 'Build dashboard.py', 'Construir dashboard.py', { text: 'Build dashboard.py in {{projectName}} following the approved plan. Use plotly and pandas.', mode: 'acceptEdits' }),
      N('n5', 'condition', 'Run tests?', '\u00bfEjecutar pruebas?', { var: 'runTests', equals: 'yes' }),
      N('n6', 'command', 'Run the tests', 'Ejecutar las pruebas', { exe: 'python', args: ['-m', 'pytest', '-q'] }),
      N('n7', 'artifact', 'dashboard.py exists', 'Existe dashboard.py', { path: 'dashboard.py', description: 'The generated app' }),
      N('n8', 'git-commit', 'Commit', 'Hacer commit', { message: 'Add {{topic}} dashboard' }),
    ],
    edges: [
      { from: 'n1', to: 'n2' }, { from: 'n2', to: 'n3' }, { from: 'n3', to: 'n4' }, { from: 'n4', to: 'n5' },
      { from: 'n5', to: 'n6', label: 'yes' }, { from: 'n5', to: 'n7', label: 'no' }, { from: 'n6', to: 'n7' }, { from: 'n7', to: 'n8' },
    ],
    createdAt: iso(Date.now() - 60 * DAY), updatedAt: iso(Date.now() - 20 * DAY),
  },
  {
    id: 'feature-tdd', version: 1, source: 'bundled',
    name: { en: 'Feature with tests first', es: 'Funcionalidad con pruebas primero' },
    description: { en: 'Write failing tests, implement the feature, review and commit.', es: 'Escribe pruebas que fallan, implementa la funcionalidad, rev\u00edsala y haz commit.' },
    tags: ['tests', 'quality'],
    vars: [{ key: 'feature', label: { en: 'Feature to build', es: 'Funcionalidad a construir' }, type: 'textarea', required: true }],
    nodes: [
      N('n1', 'prompt', 'Write failing tests', 'Escribir pruebas que fallan', { text: 'Write tests for: {{feature}}. They must fail for now.' }),
      N('n2', 'command', 'Confirm tests fail', 'Confirmar que fallan', { exe: 'npm', args: ['test'] }),
      N('n3', 'prompt', 'Implement', 'Implementar', { text: 'Implement {{feature}} until the tests pass.', mode: 'acceptEdits' }),
      N('n4', 'checkpoint', 'Review the diff', 'Revisar el diff', { message: 'Review the changes before committing.' }),
      N('n5', 'git-commit', 'Commit', 'Hacer commit', { message: 'feat: {{feature}}' }),
    ],
    edges: [{ from: 'n1', to: 'n2' }, { from: 'n2', to: 'n3' }, { from: 'n3', to: 'n4' }, { from: 'n4', to: 'n5' }],
    createdAt: iso(Date.now() - 50 * DAY), updatedAt: iso(Date.now() - 12 * DAY),
  },
  {
    id: 'code-audit', version: 1, source: 'bundled',
    name: { en: 'Security audit', es: 'Auditor\u00eda de seguridad' },
    description: { en: 'Audit the project, ask how severe the findings are and branch to a fix or a report.', es: 'Audita el proyecto, pregunta la severidad de los hallazgos y sigue con un arreglo o un reporte.' },
    tags: ['security'],
    vars: [{ key: 'scope', label: { en: 'Scope', es: 'Alcance' }, type: 'select', options: ['the whole project', 'src only', 'dependencies'], default: 'the whole project' }],
    nodes: [
      N('n1', 'prompt', 'Audit', 'Auditar', { text: 'Audit {{scope}} of {{projectName}} for security problems. List findings by severity.', mode: 'plan' }),
      N('n2', 'ask-user', 'Rate severity', 'Calificar severidad', { question: 'Is any finding high severity? (high / low)', saveAs: 'severity' }),
      N('n3', 'condition', 'High severity?', '\u00bfSeveridad alta?', { var: 'severity', equals: 'high' }),
      N('n4', 'checkpoint', 'Approve fixes', 'Aprobar arreglos', { message: 'Approve applying the fixes?' }),
      N('n5', 'prompt', 'Write the report', 'Escribir el reporte', { text: 'Write audit-report.md with the findings.' }),
      N('n6', 'artifact', 'Report exists', 'Existe el reporte', { path: 'audit-report.md' }),
    ],
    edges: [{ from: 'n1', to: 'n2' }, { from: 'n2', to: 'n3' }, { from: 'n3', to: 'n4', label: 'yes' }, { from: 'n3', to: 'n5', label: 'no' }, { from: 'n4', to: 'n5' }, { from: 'n5', to: 'n6' }],
    createdAt: iso(Date.now() - 40 * DAY), updatedAt: iso(Date.now() - 3 * DAY),
  },
];

BUNDLED.push(...CASES);

const summary = (m) => ({
  id: m.id, source: m.source, name: m.name, description: m.description || { en: '' }, tags: m.tags || [],
  meta: m.meta, nodeCount: m.nodes.length, varCount: (m.vars || []).length, updatedAt: m.updatedAt,
});

const slug = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'recorded';

export function createPhase3({ projects, getHistory, emitAgent }) {
  const store = new Map(BUNDLED.map((m) => [m.id, clone(m)]));
  const runs = new Map(); // projectId -> { state, timer, resolver }
  const subs = new Set();
  let runCounter = 0;
  const fire = (projectId, state) => subs.forEach((cb) => cb({ projectId, state: clone(state) }));
  const delay = () => (has(/#fastrun/) ? 120 : 900);

  async function record(projectId, opts = {}) {
    const proj = projects().find((p) => p.id === projectId);
    if (!proj) throw new Error('Unknown project');
    let recs = await getHistory(projectId);
    recs = recs.filter((r) => (opts.fromTs == null || r.ts >= opts.fromTs) && (opts.toTs == null || r.ts <= opts.toTs));
    const turns = [];
    for (const r of recs) {
      if (r.t === 'user') turns.push({ text: r.text, tools: [], files: new Set(), commit: false });
      else if (turns.length && r.t === 'event' && r.event) {
        const ev = r.event;
        const cur = turns[turns.length - 1];
        if (ev.type === 'tool-use') { cur.tools.push(ev.name); const f = ev.input && (ev.input.file_path || ev.input.path); if (f) cur.files.add(String(f).split(/[\\/]/).pop()); if (ev.name === 'Bash' && /git commit/.test(String(ev.input && ev.input.command))) cur.commit = true; }
        if (ev.type === 'commit') cur.commit = true;
      }
    }
    if (!turns.length) throw new Error('This project has no chat history to record yet.');
    const nodes = []; const edges = []; const vars = [];
    const keys = new Set();
    const swap = (txt) => String(txt).split(proj.name).join('{{projectName}}').split(proj.path).join('{{projectPath}}');
    turns.forEach((tn, i) => {
      const id = 'n' + (nodes.length + 1);
      const text = swap(tn.text);
      for (const m of text.matchAll(/\{\{\s*([A-Za-z_]\w*)\s*\}\}/g)) if (!['projectName', 'projectPath'].includes(m[1])) keys.add(m[1]);
      const note = [tn.tools.length ? 'Tools: ' + [...new Set(tn.tools)].join(', ') : '', tn.files.size ? 'Files: ' + [...tn.files].join(', ') : ''].filter(Boolean).join('. ');
      nodes.push({ id, type: 'prompt', title: tn.text.split('\n')[0].slice(0, 40) || 'Turn ' + (i + 1), text, ...(note ? { note } : {}) });
      if (nodes.length > 1) edges.push({ from: nodes[nodes.length - 2].id, to: id });
      if (tn.commit) { const cid = 'n' + (nodes.length + 1); nodes.push({ id: cid, type: 'git-commit', title: 'Commit', message: 'Update' }); edges.push({ from: id, to: cid }); }
    });
    for (const k of keys) vars.push({ key: k, label: { en: k, es: k }, type: 'text' });
    const name = opts.name || 'Recorded from ' + proj.name;
    const now = new Date().toISOString();
    return { id: slug(name), version: 1, source: 'recorded', name: { en: name, es: name }, description: { en: 'Recorded from the chat history.', es: 'Grabada desde el historial del chat.' }, tags: ['recorded'], vars, nodes, edges, createdAt: now, updatedAt: now };
  }

  function finish(run, status, error) {
    const st = run.state;
    st.status = status; st.endedAt = Date.now(); st.current = null; st.waiting = undefined;
    if (error) st.error = error;
    if (run.timer) clearTimeout(run.timer);
    run.timer = null; run.resolver = null;
    fire(st.projectId, st);
  }

  function walk(run, m, nodeId) {
    const st = run.state;
    if (!nodeId) { finish(run, 'done'); return; }
    const node = m.nodes.find((n) => n.id === nodeId);
    st.current = nodeId; st.status = 'running';
    st.nodes[nodeId] = { state: 'running', startedAt: Date.now() };
    fire(st.projectId, st);
    const complete = (state, message, branch) => {
      st.nodes[nodeId] = { ...st.nodes[nodeId], state, endedAt: Date.now(), ...(message ? { message } : {}) };
      st.status = 'running'; st.waiting = undefined;
      fire(st.projectId, st);
      run.timer = setTimeout(() => walk(run, m, nextNodeId(m, nodeId, branch)), 250);
    };
    const wait = (kind, text, command) => {
      st.nodes[nodeId].state = 'waiting'; st.status = 'waiting';
      st.waiting = { nodeId, kind, text, ...(command ? { command } : {}) };
      fire(st.projectId, st);
      run.resolver = (resp) => {
        run.resolver = null;
        if (kind === 'ask-user') { st.vars[node.saveAs] = String(resp.answer ?? ''); complete('done', 'Answer: ' + st.vars[node.saveAs]); return; }
        if (!resp.approve) {
          st.nodes[nodeId] = { ...st.nodes[nodeId], state: 'error', endedAt: Date.now(), message: kind === 'checkpoint' ? 'Rejected' : 'Denied' };
          finish(run, kind === 'checkpoint' ? 'stopped' : 'stopped', undefined);
          return;
        }
        complete('done', kind === 'checkpoint' ? 'Approved' : 'exit 0');
      };
    };
    run.timer = setTimeout(() => {
      if (node.type === 'prompt') {
        const text = substitute(node.text, st.vars);
        emitAgent(st.projectId, { type: 'text-delta', text: 'Working on: ' + text.slice(0, 80) + '\n\n' });
        const failing = has(/#runfail/) && Object.values(st.nodes).filter((x) => x.state === 'done').length >= 1 && node.type === 'prompt' && nodeId !== m.nodes[0].id;
        if (failing) {
          emitAgent(st.projectId, { type: 'result', ok: false, error: 'Mock failure' });
          st.nodes[nodeId] = { ...st.nodes[nodeId], state: 'error', endedAt: Date.now(), message: 'The agent reported an error' };
          finish(run, 'error', 'The agent reported an error in "' + (node.title.en || node.id) + '".');
          return;
        }
        emitAgent(st.projectId, { type: 'result', ok: true, costUsd: 0.01, durationMs: 800 });
        complete('done', text.slice(0, 60));
      } else if (node.type === 'command') wait('command-confirm', 'Run this command in the project folder?', { exe: node.exe, args: (node.args || []).map((a) => substitute(a, st.vars)) });
      else if (node.type === 'checkpoint') wait('checkpoint', substitute(node.message, st.vars));
      else if (node.type === 'ask-user') wait('ask-user', substitute(node.question, st.vars));
      else if (node.type === 'condition') { const b = evalCondition(node, st.vars); complete('done', node.var + ' -> ' + b, b); }
      else if (node.type === 'artifact') {
        if (/missing/.test(node.path)) complete('warn', 'File not found: ' + node.path); else complete('done', node.path);
      } else complete('done', 'Committed: ' + substitute(node.message, st.vars));
    }, delay());
  }

  const api = {
    list: async () => [...store.values()].map(summary).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))),
    get: async (id) => { const m = store.get(id); if (!m) throw new Error('Unknown methodology: ' + id); return clone(m); },
    save: async (m) => {
      const errs = validateMethodology(m);
      if (errs.length) throw new Error('Invalid methodology: ' + errs.join('; '));
      const cur = store.get(m.id);
      const saved = { ...clone(m), source: 'user', createdAt: (cur && cur.createdAt) || m.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
      store.set(saved.id, saved);
      return clone(saved);
    },
    delete: async (id) => {
      const cur = store.get(id);
      if (!cur) return;
      if (cur.source === 'bundled') throw new Error('Bundled methodologies cannot be deleted');
      store.delete(id);
    },
    record: async (projectId, opts) => record(projectId, opts),
    import: async () => {
      const now = new Date().toISOString();
      return {
        id: 'imported-flow', version: 1, source: 'user', name: { en: 'Imported flow', es: 'Flujo importado' }, description: { en: 'Loaded from a JSON file.', es: 'Cargado desde un archivo JSON.' }, tags: ['imported'], vars: [],
        nodes: [N('n1', 'prompt', 'Summarise', 'Resumir', { text: 'Summarise this project.' }), N('n2', 'checkpoint', 'OK?', '\u00bfListo?', { message: 'Continue?' })],
        edges: [{ from: 'n1', to: 'n2' }], createdAt: now, updatedAt: now,
      };
    },
    export: async (id) => (store.has(id) ? { path: 'C:\\Users\\leo\\Downloads\\' + id + '.json' } : null),
    run: async (projectId, methodologyId, vars) => {
      const m = store.get(methodologyId);
      if (!m) throw new Error('Unknown methodology');
      const proj = projects().find((p) => p.id === projectId);
      if (!proj) throw new Error('Unknown project');
      const cur = runs.get(projectId);
      if (cur && ['running', 'waiting'].includes(cur.state.status)) throw new Error('A run is already active for this project');
      for (const v of m.vars || []) if (v.required && !String((vars || {})[v.key] ?? '').trim()) throw new Error('Missing required variable: ' + v.key);
      const runId = 'r' + (++runCounter);
      const nodes = {};
      for (const n of m.nodes) nodes[n.id] = { state: 'pending' };
      const state = { runId, projectId, methodologyId, status: 'running', vars: { projectName: proj.name, projectPath: proj.path, ...(vars || {}) }, current: null, startedAt: Date.now(), nodes };
      const run = { state, timer: null, resolver: null, m: clone(m) };
      runs.set(projectId, run);
      fire(projectId, state);
      walk(run, run.m, startNodes(run.m)[0].id);
      return { runId };
    },
    respond: async (runId, nodeId, response) => {
      const run = [...runs.values()].find((r) => r.state.runId === runId);
      if (!run || !run.resolver || !run.state.waiting || run.state.waiting.nodeId !== nodeId) throw new Error('Nothing is waiting for a response');
      run.resolver(response || {});
    },
    stop: async (runId) => {
      const run = [...runs.values()].find((r) => r.state.runId === runId);
      if (!run || !['running', 'waiting'].includes(run.state.status)) return;
      const cur = run.state.current;
      if (cur && run.state.nodes[cur] && ['running', 'waiting'].includes(run.state.nodes[cur].state)) run.state.nodes[cur] = { ...run.state.nodes[cur], state: 'error', endedAt: Date.now(), message: 'Stopped' };
      finish(run, 'stopped');
    },
    runState: async (projectId) => { const r = runs.get(projectId); return r ? clone(r.state) : null; },
  };
  return {
    api,
    subscribe: { onMethod: (cb) => { subs.add(cb); return () => subs.delete(cb); } },
    ID_RE,
  };
}
