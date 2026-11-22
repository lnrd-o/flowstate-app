import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChangeTracker, MAX_TURN_BYTES } from '../../src/main/changes.js';
import { createAgentManager } from '../../src/main/agents/manager.js';
import { createHistory } from '../../src/main/history.js';

const root = path.resolve('/proj');
const project = { id: 'p1', path: root };
const P = (...s) => path.join(root, ...s);

/** Fake fs: files Map<abs, string|Buffer>; dirs implied. realpath maps via `aliases` and fails for missing paths. */
function fakeFs(files = new Map(), aliases = {}) {
  const known = (p) => p === root || [...files.keys()].some((k) => k.startsWith(p + path.sep) || k === p) || Object.values(aliases).includes(p);
  return {
    files,
    readFile: (p) => { if (!files.has(p)) throw Object.assign(new Error('nf'), { code: 'ENOENT' }); return files.get(p); },
    realpath: (p) => {
      for (const [from, to] of Object.entries(aliases)) if (p === from || p.startsWith(from + path.sep)) return to + p.slice(from.length);
      if (!known(p)) throw Object.assign(new Error('nf'), { code: 'ENOENT' });
      return p;
    },
  };
}
const use = (id, name, kind, input) => ({ type: 'tool-use', id, name, kind, input });
const res = (id, extra = {}) => ({ type: 'tool-result', id, ...extra });

test('create: agy write_file with Path only', () => {
  const f = fakeFs();
  const t = createChangeTracker({ ...f, gitShowHead: () => null });
  assert.deepEqual(t.observe(project, use('c:1', 'write_file', 'write', { Path: P('hello.py') })), []);
  f.files.set(P('hello.py'), 'print(1)\nprint(2)\n');
  const out = t.observe(project, res('c:1'));
  assert.equal(out.length, 1);
  assert.deepEqual({ ...out[0], diff: undefined }, { type: 'file-change', id: 'c:1', path: 'hello.py', op: 'create', added: 2, removed: 0, diff: undefined, truncated: false });
  assert.equal(out[0].diff, '@@ -0,0 +1,2 @@\n+print(1)\n+print(2)');
});

test('modify: agy edit_file; nested relative path uses forward slashes', () => {
  const f = fakeFs(new Map([[P('src', 'a.js'), 'x\ny\nz\n']]));
  const t = createChangeTracker({ ...f });
  t.observe(project, use('e1', 'edit_file', 'edit', { Path: P('src', 'a.js') }));
  f.files.set(P('src', 'a.js'), 'x\nY\nz\n');
  const [c] = t.observe(project, res('e1'));
  assert.equal(c.op, 'modify'); assert.equal(c.path, 'src/a.js');
  assert.equal(c.added, 1); assert.equal(c.removed, 1);
  assert.match(c.diff, /-y\n\+Y/);
});

test('claude Edit/Write inputs (file_path, absolute and relative)', () => {
  const f = fakeFs(new Map([[P('a.txt'), '1\n']]));
  const t = createChangeTracker({ ...f });
  t.observe(project, use('t1', 'Edit', 'edit', { file_path: 'a.txt', old_string: '1', new_string: '2' }));
  t.observe(project, use('t2', 'Write', 'write', { file_path: P('b.txt'), content: 'hi' }));
  f.files.set(P('a.txt'), '2\n'); f.files.set(P('b.txt'), 'hi\n');
  assert.equal(t.observe(project, res('t1'))[0].op, 'modify');
  assert.equal(t.observe(project, res('t2'))[0].op, 'create');
});

test('delete', () => {
  const f = fakeFs(new Map([[P('gone.txt'), 'a\nb\n']]));
  const t = createChangeTracker({ ...f });
  t.observe(project, use('d1', 'edit_file', 'edit', { Path: P('gone.txt') }));
  f.files.delete(P('gone.txt'));
  const [c] = t.observe(project, res('d1'));
  assert.equal(c.op, 'delete'); assert.equal(c.removed, 2); assert.equal(c.added, 0);
});

test('no-op: unchanged file (no git fallback result) and missing-both emit nothing', () => {
  const f = fakeFs(new Map([[P('same.txt'), 'a\n']]));
  const t = createChangeTracker({ ...f, gitShowHead: () => null });
  t.observe(project, use('n1', 'edit_file', 'edit', { Path: P('same.txt') }));
  assert.deepEqual(t.observe(project, res('n1')), []);
  t.observe(project, use('n2', 'edit_file', 'edit', { Path: P('nothere.txt') }));
  assert.deepEqual(t.observe(project, res('n2')), []);
});

