import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProjects } from '../../src/main/projects.js';
import { createHistory } from '../../src/main/history.js';
import { createStore, normalizeState, parseProjectJson } from '../../src/main/svc/store.js';
import { createUi, mergePatch } from '../../src/main/svc/ui.js';
import { createMethodologies } from '../../src/main/methodologies.js';
import { GITIGNORE } from '../../src/main/svc/store-fs.js';

const tmp = () => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fs-ps-')));

/** One "machine": a userData dir + registry + history + store wired like main.js. */
function machine({ userData = tmp(), runner = null, dialog = null } = {}) {
  const projects = createProjects({ dir: userData });
  const history = createHistory({ dir: userData, storeDirOf: (id) => { const p = projects.get(id); return p ? path.join(p.path, '.flowstate') : null; } });
  const store = createStore({ projects, history, runner, dialog, debounceMs: 20 });
  return { userData, projects, history, store };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const readJ = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

test('store: write-through round trip into <project>/.flowstate (path with spaces), gitignore, atomic', async () => {
  const m = machine();
  const folder = path.join(tmp(), 'My Project (1)');
  const p = m.projects.add({ path: folder, name: 'Mine', agent: 'agy', mode: 'plan' });
  assert.equal(p.loadedFromFolder, undefined);
  m.projects.update(p.id, { model: 'gemini-3.8-flash-high', effort: 'high', sessionId: 'conv-1', developerMode: false, autoCommit: true });
  m.history.recordUser(p.id, 'hello');
  m.store.onAgentEvent(p.id, { type: 'result', ok: true }, { agent: 'agy' });
  m.store.onAgentEvent(p.id, { type: 'file-change', id: 'x', path: 'a.txt' });
  m.store.setUi(p.id, { draft: 'half typed', openFile: 'a.md' });
  await wait(120);
  const dir = path.join(p.path, '.flowstate');
  const pj = readJ(path.join(dir, 'project.json'));
  assert.deepEqual({ ...pj, createdAt: 0, updatedAt: 0 }, { version: 1, name: 'Mine', agent: 'agy', mode: 'plan', model: 'gemini-3.8-flash-high', effort: 'high', autoCommit: true, developerMode: false, createdAt: 0, updatedAt: 0 });
  assert.ok(pj.createdAt && pj.updatedAt);
  const st = readJ(path.join(dir, 'state.json'));
  assert.equal(st.version, 1);
  assert.deepEqual(st.sessions, { claude: null, agy: 'conv-1' });
  assert.deepEqual(st.counters, { turns: 1, filesChanged: 1 });
  assert.equal(st.lastTurn.ok, true); assert.equal(st.lastTurn.agent, 'agy');
  assert.deepEqual(st.ui, { draft: 'half typed', openFile: 'a.md' });
  assert.equal(st.lastRun, null);
  assert.equal(fs.readFileSync(path.join(dir, 'history.jsonl'), 'utf8').split('\n').filter(Boolean).length, 1);
  assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), GITIGNORE);
  assert.equal(GITIGNORE, 'state.json\nhistory.jsonl\nattachments/\n');
  assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith('.tmp')));
  const s = m.store.status(p.id);
  assert.equal(s.exists, true); assert.equal(s.hasProject, true); assert.equal(s.hasState, true); assert.equal(s.gitignored, true);
  assert.ok(s.historyBytes > 0); assert.equal(s.attachmentsBytes, 0); assert.ok(s.lastSavedAt > 0); assert.equal(s.dir, dir);
  // createdAt is stable across writes
  m.projects.update(p.id, { name: 'Renamed' });
  assert.deepEqual(m.store.save(p.id).files.sort(), ['history.jsonl', 'project.json', 'state.json']);
  const pj2 = readJ(path.join(dir, 'project.json'));
  assert.equal(pj2.createdAt, pj.createdAt); assert.equal(pj2.name, 'Renamed');
});

test('store: an agent switch alone does not copy the old session to the new agent; the new session is stored per agent', async () => {
  const m = machine();
  const p = m.projects.add({ path: path.join(tmp(), 'p'), agent: 'claude' });
  m.projects.update(p.id, { sessionId: 'c-1' });
  await wait(60);
  m.projects.update(p.id, { agent: 'agy', sessionId: null });
  await wait(60);
  m.projects.update(p.id, { sessionId: 'a-1' });
  await wait(60);
  assert.deepEqual(readJ(path.join(p.path, '.flowstate', 'state.json')).sessions, { claude: 'c-1', agy: 'a-1' });
});

