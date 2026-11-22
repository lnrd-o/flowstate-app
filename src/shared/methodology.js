// FlowState Methodology model (v1). Pure functions shared by main (store/runner/recorder) and renderer (graph/editor/wizard).
//
// Methodology = {
//   id, version: 1, source: 'bundled'|'user'|'recorded',
//   name: {en, es}, description: {en, es}, tags: string[],
//   vars:  [{ key, label:{en,es}, type:'text'|'textarea'|'select'|'path', default?, options?, required? }],
//   nodes: [Node], edges: [{ from, to, label? }],      // label 'yes'/'no' for condition branches
//   createdAt, updatedAt (ISO)
// }
// Node = { id, type, title:{en,es}|string, x?, y?, ...type fields }
//   prompt     { text, agent?: 'claude'|'agy', mode?: 'default'|'acceptEdits'|'plan' }   send {{vars}}-substituted text to the agent, wait for the turn to end
//   command    { exe, args: string[] }          run exe with args (execFile, no shell) in the project dir; ALWAYS needs user confirmation at run time
//   git-commit { message }                     commit all (secret-safe) changes with the message
//   ask-user   { question, saveAs }            pause, ask the user, store the answer in vars[saveAs]
//   checkpoint { message }                     pause until the user approves (or rejects => run stops)
//   artifact   { path, description? }          verify a file/dir exists in the project after the previous steps (warn node state if missing)
//   condition  { var, equals }                 follow the edge labelled 'yes' if vars[var] === equals, else 'no'

export const NODE_TYPES = Object.freeze(['prompt', 'command', 'git-commit', 'ask-user', 'checkpoint', 'artifact', 'condition']);
// 'file' = a file the user picks; it is COPIED into the project (<project>/data/) and the variable holds the project-relative path.
export const VAR_TYPES = Object.freeze(['text', 'textarea', 'select', 'path', 'file']);
// Office/analysis "cases" are bundled methodologies with meta = { kind:'case', category, icon }; the new-project wizard lists them as cards.
export const CASE_CATEGORIES = Object.freeze(['excel', 'web', 'data', 'dashboard', 'research', 'document', 'automation', 'other']);
export const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/;
export const LIMITS = Object.freeze({ nodes: 200, edges: 400, vars: 40, text: 20000, title: 200 });

const isStr = (v, max = LIMITS.text) => typeof v === 'string' && v.length <= max;
const isI18n = (v) => v && typeof v === 'object' && isStr(v.en, 400) && (v.es === undefined || isStr(v.es, 400));

/** Returns an array of error strings ([] = valid). Never throws. */
export function validateMethodology(m) {
  const errs = [];
  if (!m || typeof m !== 'object') return ['not an object'];
  if (!ID_RE.test(m.id ?? '')) errs.push('id must match ' + ID_RE);
  if (m.version !== 1) errs.push('version must be 1');
  if (!isI18n(m.name)) errs.push('name must be {en, es?}');
  if (m.description !== undefined && !isI18n(m.description)) errs.push('description must be {en, es?}');
  if (m.meta !== undefined) {
    const me = m.meta;
    if (!me || typeof me !== 'object' || Array.isArray(me)) errs.push('meta must be an object');
    else {
      if (me.kind !== undefined && me.kind !== 'case') errs.push('meta.kind must be "case"');
      if (me.category !== undefined && !CASE_CATEGORIES.includes(me.category)) errs.push('meta.category invalid');
      if (me.icon !== undefined && !isStr(me.icon, 40)) errs.push('meta.icon invalid');
    }
  }
  const vars = Array.isArray(m.vars) ? m.vars : (m.vars === undefined ? [] : null);
  if (!vars) errs.push('vars must be an array');
  else {
    if (vars.length > LIMITS.vars) errs.push('too many vars');
    const seen = new Set();
    for (const v of vars) {
      if (!v || !KEY_RE.test(v.key ?? '')) { errs.push('bad var key'); continue; }
      if (seen.has(v.key)) errs.push('duplicate var ' + v.key);
      seen.add(v.key);
      if (!VAR_TYPES.includes(v.type)) errs.push(`var ${v.key}: bad type`);
      if (v.type === 'select' && (!Array.isArray(v.options) || !v.options.length)) errs.push(`var ${v.key}: select needs options`);
    }
  }
  if (!Array.isArray(m.nodes) || !m.nodes.length) errs.push('nodes must be a non-empty array');
  else if (m.nodes.length > LIMITS.nodes) errs.push('too many nodes');
  else {
    const ids = new Set();
    for (const n of m.nodes) {
      if (!n || !/^[A-Za-z0-9_-]{1,40}$/.test(n.id ?? '')) { errs.push('bad node id'); continue; }
      if (ids.has(n.id)) errs.push('duplicate node id ' + n.id);
      ids.add(n.id);
      if (!NODE_TYPES.includes(n.type)) { errs.push(`node ${n.id}: unknown type`); continue; }
      if (!(isStr(n.title, LIMITS.title) || isI18n(n.title))) errs.push(`node ${n.id}: title`);
      if (n.type === 'prompt' && !isStr(n.text)) errs.push(`node ${n.id}: prompt.text`);
      if (n.type === 'command' && (!isStr(n.exe, 260) || !Array.isArray(n.args) || n.args.some((a) => !isStr(a, 1000)))) errs.push(`node ${n.id}: command exe/args`);
      if (n.type === 'git-commit' && !isStr(n.message, 300)) errs.push(`node ${n.id}: git-commit.message`);
      if (n.type === 'ask-user' && (!isStr(n.question, 1000) || !KEY_RE.test(n.saveAs ?? ''))) errs.push(`node ${n.id}: ask-user question/saveAs`);
      if (n.type === 'checkpoint' && !isStr(n.message, 1000)) errs.push(`node ${n.id}: checkpoint.message`);
      if (n.type === 'artifact' && !isStr(n.path, 260)) errs.push(`node ${n.id}: artifact.path`);
      if (n.type === 'condition' && (!KEY_RE.test(n.var ?? '') || !isStr(n.equals, 500))) errs.push(`node ${n.id}: condition var/equals`);
    }
    const edges = Array.isArray(m.edges) ? m.edges : (m.edges === undefined ? [] : null);
    if (!edges) errs.push('edges must be an array');
    else {
      if (edges.length > LIMITS.edges) errs.push('too many edges');
      for (const e of edges) {
        if (!e || !ids.has(e.from) || !ids.has(e.to)) errs.push('edge references unknown node');
        else if (e.from === e.to) errs.push('self edge on ' + e.from);
      }
      if (!errs.length && hasCycle(m.nodes, edges)) errs.push('graph has a cycle');
      if (!errs.length && startNodes(m).length !== 1) errs.push('graph must have exactly one start node (no incoming edge)');
    }
  }
  return errs;
}