test('non edit/write tools and unknown result ids are ignored', () => {
  const f = fakeFs(new Map([[P('a.txt'), '1\n']]));
  const t = createChangeTracker({ ...f });
  t.observe(project, use('r1', 'view_file', 'read', { Path: P('a.txt') }));
  f.files.set(P('a.txt'), '2\n');
  assert.deepEqual(t.observe(project, res('r1')), []);
  assert.deepEqual(t.observe(project, res('zzz')), []);
});

test('paths outside the project are ignored (absolute, ..)', () => {
  const outside = path.resolve('/other/x.txt');
  const f = fakeFs(new Map([[outside, 'a\n'], [P('in.txt'), 'a\n']]));
  const t = createChangeTracker({ ...f });
  t.observe(project, use('o1', 'edit_file', 'edit', { Path: outside }));
  t.observe(project, use('o2', 'edit_file', 'edit', { Path: '../other/x.txt' }));
  f.files.set(outside, 'b\n');
  assert.deepEqual(t.observe(project, res('o1')), []);
  assert.deepEqual(t.observe(project, res('o2')), []);
});

test('8.3 short project path resolves via realpath', () => {
  const longRoot = path.resolve('/Users/Long Name/proj'); const shortRoot = path.resolve('/Users/LONGNA~1/proj');
  const files = new Map([[path.join(longRoot, 'f.txt'), 'a\n']]);
  const f = fakeFs(files, { [shortRoot]: longRoot });
  const t = createChangeTracker({ readFile: f.readFile, realpath: (p) => (p === longRoot || p.startsWith(longRoot + path.sep) ? p : f.realpath(p)) });
  const proj = { id: 'p8', path: longRoot };
  t.observe(proj, use('s1', 'edit_file', 'edit', { Path: path.join(shortRoot, 'f.txt') })); // agent reports the 8.3 form
  files.set(path.join(longRoot, 'f.txt'), 'b\n');
  const [c] = t.observe(proj, res('s1'));
  assert.equal(c.path, 'f.txt'); assert.equal(c.op, 'modify');
});

test('multi-path tool call -> several events with #n ids', () => {
  const f = fakeFs(new Map([[P('a.txt'), '1\n'], [P('b.txt'), '1\n']]));
  const t = createChangeTracker({ ...f });
  t.observe(project, use('m1', 'edit_file', 'edit', { Path: P('a.txt'), TargetFile: P('b.txt') }));
  f.files.set(P('a.txt'), '2\n'); f.files.set(P('b.txt'), '3\n');
  const out = t.observe(project, res('m1'));
  assert.deepEqual(out.map((e) => [e.id, e.path]), [['m1', 'a.txt'], ['m1#2', 'b.txt']]);
});

test('binary (NUL) and big files are skipped', () => {
  const f = fakeFs(new Map([[P('b.bin'), Buffer.from([1, 0, 2])], [P('big.txt'), 'x'.repeat(1024 * 1024 + 5)]]));
  const t = createChangeTracker({ ...f });
  t.observe(project, use('x1', 'edit_file', 'edit', { Path: P('b.bin') }));
  t.observe(project, use('x2', 'edit_file', 'edit', { Path: P('big.txt') }));
  f.files.set(P('b.bin'), Buffer.from([1, 0, 3])); f.files.set(P('big.txt'), 'small\n');
  assert.deepEqual(t.observe(project, res('x1')), []);
  assert.deepEqual(t.observe(project, res('x2')), []);
});

test('race: before === after falls back to git HEAD', () => {
  const f = fakeFs(new Map([[P('r.txt'), 'new\n']]));
  const calls = [];
  const t = createChangeTracker({ ...f, gitShowHead: (cwd, rel) => { calls.push([cwd, rel]); return 'old\n'; } });
  t.observe(project, use('g1', 'edit_file', 'edit', { Path: P('r.txt') })); // tool already finished: snapshot == final
  const [c] = t.observe(project, res('g1'));
  assert.deepEqual(calls, [[root, 'r.txt']]);
  assert.equal(c.op, 'modify'); assert.match(c.diff, /-old\n\+new/);
  // untracked -> null -> nothing; errored tool result -> no fallback
  const t2 = createChangeTracker({ ...f, gitShowHead: () => null });
  t2.observe(project, use('g2', 'edit_file', 'edit', { Path: P('r.txt') }));
  assert.deepEqual(t2.observe(project, res('g2')), []);
  const t3 = createChangeTracker({ ...f, gitShowHead: () => 'old\n' });
  t3.observe(project, use('g3', 'edit_file', 'edit', { Path: P('r.txt') }));
  assert.deepEqual(t3.observe(project, res('g3', { isError: true })), []);
});

