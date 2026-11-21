import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateMethodology, nextNodeId, evalCondition, substitute, extractVarKeys, undeclaredVars, layoutGraph, startNodes, hasCycle, pickText,
} from '../../src/shared/methodology.js';

const base = () => ({
  id: 'demo', version: 1, name: { en: 'Demo', es: 'Demo' },
  vars: [{ key: 'topic', type: 'text' }],
  nodes: [
    { id: 'a', type: 'ask-user', title: 'Ask', question: 'Topic?', saveAs: 'topic' },
    { id: 'b', type: 'prompt', title: 'Do it', text: 'Write about {{topic}} in {{projectName}}' },
    { id: 'c', type: 'condition', title: 'Big?', var: 'topic', equals: 'x' },
    { id: 'd', type: 'checkpoint', title: 'OK?', message: 'Review' },
    { id: 'e', type: 'git-commit', title: 'Commit', message: 'done' },
  ],
  edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'd', label: 'yes' }, { from: 'c', to: 'e', label: 'no' }, { from: 'd', to: 'e' }],
});

test('valid methodology passes', () => assert.deepEqual(validateMethodology(base()), []));

test('rejects bad id, version, unknown node type, duplicate ids, dangling edges', () => {
  const m = base(); m.id = 'Bad Id'; assert.ok(validateMethodology(m).some((e) => e.startsWith('id')));
  const v = base(); v.version = 2; assert.ok(validateMethodology(v).some((e) => e.includes('version')));
  const t = base(); t.nodes[1].type = 'rm-rf'; assert.ok(validateMethodology(t).some((e) => e.includes('unknown type')));
  const d = base(); d.nodes[1].id = 'a'; assert.ok(validateMethodology(d).some((e) => e.includes('duplicate node')));
  const g = base(); g.edges.push({ from: 'a', to: 'zzz' }); assert.ok(validateMethodology(g).some((e) => e.includes('unknown node')));
});

test('rejects cycles and multiple/zero start nodes', () => {
  const c = base(); c.edges.push({ from: 'e', to: 'a' });
  assert.ok(validateMethodology(c).some((e) => e.includes('cycle')));
  assert.equal(hasCycle(c.nodes, c.edges), true);
  const two = base(); two.edges = two.edges.filter((e) => !(e.from === 'a'));
  assert.ok(validateMethodology(two).some((e) => e.includes('exactly one start')));
  assert.equal(startNodes(base())[0].id, 'a');
});

test('command node needs exe + args array; limits enforced', () => {
  const m = base(); m.nodes[1] = { id: 'b', type: 'command', title: 'x', exe: 'git', args: 'status' };
  assert.ok(validateMethodology(m).some((e) => e.includes('command')));
  const big = base(); big.nodes[1].text = 'x'.repeat(30000);
  assert.ok(validateMethodology(big).some((e) => e.includes('prompt.text')));
});

test('navigation and conditions', () => {
  const m = base();
  assert.equal(nextNodeId(m, 'a'), 'b');
  assert.equal(nextNodeId(m, 'e'), null);
  assert.equal(evalCondition(m.nodes[2], { topic: 'x' }), 'yes');
  assert.equal(evalCondition(m.nodes[2], { topic: 'y' }), 'no');
  assert.equal(nextNodeId(m, 'c', 'yes'), 'd');
  assert.equal(nextNodeId(m, 'c', 'no'), 'e');
});

test('substitute / extract / undeclared', () => {
  assert.equal(substitute('Hi {{ name }} {{missing}}', { name: 'Ana' }), 'Hi Ana {{missing}}');
  assert.deepEqual(extractVarKeys('{{a}} {{b}} {{a}}'), ['a', 'b']);
  const m = base(); m.nodes[1].text += ' {{ghost}}';
  assert.deepEqual(undeclaredVars(m), ['ghost']); // topic declared, projectName builtin
});

test('layout places nodes by depth and honours manual x/y', () => {
  const m = base(); m.nodes[0].x = 5; m.nodes[0].y = 7;
  const p = layoutGraph(m);
  assert.deepEqual(p.a, { x: 5, y: 7 });
  assert.ok(p.b.x > 0 && p.c.x > p.b.x);
  assert.equal(pickText({ en: 'A', es: 'B' }, 'es'), 'B');
  assert.equal(pickText({ en: 'A' }, 'es'), 'A');
});
