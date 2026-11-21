import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMethodologies, BUNDLED_DIR } from '../../src/main/methodologies.js';
import { createRecorder, templatize, summarizeTools, MAX_TURNS } from '../../src/main/recorder.js';
import { validateMethodology, undeclaredVars } from '../../src/shared/methodology.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fs-meth-'));
const mk = (id = 'my-flow', extra = {}) => ({
  id, version: 1, name: { en: 'My flow', es: 'Mi flujo' }, vars: [],
  nodes: [{ id: 'a', type: 'prompt', title: 'A', text: 'hi' }, { id: 'b', type: 'checkpoint', title: 'B', message: 'ok?' }],
  edges: [{ from: 'a', to: 'b' }], ...extra,
});

test('bundled methodologies all validate, declare every var, and load via the store', () => {
  const files = fs.readdirSync(BUNDLED_DIR).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 5);
  for (const f of files) {
    const raw = fs.readFileSync(path.join(BUNDLED_DIR, f));
    assert.notEqual(raw[0], 0xef, `${f} has a BOM`);
    const m = JSON.parse(raw.toString('utf8'));
    assert.deepEqual(validateMethodology(m), [], f);
    assert.deepEqual(undeclaredVars(m), [], f);
    assert.equal(`${m.id}.json`, f);
    assert.ok(m.name.en && m.name.es && m.description.en && m.description.es, f);
    for (const n of m.nodes) assert.ok(n.title.en && n.title.es, `${f}:${n.id}`);
  }
  const store = createMethodologies({ userDir: tmp() });
  const ids = store.list().map((s) => s.id);
  for (const id of ['new-python-dashboard', 'bugfix-flow', 'project-bootstrap', 'code-review-report', 'data-analysis-report']) assert.ok(ids.includes(id), id);
  assert.ok(store.list().every((s) => s.source === 'bundled' && s.nodeCount > 0));
});

test('store: save/list/override/delete/invalid/path safety', () => {
  const userDir = tmp();
  const bundled = tmp();
  fs.writeFileSync(path.join(bundled, 'my-flow.json'), JSON.stringify({ ...mk('my-flow'), source: 'bundled' }));
  const store = createMethodologies({ userDir, bundledDir: bundled, now: () => '2026-01-01T00:00:00.000Z' });
  assert.equal(store.list()[0].source, 'bundled');
  const saved = store.save({ ...mk('my-flow'), source: 'bundled', name: { en: 'Mine' } });
  assert.equal(saved.source, 'user');
  assert.equal(saved.updatedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(saved.createdAt, '2026-01-01T00:00:00.000Z');
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].source, 'user'); // override
  assert.equal(store.get('my-flow').name.en, 'Mine');
  assert.ok(fs.existsSync(path.join(userDir, 'methodologies', 'my-flow.json')));
  assert.equal(store.save(mk('other', { createdAt: 'x' })).createdAt, 'x');
  store.delete('my-flow');
  assert.equal(store.get('my-flow').source, 'bundled'); // override removed reveals bundled
  assert.throws(() => store.delete('my-flow'), /Bundled/);
  assert.throws(() => store.delete('nope-id'), /Unknown/);
  assert.throws(() => store.save(mk('bad', { nodes: [] })), /Invalid methodology.*nodes/);
  assert.throws(() => store.save(mk('../evil')), /Invalid methodology.*id/);
  for (const bad of ['../x', 'a/b', 'A', '', 'x\\y', 'a'.repeat(70), null, 5]) {
    assert.throws(() => store.get(bad), /invalid methodology id/, String(bad));
    assert.throws(() => store.delete(bad), /invalid methodology id/);
  }
  assert.deepEqual(fs.readdirSync(userDir).sort(), ['methodologies']);
});

test('store: import (collision suffix, validation, size, cancel) and export', async () => {
  const userDir = tmp();
  const work = tmp();
  let open = { canceled: true };
  let save = { canceled: true };
  const dialog = { showOpenDialog: async () => open, showSaveDialog: async (_w, o) => { assert.equal(o.defaultPath, 'my-flow.json'); return save; } };
  const store = createMethodologies({ userDir, bundledDir: tmp(), dialog, now: () => 'T' });
  assert.equal(await store.import(), null);
  const f = path.join(work, 'in.json');
  fs.writeFileSync(f, JSON.stringify({ ...mk('my-flow'), source: 'bundled', createdAt: 'old' }));
  open = { canceled: false, filePaths: [f] };
  const d1 = await store.import();
  assert.equal(d1.id, 'my-flow');
  assert.equal(d1.source, 'user');
  assert.equal(d1.createdAt, 'T');
  assert.equal(store.list().length, 0); // not saved
  store.save(d1);
  assert.equal((await store.import()).id, 'my-flow-2');
  store.save({ ...mk('my-flow-2') });
  assert.equal((await store.import()).id, 'my-flow-3');
  fs.writeFileSync(f, '{nope');
  await assert.rejects(store.import(), /valid JSON/);
  fs.writeFileSync(f, JSON.stringify(mk('x', { nodes: [] })));
  await assert.rejects(store.import(), /Invalid methodology/);
  fs.writeFileSync(f, ' '.repeat(1024 * 1024 + 5));
  await assert.rejects(store.import(), /too large/);
  // export
  assert.equal(await store.export('my-flow'), null);
  const out = path.join(work, 'out.json');
  save = { canceled: false, filePath: out };
  assert.deepEqual(await store.export('my-flow'), { path: out });
  const txt = fs.readFileSync(out, 'utf8');
  assert.ok(txt.includes('\n  "id"'));
  assert.equal(JSON.parse(txt).id, 'my-flow');
});

