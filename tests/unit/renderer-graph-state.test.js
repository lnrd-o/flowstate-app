import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateMethodology } from '../../src/shared/methodology.js';
import {
  slugify, uniqueId, genNodeId, newMethodology, addNode, removeNode, removeEdge, connect, connectError, setEdgeLabel, setNodePos,
  clearLayout, updateNode, declareVars, lint, createHistory, commit, undo, redo, canUndo, canRedo, addVar, updateVar, removeVar,
} from '../../src/renderer/lib/graph-state.js';

const T = { en: 'T', es: 'T' };
const base = () => ({
  id: 'demo', version: 1, name: { en: 'Demo' }, vars: [{ key: 'topic', type: 'text' }],
  nodes: [
    { id: 'a', type: 'prompt', title: 'A', text: 'x {{topic}}' },
    { id: 'b', type: 'condition', title: 'B', var: 'topic', equals: 'x' },
    { id: 'c', type: 'checkpoint', title: 'C', message: 'm' },
    { id: 'd', type: 'git-commit', title: 'D', message: 'done' },
  ],
  edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c', label: 'yes' }, { from: 'b', to: 'd', label: 'no' }, { from: 'c', to: 'd' }],
});

test('newMethodology is valid with a single prompt node', () => {
  const m = newMethodology({});
  assert.deepEqual(validateMethodology(m), []);
  assert.equal(m.nodes.length, 1);
});

test('slugify / uniqueId / genNodeId', () => {
  assert.equal(slugify('Mi M\u00e9todo Nuevo!'), 'mi-metodo-nuevo');
  assert.equal(uniqueId('demo', ['demo', 'demo-2']), 'demo-3');
  assert.equal(uniqueId('Bad Id', []), 'bad-id');
  assert.equal(genNodeId(base()), 'n1');
  const m = newMethodology({});
  assert.equal(genNodeId(m), 'n2');
});

test('connect prevents cycles, duplicates, self edges, extra outputs', () => {
  const m = base();
  assert.equal(connectError(m, 'd', 'a'), 'cycle');
  assert.equal(connectError(m, 'a', 'a'), 'self');
  assert.equal(connectError(m, 'a', 'b'), 'duplicate');
  assert.equal(connectError(m, 'a', 'd'), 'single-out');
  assert.equal(connectError(m, 'b', 'a'), 'branches');
  assert.equal(connectError(m, 'zz', 'a'), 'unknown');
  const r = connect(m, 'd', 'a');
  assert.equal(r.error, 'cycle');
  assert.equal(r.m, m);
});

test('connect from condition auto-assigns the free branch label', () => {
  const m = base();
  m.edges = [{ from: 'a', to: 'b' }, { from: 'c', to: 'd' }];
  const r1 = connect(m, 'b', 'c');
  assert.equal(r1.m.edges.at(-1).label, 'yes');
  const r2 = connect(r1.m, 'b', 'd');
  assert.equal(r2.m.edges.at(-1).label, 'no');
  assert.equal(connect(r2.m, 'b', 'a').error, 'branches');
});

test('addNode generates ids, connects after the selected node and keeps the graph valid', () => {
  let m = newMethodology({});
  const r = addNode(m, 'checkpoint', { title: T, afterId: 'n1' });
  assert.equal(r.id, 'n2');
  assert.ok(r.connected);
  assert.deepEqual(validateMethodology(r.m), []);
  const r2 = addNode(r.m, 'command', { title: T });
  assert.equal(r2.id, 'n3');
  assert.equal(r2.connected, false);
  // an unconnected node makes a second start node: the shared validator reports it
  assert.ok(validateMethodology(r2.m).some((e) => e.includes('start node')));
  assert.ok(lint(r2.m).some((l) => l.code === 'multi-start'));
  // new node does not overlap existing ones
  const ps = r2.m.nodes.map((n) => `${n.x},${n.y}`);
  assert.equal(new Set(ps).size, ps.length);
});