test('snapshot cap per turn and release at turn end', () => {
  const chunk = 'x'.repeat(1024 * 1024 - 10);
  const files = new Map();
  const t = createChangeTracker({ ...fakeFs(files) });
  const n = Math.ceil(MAX_TURN_BYTES / chunk.length) + 2;
  for (let i = 0; i < n; i++) files.set(P(`f${i}.txt`), chunk);
  for (let i = 0; i < n; i++) t.observe(project, use(`k${i}`, 'edit_file', 'edit', { Path: P(`f${i}.txt`) }));
  for (let i = 0; i < n; i++) files.set(P(`f${i}.txt`), 'changed\n');
  const emitted = Array.from({ length: n }, (_, i) => t.observe(project, res(`k${i}`)).length).reduce((a, b) => a + b, 0);
  assert.ok(emitted > 0 && emitted < n, `emitted ${emitted} of ${n}`);
  // turn end drops snapshots
  t.observe(project, use('z1', 'edit_file', 'edit', { Path: P('f0.txt') }));
  t.observe(project, { type: 'result', ok: true });
  files.set(P('f0.txt'), 'again\n');
  assert.deepEqual(t.observe(project, res('z1')), []);
});

test('never throws on garbage', () => {
  const t = createChangeTracker({ readFile: () => { throw new Error('boom'); }, realpath: () => { throw new Error('boom'); } });
  for (const ev of [null, 1, {}, { type: 'tool-use' }, use('a', 'edit', 'edit', null), res('a')]) assert.deepEqual(t.observe(project, ev), []);
  assert.deepEqual(t.observe(null, use('a', 'edit', 'edit', { path: 'x' })), []);
});

// ---- manager integration with the fake agent ----
const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'fake-agent.js');
for (const style of ['claude', 'agy']) {
  test(`manager integration (${style}): tool-use, tool-result, file-change, result; history records them`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-chg-'));
    const proj = path.join(dir, 'proj'); fs.mkdirSync(proj);
    const hist = createHistory({ dir });
    const store = { pc: { id: 'pc', path: proj, agent: style, mode: 'acceptEdits', sessionId: null, autoCommit: false } };
    const events = [];
    const mgr = createAgentManager({
      projects: { get: (id) => ({ ...store[id] }), update: () => {} },
      resolveLauncher: async () => ({ command: process.execPath, baseArgs: [fake, '--style', style] }),
      emit: (id, e) => { hist.recordEvent(id, e); events.push(e); },
      history: { recordUser: () => {} },
    });
    process.env.FAKE_EDIT = '1';
    const wait = () => new Promise((res2) => { const iv = setInterval(() => { if (!mgr.status('pc').running) { clearInterval(iv); res2(); } }, 20); });
    try {
      await mgr.send({ projectId: 'pc', text: 'go' }); await wait();
      const seq = events.map((e) => e.type).filter((x) => ['tool-use', 'tool-result', 'file-change', 'result'].includes(x));
      assert.deepEqual(seq, ['tool-use', 'tool-result', 'tool-use', 'tool-result', 'file-change', 'result']);
      const fc = events.find((e) => e.type === 'file-change');
      assert.equal(fc.path, 'fake-edit.txt'); assert.equal(fc.op, 'create'); assert.equal(fc.added, 3);
      const i = events.indexOf(fc);
      assert.equal(events[i - 1].type, 'tool-result'); assert.equal(events[i + 1].type, 'result');

      events.length = 0;
      await mgr.send({ projectId: 'pc', text: 'again' }); await wait();
      const fc2 = events.find((e) => e.type === 'file-change');
      assert.equal(fc2.op, 'modify'); assert.match(fc2.diff, /-two\n\+TWO/);

      const recs = hist.get('pc').filter((r) => r.t === 'event' && r.event.type === 'file-change');
      assert.equal(recs.length, 2);
      assert.equal(recs[1].event.path, 'fake-edit.txt');
    } finally { delete process.env.FAKE_EDIT; mgr.stopAll(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

test('history caps stored file-change diffs at 200 KB', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-chg-h-'));
  try {
    const h = createHistory({ dir });
    h.recordEvent('pc', { type: 'file-change', id: 'a', path: 'x', op: 'create', added: 1, removed: 0, diff: 'x'.repeat(500 * 1024), truncated: false });
    h.recordEvent('pc', { type: 'thinking', id: 't', durationMs: 5, tokens: 3 });
    const recs = h.get('pc');
    assert.ok(recs[0].event.diff.length < 201 * 1024); assert.equal(recs[0].event.truncated, true);
    assert.equal(recs[1].event.type, 'thinking');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