test('auto-load: a FRESH registry (new machine) adopts project.json + state.json sessions + history', async () => {
  const a = machine();
  const folder = path.join(tmp(), 'shared proj');
  const p = a.projects.add({ path: folder, name: 'Shared', agent: 'agy', mode: 'acceptEdits' });
  a.projects.update(p.id, { model: 'opus', effort: 'max', sessionId: 'conv-9', autoCommit: true, developerMode: true });
  a.history.recordUser(p.id, 'earlier question');
  a.history.recordEvent(p.id, { type: 'text', text: 'earlier answer' });
  a.store.setUi(p.id, { artifactsTab: 'files' });
  a.store.save(p.id);
  // simulate a second machine: brand new userData, same folder
  const b = machine();
  assert.equal(b.projects.list().length, 0);
  const opened = await b.store.openPath(folder);
  assert.equal(opened.created, false);
  assert.deepEqual(opened.loaded, { projectJson: true, state: true, history: true });
  const q = opened.project;
  assert.equal(q.loadedFromFolder, true);
  assert.notEqual(q.id, p.id);
  assert.deepEqual([q.name, q.agent, q.mode, q.model, q.effort, q.autoCommit, q.developerMode, q.sessionId], ['Shared', 'agy', 'acceptEdits', 'opus', 'max', true, true, 'conv-9']);
  assert.equal(b.history.get(q.id).length, 2);
  assert.deepEqual(b.store.getUi(q.id), { artifactsTab: 'files' });
  // the registry only stores the index entry, and the flag is never persisted
  assert.equal(b.projects.get(q.id).loadedFromFolder, undefined);
  // registered again (same path) -> existing entry, nothing re-loaded
  const again = await b.store.openPath(folder);
  assert.equal(again.project.id, q.id); assert.deepEqual(again.loaded, { projectJson: false, state: false, history: false }); assert.equal(again.created, false);
  // the claude session slot survives an agent switch on the new machine
  assert.equal(readJ(path.join(folder, '.flowstate', 'state.json')).sessions.agy, 'conv-9');
});

test('auto-load: only project.json (the committed part) -> settings load, no session / history; fresh folder -> created', async () => {
  const folder = path.join(tmp(), 'cloned');
  fs.mkdirSync(path.join(folder, '.flowstate'), { recursive: true });
  fs.writeFileSync(path.join(folder, '.flowstate', 'project.json'), JSON.stringify({ version: 1, name: 'From Git', agent: 'claude', mode: 'plan', model: 'sonnet', effort: 'low', autoCommit: false, developerMode: null, bogus: 1 }));
  const m = machine();
  const r = await m.store.openPath(folder);
  assert.deepEqual(r.loaded, { projectJson: true, state: false, history: false });
  assert.equal(r.project.name, 'From Git'); assert.equal(r.project.model, 'sonnet'); assert.equal(r.project.sessionId, null); assert.equal(r.project.developerMode, null);
  const fresh = await m.store.openPath(path.join(tmp(), 'brand new'));
  assert.equal(fresh.created, true); assert.deepEqual(fresh.loaded, { projectJson: false, state: false, history: false });
  assert.equal(fresh.project.loadedFromFolder, undefined);
  await wait(80);
  assert.ok(fs.existsSync(path.join(fresh.project.path, '.flowstate', 'project.json')), 'a new project gets its project.json');
});

test('corrupt project.json / state.json are renamed *.corrupt-<ts> and ignored (never crash); invalid values are dropped', async () => {
  const folder = path.join(tmp(), 'broken');
  const dir = path.join(folder, '.flowstate');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'project.json'), '{ not json');
  fs.writeFileSync(path.join(dir, 'state.json'), '[1,2,3]');
  const m = machine();
  const r = await m.store.openPath(folder);
  assert.equal(r.project.loadedFromFolder, undefined);
  assert.equal(r.project.name, 'broken');
  const names = fs.readdirSync(dir);
  assert.ok(names.some((n) => /^project\.json\.corrupt-\d+$/.test(n)));
  assert.ok(names.some((n) => /^state\.json\.corrupt-\d+$/.test(n)));
  await wait(80);
  assert.ok(readJ(path.join(dir, 'project.json')).version === 1, 'a fresh project.json replaces the corrupt one');
  assert.deepEqual(parseProjectJson({ name: '  ', agent: 'gpt', mode: 'x', model: 'bad model', effort: 'ultra', autoCommit: 'yes', developerMode: 3 }), {});
  assert.deepEqual(normalizeState({ sessions: { claude: 5, agy: 'x' }, counters: { turns: -1 }, ui: [] }).sessions, { claude: null, agy: 'x' });
  assert.equal(parseProjectJson(null), null);
});