export function startNodes(m) {
  const incoming = new Set((m.edges ?? []).map((e) => e.to));
  return m.nodes.filter((n) => !incoming.has(n.id));
}

export function hasCycle(nodes, edges) {
  const out = new Map(nodes.map((n) => [n.id, []]));
  for (const e of edges) out.get(e.from)?.push(e.to);
  const state = new Map();
  const visit = (id) => {
    if (state.get(id) === 1) return true;
    if (state.get(id) === 2) return false;
    state.set(id, 1);
    for (const t of out.get(id) ?? []) if (visit(t)) return true;
    state.set(id, 2);
    return false;
  };
  return nodes.some((n) => visit(n.id));
}

/** Next node id after `nodeId`. For condition nodes pass the evaluated branch ('yes'|'no'). Returns null at the end. */
export function nextNodeId(m, nodeId, branch) {
  const outs = (m.edges ?? []).filter((e) => e.from === nodeId);
  if (!outs.length) return null;
  if (branch) return (outs.find((e) => e.label === branch) ?? null)?.to ?? null;
  return outs[0].to;
}

export function evalCondition(node, vars) {
  return String(vars?.[node.var] ?? '') === node.equals ? 'yes' : 'no';
}

/** Replace {{key}} with vars[key]. Unknown keys are left untouched (so they stay visible), values are inserted verbatim. */
export function substitute(text, vars = {}) {
  return String(text).replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (all, k) => (k in vars ? String(vars[k]) : all));
}

export function extractVarKeys(text) {
  return [...new Set([...String(text).matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)].map((m) => m[1]))];
}

/** Keys used in the graph that are neither declared vars nor produced by an ask-user node. */
export function undeclaredVars(m) {
  const declared = new Set([...(m.vars ?? []).map((v) => v.key), ...m.nodes.filter((n) => n.type === 'ask-user').map((n) => n.saveAs), 'projectName', 'projectPath']);
  const used = new Set();
  for (const n of m.nodes) {
    for (const f of [n.text, n.message, n.question, n.path, n.exe, ...(n.args ?? [])]) if (f) extractVarKeys(f).forEach((k) => used.add(k));
    if (n.type === 'condition') used.add(n.var);
  }
  return [...used].filter((k) => !declared.has(k));
}

/** Layered layout for the graph view: returns {id: {x, y}} (columns by depth, rows by order). Respects node.x/node.y if both set. */
export function layoutGraph(m, { colW = 260, rowH = 110 } = {}) {
  const depth = new Map();
  const outs = new Map(m.nodes.map((n) => [n.id, []]));
  for (const e of m.edges ?? []) outs.get(e.from)?.push(e.to);
  const start = startNodes(m)[0]?.id ?? m.nodes[0].id;
  const queue = [[start, 0]];
  while (queue.length) {
    const [id, d] = queue.shift();
    if ((depth.get(id) ?? -1) >= d) continue;
    depth.set(id, d);
    for (const t of outs.get(id) ?? []) queue.push([t, d + 1]);
  }
  const rows = new Map();
  const pos = {};
  for (const n of m.nodes) {
    const d = depth.get(n.id) ?? 0;
    const r = rows.get(d) ?? 0;
    rows.set(d, r + 1);
    pos[n.id] = Number.isFinite(n.x) && Number.isFinite(n.y) ? { x: n.x, y: n.y } : { x: d * colW, y: r * rowH };
  }
  return pos;
}

export function pickText(v, lang = 'en') {
  if (typeof v === 'string') return v;
  return v?.[lang] || v?.en || '';
}