test('removeNode drops edges and bridges a middle node', () => {
  const m = removeNode(base(), 'c');
  assert.ok(!m.nodes.some((n) => n.id === 'c'));
  assert.ok(!m.edges.some((e) => e.from === 'c' || e.to === 'c'));
  const lin = { ...base(), edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c', label: 'yes' }, { from: 'c', to: 'd' }] };
  const r = removeNode(lin, 'c');
  assert.deepEqual(r.edges.find((e) => e.to === 'd'), { from: 'b', to: 'd', label: 'yes' });
  const one = newMethodology({});
  assert.equal(removeNode(one, 'n1').nodes.length, 1);
});

test('removeEdge, setEdgeLabel', () => {
  const m = base();
  assert.equal(removeEdge(m, 0).edges.length, 3);
  assert.equal(setEdgeLabel(m, 1, 'no').error, 'branches');
  const r = setEdgeLabel(m, 3, '');
  assert.equal(r.error, null);
  assert.equal(setEdgeLabel(m, 1, '').m.edges[1].label, undefined);
});

test('setNodePos / clearLayout / updateNode keep the input immutable', () => {
  const m = base();
  const p = setNodePos(m, 'a', 10.4, 20.6);
  assert.deepEqual([p.nodes[0].x, p.nodes[0].y], [10, 21]);
  assert.equal(m.nodes[0].x, undefined);
  assert.equal(clearLayout(p).nodes[0].x, undefined);
  const u = updateNode(m, 'a', { text: 'new', agent: 'agy' });
  assert.equal(u.nodes[0].text, 'new');
  assert.equal(updateNode(u, 'a', { agent: undefined }).nodes[0].agent, undefined);
});

test('declareVars adds only valid undeclared keys; var ops', () => {
  const m = declareVars(base(), ['topic', 'extra', 'bad key']);
  assert.deepEqual(m.vars.map((v) => v.key), ['topic', 'extra']);
  const u = updateVar(m, 1, { type: 'select', options: ['a'] });
  assert.equal(u.vars[1].type, 'select');
  assert.equal(removeVar(u, 0).vars.length, 1);
  assert.equal(addVar(m, { key: 'z', type: 'text' }).vars.length, 3);
});

test('lint reports undeclared vars and missing branches', () => {
  const m = base();
  m.nodes[0].text = 'use {{nope}}';
  m.edges = m.edges.filter((e) => e.label !== 'no');
  m.edges.push({ from: 'c', to: 'd' });
  const l = lint(m);
  assert.ok(l.some((x) => x.code === 'undeclared-var' && x.key === 'nope'));
  assert.ok(l.some((x) => x.code === 'branch-missing' && x.label === 'no'));
});

test('history: commit, undo, redo, coalescing and limit', () => {
  let h = createHistory(base());
  const m1 = setNodePos(h.present, 'a', 1, 1);
  h = commit(h, m1);
  assert.ok(canUndo(h) && !canRedo(h));
  assert.equal(commit(h, m1), h, 'identical state is not committed');
  h = commit(h, updateNode(h.present, 'a', { text: 'h' }), 'k');
  h = commit(h, updateNode(h.present, 'a', { text: 'hi' }), 'k');
  h = commit(h, updateNode(h.present, 'a', { text: 'hii' }), 'k');
  assert.equal(h.past.length, 2, 'same key coalesces');
  h = undo(h);
  assert.equal(h.present.nodes[0].text, 'x {{topic}}');
  assert.ok(canRedo(h));
  h = redo(h);
  assert.equal(h.present.nodes[0].text, 'hii');
  h = undo(undo(undo(h)));
  assert.equal(h.present.nodes[0].x, undefined);
  assert.equal(undo(h), h);
  const s = createHistory(base(), 3);
  let q = s;
  for (let i = 0; i < 10; i += 1) q = commit(q, setNodePos(q.present, 'a', i, i));
  assert.equal(q.past.length, 3);
  q = commit(undo(q), setNodePos(q.present, 'a', 99, 99));
  assert.equal(canRedo(q), false);
});
