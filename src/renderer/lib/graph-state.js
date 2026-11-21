// Pure editing logic for the methodology graph: immutable operations + undo/redo history. No DOM.
import {
  NODE_TYPES, ID_RE, KEY_RE, LIMITS, hasCycle, startNodes, layoutGraph, validateMethodology, undeclaredVars,
} from '../../shared/methodology.js';

const clone = (o) => JSON.parse(JSON.stringify(o));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** "My Method!" -> "my-method" (valid methodology id or ''). */
export function slugify(s) {
  const out = String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return out;
}

/** Id not in `taken`: base, base-2, base-3... */
export function uniqueId(base, taken) {
  const set = new Set(taken);
  const b = ID_RE.test(base) ? base : (slugify(base) || 'methodology');
  if (!set.has(b)) return b;
  for (let i = 2; i < 1000; i += 1) if (!set.has(`${b}-${i}`)) return `${b}-${i}`;
  return `${b}-${Date.now()}`;
}

/** First free node id n1, n2, ... */
export function genNodeId(m) {
  const used = new Set(m.nodes.map((n) => n.id));
  for (let i = 1; i <= LIMITS.nodes + 1; i += 1) if (!used.has('n' + i)) return 'n' + i;
  return 'n' + Date.now();
}

/** Blank methodology with one prompt node. `names` = { name:{en,es}, title:{en,es} } from the UI language files. */
export function newMethodology({ name, title, id = 'new-methodology' } = {}) {
  const now = new Date().toISOString();
  return {
    id, version: 1, source: 'user', name: name || { en: 'New methodology', es: 'New methodology' }, description: { en: '', es: '' }, tags: [], vars: [],
    nodes: [{ id: 'n1', type: 'prompt', title: title || { en: 'Prompt', es: 'Prompt' }, text: '' }], edges: [], createdAt: now, updatedAt: now,
  };
}

export function defaultNode(type, id, title, m) {
  const base = { id, type, title: clone(title) };
  switch (type) {
    case 'prompt': return { ...base, text: '' };
    case 'command': return { ...base, exe: '', args: [] };
    case 'git-commit': return { ...base, message: 'Update' };
    case 'ask-user': return { ...base, question: '', saveAs: freeVarKey(m, 'answer') };
    case 'checkpoint': return { ...base, message: '' };
    case 'artifact': return { ...base, path: '' };
    case 'condition': return { ...base, var: (m && m.vars && m.vars[0] && m.vars[0].key) || 'answer', equals: '' };
    default: throw new Error('unknown node type ' + type);
  }
}

function freeVarKey(m, base) {
  const used = new Set([...(m?.vars || []).map((v) => v.key), ...(m?.nodes || []).filter((n) => n.type === 'ask-user').map((n) => n.saveAs)]);
  if (!used.has(base)) return base;
  for (let i = 2; i < 100; i += 1) if (!used.has(base + i)) return base + i;
  return base;
}

/**
 * Add a node. If `afterId` is given and a valid connection from it exists, the new node is connected after it
 * and placed to its right. Returns { m, id, connected }.
 */
export function addNode(m, type, { title, afterId, at } = {}) {
  if (!NODE_TYPES.includes(type)) throw new Error('unknown node type');
  if (m.nodes.length >= LIMITS.nodes) return { m, id: null, connected: false, error: 'max' };
  const next = clone(m);
  const id = genNodeId(next);
  const node = defaultNode(type, id, title || { en: type, es: type }, next);
  const pos = layoutGraph(next);
  let p = at ? { x: at.x, y: at.y } : null;
  if (!p) {
    if (afterId && pos[afterId]) p = { x: pos[afterId].x + 260, y: pos[afterId].y };
    else {
      const xs = Object.values(pos);
      p = xs.length ? { x: Math.max(...xs.map((q) => q.x)) + 260, y: 0 } : { x: 0, y: 0 };
    }
  }
  while (Object.values(pos).some((q) => Math.abs(q.x - p.x) < 120 && Math.abs(q.y - p.y) < 60)) p.y += 110;
  node.x = Math.round(p.x); node.y = Math.round(p.y);
  // freeze positions of the existing nodes so the layout does not jump when edges change
  for (const n of next.nodes) { n.x = Math.round(pos[n.id].x); n.y = Math.round(pos[n.id].y); }
  next.nodes.push(node);
  let connected = false;
  if (afterId) {
    const r = connect(next, afterId, id);
    if (!r.error) { connected = true; return { m: r.m, id, connected }; }
  }
  return { m: next, id, connected };
}

/** Remove a node and its edges; a node with exactly one in and one out edge is bridged (a->n->b becomes a->b). */
export function removeNode(m, id) {
  const next = clone(m);
  if (next.nodes.length <= 1) return next;
  const ins = next.edges.filter((e) => e.to === id);
  const outs = next.edges.filter((e) => e.from === id);
  next.nodes = next.nodes.filter((n) => n.id !== id);
  next.edges = next.edges.filter((e) => e.from !== id && e.to !== id);
  if (ins.length === 1 && outs.length === 1 && ins[0].from !== outs[0].to) {
    const e = { from: ins[0].from, to: outs[0].to };
    if (ins[0].label) e.label = ins[0].label;
    next.edges.push(e);
  }
  return next;
}

export function removeEdge(m, index) {
  const next = clone(m);
  next.edges.splice(index, 1);
  return next;
}