test('history migration: the old userData file moves into the folder once; the folder copy wins when both exist', () => {
  const userData = tmp();
  const folder = path.join(tmp(), 'mig proj');
  fs.mkdirSync(folder, { recursive: true });
  const projects = createProjects({ dir: userData });
  const p = projects.add({ path: folder });
  fs.mkdirSync(path.join(userData, 'history'), { recursive: true });
  const legacy = path.join(userData, 'history', `${p.id}.jsonl`);
  fs.writeFileSync(legacy, `${JSON.stringify({ ts: 1, t: 'user', text: 'old' })}\n`);
  const h = createHistory({ dir: userData, storeDirOf: (id) => (id === p.id ? path.join(folder, '.flowstate') : null) });
  assert.equal(h.get(p.id)[0].text, 'old', 'readable before anything is written');
  h.recordUser(p.id, 'new');
  assert.ok(!fs.existsSync(legacy), 'legacy file moved');
  const f = path.join(folder, '.flowstate', 'history.jsonl');
  assert.deepEqual(h.get(p.id).map((r) => r.text), ['old', 'new']);
  assert.ok(fs.existsSync(f));
  // both exist -> the folder wins, the legacy one is left alone
  fs.writeFileSync(legacy, `${JSON.stringify({ ts: 1, t: 'user', text: 'stale' })}\n`);
  const h2 = createHistory({ dir: userData, storeDirOf: () => path.join(folder, '.flowstate') });
  assert.deepEqual(h2.get(p.id).map((r) => r.text), ['old', 'new']);
  assert.ok(fs.existsSync(legacy));
  // forget() removes only the userData copy
  h2.forget(p.id);
  assert.ok(!fs.existsSync(legacy)); assert.ok(fs.existsSync(f));
});

test('history falls back to the userData copy when the folder is not writable; keeps cap/rotation', () => {
  const userData = tmp();
  const blocker = path.join(tmp(), 'iam-a-file');
  fs.writeFileSync(blocker, 'x'); // <blocker>/.flowstate cannot be created
  const h = createHistory({ dir: userData, storeDirOf: () => path.join(blocker, '.flowstate') });
  h.recordUser('p-1', 'still works');
  assert.ok(fs.existsSync(path.join(userData, 'history', 'p-1.jsonl')));
  assert.equal(h.get('p-1')[0].text, 'still works');
  const folder = tmp();
  const h2 = createHistory({ dir: userData, storeDirOf: () => path.join(folder, '.flowstate') });
  const big = 'x'.repeat(10000);
  for (let i = 0; i < 300; i++) h2.recordEvent('p-2', { type: 'tool-result', id: String(i), output: big });
  const f = path.join(folder, '.flowstate', 'history.jsonl');
  assert.ok(fs.statSync(f).size > 2 * 1024 * 1024);
  const after = h2.get('p-2');
  assert.ok(fs.statSync(f).size <= 2 * 1024 * 1024); assert.equal(after.at(-1).event.id, '299');
  const diff = 'd'.repeat(300 * 1024);
  h2.recordEvent('p-2', { type: 'file-change', id: 'z', path: 'a', diff });
  assert.ok(h2.get('p-2').at(-1).event.diff.length < 201 * 1024);
});

test('clear: history truncates only history; all removes exactly <project>/.flowstate and nothing else; the registry entry stays', async () => {
  const m = machine();
  const folder = path.join(tmp(), 'clr proj');
  const p = m.projects.add({ path: folder });
  fs.writeFileSync(path.join(folder, 'keep.txt'), 'precious');
  m.history.recordUser(p.id, 'a');
  m.store.save(p.id);
  const dir = path.join(folder, '.flowstate');
  fs.mkdirSync(path.join(dir, 'attachments'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'attachments', 'x.png'), 'x');
  m.store.clear(p.id, 'history');
  assert.deepEqual(m.history.get(p.id), []);
  assert.ok(fs.existsSync(path.join(dir, 'project.json')));
  m.store.clear(p.id, 'all');
  assert.ok(!fs.existsSync(dir));
  assert.equal(fs.readFileSync(path.join(folder, 'keep.txt'), 'utf8'), 'precious');
  assert.ok(m.projects.get(p.id));
  await wait(80);
  assert.ok(!fs.existsSync(dir), 'a pending debounced write must not resurrect it');
  m.store.clear(p.id, 'all'); // nothing there: no throw
  assert.throws(() => m.store.clear(p.id, 'everything'), /invalid scope/);
  assert.throws(() => m.store.clear('nope', 'all'), /Unknown project/);
});

test('clear all refuses a .flowstate that is a link out of the project (never follows symlinks)', () => {
  const m = machine();
  const folder = path.join(tmp(), 'lnk proj');
  const p = m.projects.add({ path: folder });
  const outside = tmp();
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'do not delete');
  try { fs.symlinkSync(outside, path.join(folder, '.flowstate'), 'junction'); } catch { return; /* cannot create links here */ }
  assert.throws(() => m.store.clear(p.id, 'all'), /refusing/);
  assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'do not delete');
  // a link INSIDE a real .flowstate is removed as a link, its target survives
  fs.rmSync(path.join(folder, '.flowstate'), { recursive: false, force: true });
  fs.mkdirSync(path.join(folder, '.flowstate'));
  try { fs.symlinkSync(outside, path.join(folder, '.flowstate', 'attachments'), 'junction'); } catch { return; }
  m.store.clear(p.id, 'all');
  assert.ok(!fs.existsSync(path.join(folder, '.flowstate')));
  assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'do not delete');
});

