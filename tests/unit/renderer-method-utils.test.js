import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterMethods, nodeSummary, formatDuration, runSteps, countStates, isActiveRun, validateRunVars, runDefaults, duplicateOf, NODE_META, NODE_TYPES } from '../../src/renderer/lib/method-utils.js';

const list = [
  { id: 'a', source: 'bundled', name: { en: 'Data dashboard', es: 'Dashboard de datos' }, description: { en: 'Build it' }, tags: ['python'] },
  { id: 'b', source: 'user', name: { en: 'Audit', es: 'Auditor\u00eda' }, description: { en: 'Security' }, tags: ['security'] },
];

test('filterMethods searches name, description, tags, source in both languages', () => {
  assert.equal(filterMethods(list, '', 'en').length, 2);
  assert.deepEqual(filterMethods(list, 'python', 'en').map((m) => m.id), ['a']);
  assert.deepEqual(filterMethods(list, 'auditor\u00eda', 'es').map((m) => m.id), ['b']);
  assert.deepEqual(filterMethods(list, 'user', 'en').map((m) => m.id), ['b']);
  assert.deepEqual(filterMethods(list, 'data build', 'en').map((m) => m.id), ['a']);
  assert.equal(filterMethods(list, 'zzz', 'en').length, 0);
});

test('every node type has meta; nodeSummary per type', () => {
  for (const t of NODE_TYPES) assert.ok(NODE_META[t].icon && NODE_META[t].tone, t);
  assert.equal(nodeSummary({ type: 'command', exe: 'git', args: ['status', '-s'] }), 'git status -s');
  assert.equal(nodeSummary({ type: 'condition', var: 'x', equals: 'y' }), 'x = y');
  assert.equal(nodeSummary({ type: 'artifact', path: 'a.md' }), 'a.md');
  assert.equal(nodeSummary({ type: 'prompt' }), '');
});

test('formatDuration', () => {
  assert.equal(formatDuration(300), '<1 s');
  assert.equal(formatDuration(4200), '4 s');
  assert.equal(formatDuration(185000), '3 min 05 s');
  assert.equal(formatDuration(3720000), '1 h 02 min');
  assert.equal(formatDuration(undefined), '');
});

test('runSteps orders started nodes; countStates; isActiveRun', () => {
  const st = { status: 'waiting', nodes: { b: { state: 'waiting', startedAt: 20 }, a: { state: 'done', startedAt: 10, endedAt: 15 }, c: { state: 'pending' } } };
  const steps = runSteps(st);
  assert.deepEqual(steps.map((s) => s.id), ['a', 'b']);
  assert.equal(steps[0].durationMs, 5);
  assert.deepEqual(countStates(st), { waiting: 1, done: 1, pending: 1 });
  assert.ok(isActiveRun(st));
  assert.ok(!isActiveRun({ status: 'done' }));
  assert.deepEqual(runSteps(null), []);
});

test('run variables: defaults and required validation', () => {
  const vars = [{ key: 'p', type: 'path', required: true }, { key: 's', type: 'select', options: ['x', 'y'] }, { key: 't', type: 'text', default: 'hi' }];
  assert.deepEqual(runDefaults(vars), { p: '', s: 'x', t: 'hi' });
  assert.deepEqual(validateRunVars(vars, { p: '  ' }).errors, { p: 'required' });
  assert.ok(validateRunVars(vars, { p: 'C:\\x' }).ok);
});

test('duplicateOf makes an independent user copy', () => {
  const m = { id: 'a', source: 'bundled', name: { en: 'A', es: 'Aa' }, nodes: [{ id: 'n1' }] };
  const c = duplicateOf(m, 'a-copy', { en: '(copy)', es: '(copia)' });
  assert.equal(c.source, 'user');
  assert.equal(c.name.es, 'Aa (copia)');
  c.nodes[0].id = 'z';
  assert.equal(m.nodes[0].id, 'n1');
});