/** Why `from -> to` cannot be added: 'self' | 'duplicate' | 'cycle' | 'branches' | 'single-out' | 'max' | 'unknown' | null. */
export function connectError(m, from, to, label) {
  if (!m.nodes.some((n) => n.id === from) || !m.nodes.some((n) => n.id === to)) return 'unknown';
  if (from === to) return 'self';
  if (m.edges.some((e) => e.from === from && e.to === to)) return 'duplicate';
  if (m.edges.length >= LIMITS.edges) return 'max';
  const src = m.nodes.find((n) => n.id === from);
  const outs = m.edges.filter((e) => e.from === from);
  if (src.type === 'condition') {
    const l = label || ['yes', 'no'].find((x) => !outs.some((e) => e.label === x));
    if (!l || outs.some((e) => e.label === l)) return 'branches';
  } else if (outs.length) return 'single-out';
  if (hasCycle(m.nodes, [...m.edges, { from, to }])) return 'cycle';
  return null;
}

/** Connect two nodes. Returns { m, error }: error is a connectError code and m is unchanged. */
export function connect(m, from, to, label) {
  const error = connectError(m, from, to, label);
  if (error) return { m, error };
  const next = clone(m);
  const src = next.nodes.find((n) => n.id === from);
  const edge = { from, to };
  if (src.type === 'condition') edge.label = label || ['yes', 'no'].find((x) => !next.edges.some((e) => e.from === from && e.label === x));
  next.edges.push(edge);
  return { m: next, error: null };
}

/** Set an edge label ('yes' | 'no' | ''); only meaningful on condition edges and unique among its siblings. */
export function setEdgeLabel(m, index, label) {
  const e = m.edges[index];
  if (!e) return { m, error: 'unknown' };
  if (label && m.edges.some((o, i) => i !== index && o.from === e.from && o.label === label)) return { m, error: 'branches' };
  const next = clone(m);
  if (label) next.edges[index].label = label; else delete next.edges[index].label;
  return { m: next, error: null };
}

export function setNodePos(m, id, x, y) {
  const next = clone(m);
  const n = next.nodes.find((q) => q.id === id);
  if (n) { n.x = Math.round(x); n.y = Math.round(y); }
  return next;
}

export function clearLayout(m) {
  const next = clone(m);
  for (const n of next.nodes) { delete n.x; delete n.y; }
  return next;
}

/** Merge `patch` into a node; keys whose value is undefined are removed. */
export function updateNode(m, id, patch) {
  const next = clone(m);
  const n = next.nodes.find((q) => q.id === id);
  if (!n) return next;
  for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete n[k]; else n[k] = clone(v); }
  return next;
}

export function updateMeta(m, patch) {
  const next = clone(m);
  for (const [k, v] of Object.entries(patch)) next[k] = clone(v);
  return next;
}

// ---- variables ----
export function addVar(m, v) {
  const next = clone(m);
  next.vars = [...(next.vars || []), clone(v)];
  return next;
}
export function updateVar(m, index, patch) {
  const next = clone(m);
  if (!next.vars[index]) return next;
  for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete next.vars[index][k]; else next.vars[index][k] = clone(v); }
  return next;
}
export function removeVar(m, index) {
  const next = clone(m);
  next.vars.splice(index, 1);
  return next;
}
export function newVar(key) {
  return { key, label: { en: key, es: key }, type: 'text', default: '', required: false };
}
/** Declare every undeclared {{key}} as a text var. */
export function declareVars(m, keys) {
  let next = m;
  for (const k of keys) if (KEY_RE.test(k) && !(next.vars || []).some((v) => v.key === k)) next = addVar(next, newVar(k));
  return next;
}

// ---- feedback ----
/** Non-fatal editor hints beyond the shared validator: [{ code, nodeId?, label? }]. */
export function lint(m) {
  const out = [];
  for (const n of m.nodes) {
    const outs = m.edges.filter((e) => e.from === n.id);
    if (n.type === 'condition') {
      for (const l of ['yes', 'no']) if (!outs.some((e) => e.label === l)) out.push({ code: 'branch-missing', nodeId: n.id, label: l });
    } else if (outs.length > 1) out.push({ code: 'multi-out', nodeId: n.id });
  }
  const starts = (() => { try { return startNodes(m).map((n) => n.id); } catch { return []; } })();
  if (starts.length > 1) out.push({ code: 'multi-start', nodeIds: starts });
  const keys = undeclaredVars(m);
  for (const k of keys) out.push({ code: 'undeclared-var', key: k });
  return out;
}

export const issues = (m) => ({ errors: validateMethodology(m), lint: lint(m) });

// ---- history (undo / redo) ----
export function createHistory(initial, limit = 100) {
  return { past: [], present: clone(initial), future: [], limit, key: null };
}
/** Push a new state. Consecutive commits with the same non-null `key` (typing in one field) replace the present. */
export function commit(hist, next, key = null) {
  if (same(hist.present, next)) return hist;
  if (key && hist.key === key) return { ...hist, present: clone(next), future: [] };
  const past = [...hist.past, hist.present].slice(-hist.limit);
  return { ...hist, past, present: clone(next), future: [], key };
}
export function undo(hist) {
  if (!hist.past.length) return hist;
  const past = hist.past.slice(0, -1);
  return { ...hist, past, present: hist.past[hist.past.length - 1], future: [hist.present, ...hist.future], key: null };
}
export function redo(hist) {
  if (!hist.future.length) return hist;
  return { ...hist, past: [...hist.past, hist.present], present: hist.future[0], future: hist.future.slice(1), key: null };
}
export const canUndo = (h) => h.past.length > 0;
export const canRedo = (h) => h.future.length > 0;