test('store: lastRun comes from runner.state, openFolder uses the dialog, removed project drops pending writes, deleted folder is not resurrected', async () => {
  const folder = path.join(tmp(), 'run proj');
  const runner = { state: (id) => ({ runId: 'r1', projectId: id, status: 'done' }) };
  const target = path.join(tmp(), 'picked');
  const m = machine({ runner, dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [target] }) } });
  const opened = await m.store.openFolder();
  assert.equal(opened.created, true);
  const p = m.projects.add({ path: folder });
  m.store.save(p.id);
  assert.equal(readJ(path.join(folder, '.flowstate', 'state.json')).lastRun.runId, 'r1');
  const cancelled = machine({ dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) } });
  assert.equal(await cancelled.store.openFolder(), null);
  m.projects.update(p.id, { name: 'x' });
  m.projects.remove(p.id);
  fs.rmSync(folder, { recursive: true, force: true });
  await wait(80);
  assert.ok(!fs.existsSync(folder), 'removed project / deleted folder is not recreated');
  assert.doesNotThrow(() => m.store.flushDirty());
});

test('ui service: shallow merge, null deletes, 16 KB cap per patch, debounced atomic persistence, project state via the store', async () => {
  assert.deepEqual(mergePatch({ a: 1, b: 2 }, { b: null, c: 3 }), { a: 1, c: 3 });
  assert.throws(() => mergePatch({}, { big: 'x'.repeat(17 * 1024) }), /too large/);
  assert.throws(() => mergePatch({}, [1]), /object/);
  const userData = tmp();
  const m = machine({ userData });
  const p = m.projects.add({ path: path.join(tmp(), 'ui proj') });
  const services = { store: m.store };
  const ui = createUi({ dir: userData, services, debounceMs: 20 });
  ui.set({ sidebar: 'open', panel: { w: 300 } });
  ui.set({ sidebar: 'closed' });
  assert.deepEqual(ui.get(), { sidebar: 'closed', panel: { w: 300 } });
  await wait(80);
  assert.deepEqual(readJ(path.join(userData, 'ui-state.json')), { sidebar: 'closed', panel: { w: 300 } });
  assert.ok(!fs.readdirSync(userData).some((f) => f.endsWith('.tmp')));
  assert.deepEqual(createUi({ dir: userData, services }).get(), { sidebar: 'closed', panel: { w: 300 } });
  ui.projectSet(p.id, { draft: 'abc', tab: 'files' });
  ui.projectSet(p.id, { draft: null });
  assert.deepEqual(ui.projectGet(p.id), { tab: 'files' });
  await wait(80);
  assert.deepEqual(readJ(path.join(p.path, '.flowstate', 'state.json')).ui, { tab: 'files' });
  assert.throws(() => ui.projectSet(p.id, { big: 'x'.repeat(17 * 1024) }), /too large/);
  assert.throws(() => createUi({ dir: userData, services: {} }).projectGet(p.id), /service not available/);
});

test('methodologies: project-local .flowstate/methodologies are listed with source project; invalid files are skipped', () => {
  const userDir = tmp(); const folder = tmp(); const bundled = tmp();
  const dir = path.join(folder, '.flowstate', 'methodologies');
  fs.mkdirSync(dir, { recursive: true });
  const mdir = path.join(process.cwd(), 'methodologies');
  const real = JSON.parse(fs.readFileSync(path.join(mdir, fs.readdirSync(mdir).find((f) => f.endsWith('.json'))), 'utf8'));
  fs.writeFileSync(path.join(dir, `${real.id}.json`), JSON.stringify(real));
  fs.writeFileSync(path.join(dir, 'broken.json'), '{nope');
  fs.writeFileSync(path.join(dir, 'invalid.json'), JSON.stringify({ id: 'invalid' }));
  fs.writeFileSync(path.join(dir, 'mismatch.json'), JSON.stringify(real)); // id does not match the file name
  const getProject = (id) => (id === 'p1' ? { id, path: folder } : null);
  const m = createMethodologies({ userDir, bundledDir: bundled, dialog: {}, getProject });
  assert.deepEqual(m.list('p1').map((x) => [x.id, x.source]), [[real.id, 'project']]);
  assert.equal(m.get(real.id, 'p1').source, 'project');
  assert.deepEqual(m.list(), []); // not visible without a project
  assert.throws(() => m.get(real.id), /Unknown methodology/);
  assert.deepEqual(m.list('unknown-project'), []);
});