// ---- recorder ----
const project = { id: 'p1', name: 'Acme Tool', path: 'C:\\Users\\me\\Code\\acme-tool' };
const U = (ts, text) => ({ ts, t: 'user', text });
const E = (ts, event) => ({ ts, t: 'event', event });
const rec = (recs, gitLog) => createRecorder({ history: { get: () => recs }, getProject: (id) => (id === 'p1' ? project : null), gitLog, now: () => 'NOW' });

test('recorder: templating, tools summary, commit node, vars, validity', async () => {
  const recs = [
    U(1000, 'Fix the bug in acme tool at C:\\Users\\me\\Code\\acme-tool\\src and use {{ticket}}'),
    E(1100, { type: 'tool-use', id: '1', name: 'Edit', input: { file_path: 'C:\\Users\\me\\Code\\acme-tool\\src\\a.py' } }),
    E(1200, { type: 'tool-use', id: '2', name: 'Edit', input: { file_path: 'C:\\Users\\me\\Code\\acme-tool\\src\\a.py' } }),
    E(1300, { type: 'tool-use', id: '3', name: 'Bash', input: { command: 'pytest' } }),
    E(1400, { type: 'tool-use', id: '4', name: 'Write', input: { file_path: 'D:\\elsewhere\\secret.txt' } }),
    E(1500, { type: 'result', ok: true }),
    U(5000, 'Now add docs'),
    E(5100, { type: 'result', ok: true }),
  ];
  const log = async () => [{ ts: 3000, subject: 'flowstate: Fix the bug' }, { ts: 100, subject: 'initial' }, { ts: 6000, subject: 'someone: else' }];
  const m = await rec(recs, log).record('p1', {});
  assert.deepEqual(validateMethodology(m), []);
  assert.equal(m.source, 'recorded');
  assert.deepEqual(m.tags, ['recorded']);
  assert.deepEqual(m.name, { en: 'Recorded workflow', es: 'Flujo grabado' });
  assert.deepEqual(m.nodes.map((n) => [n.id, n.type]), [['n1', 'prompt'], ['n2', 'git-commit'], ['n3', 'prompt']]);
  assert.equal(m.nodes[0].text, 'Fix the bug in {{projectName}} at {{projectPath}}\\src and use {{ticket}}');
  assert.equal(m.nodes[0].note, 'Tools: Edit x2, Bash x1, Write x1. Files: src/a.py');
  assert.equal(m.nodes[1].message, 'Fix the bug');
  assert.ok(m.nodes.every((n) => n.x === undefined && n.y === undefined));
  assert.deepEqual(m.edges, [{ from: 'n1', to: 'n2' }, { from: 'n2', to: 'n3' }]);
  assert.deepEqual(m.vars.map((v) => [v.key, v.type]), [['ticket', 'text']]);
  assert.deepEqual(undeclaredVars(m), []);
  assert.equal((await rec(recs, log).record('p1', { name: 'Custom' })).name.en, 'Custom');
  // no git log (throws) => no commit nodes
  const m2 = await rec(recs, async () => { throw new Error('no git'); }).record('p1', {});
  assert.deepEqual(m2.nodes.map((n) => n.type), ['prompt', 'prompt']);
  // range filter
  const m3 = await rec(recs, log).record('p1', { fromTs: 4000 });
  assert.deepEqual(m3.nodes.map((n) => n.text), ['Now add docs']);
});

test('recorder: nothing to record, unknown project, 60-turn cap, helpers', async () => {
  await assert.rejects(rec([E(1, { type: 'result', ok: true })], async () => []).record('p1', {}), /Nothing to record/);
  await assert.rejects(rec([], async () => []).record('p1', {}), /Nothing to record/);
  await assert.rejects(rec([], async () => []).record('zz', {}), /Unknown project/);
  const many = Array.from({ length: 75 }, (_, i) => U(i + 1, `step ${i}`));
  const m = await rec(many, async () => []).record('p1', {});
  assert.equal(MAX_TURNS, 60);
  assert.equal(m.nodes.length, 60);
  assert.equal(m.nodes[0].text, 'step 15');
  assert.equal(m.nodes.at(-1).text, 'step 74');
  assert.deepEqual(validateMethodology(m), []);
  assert.equal(templatize('ACME TOOL / acme tool', project), '{{projectName}} / {{projectName}}');
  assert.equal(templatize('c:/users/me/code/acme-tool/x', project), '{{projectPath}}/x');
  assert.equal(templatize('ab', { name: 'ab', path: 'C:\\x' }), 'ab'); // too short a name is not replaced
  const long = summarizeTools(Array.from({ length: 80 }, (_, i) => ({ type: 'tool-use', name: `Tool${i}_run`, input: {} })), 'C:\\x');
  assert.ok(long.length <= 500);
  const files = summarizeTools(Array.from({ length: 9 }, (_, i) => ({ type: 'tool-use', name: 'write_file', input: { path: `f${i}.txt` } })), 'C:\\x');
  assert.equal(files.split('Files: ')[1].split(', ').length, 5);
});
