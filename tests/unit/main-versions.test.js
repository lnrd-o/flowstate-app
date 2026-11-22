import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createGit, AUTO_BRANCH } from '../../src/main/git.js';
import { createVersions, slugify, parseDecorations, parseLog, attachPrompts } from '../../src/main/versions.js';

const v = createVersions();
const git = createGit();
const sh = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' }).trim();
const w = (d, f, t) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), t); };
const r = (d, f) => fs.readFileSync(path.join(d, f), 'utf8').replace(/\r\n/g, '\n');
function repo() {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fs-ver-')));
  sh(d, 'init', '-b', 'main');
  w(d, 'a.txt', 'one\n'); sh(d, 'add', '.'); sh(d, 'commit', '-m', 'first');
  return d;
}

test('pure helpers', () => {
  assert.equal(slugify('Mi Versión Útil!!'), 'mi-version-util');
  assert.equal(slugify('***'), 'version');
  assert.deepEqual(parseDecorations('HEAD -> main, tag: v1, origin/main, origin/HEAD'), { head: true, branches: ['main', 'origin/main'], tags: ['v1'] });
  const out = '\x1eabc1234abc\x1f\x1f1700000000\x1fHEAD -> main\x1fflowstate: hi\x1fFlowstate-Agent: claude\nFlowstate-Methodology: review\n\x1f\n3\t1\ta.txt\n-\t-\tb.png\n';
  const [c] = parseLog(out);
  assert.equal(c.files, 2); assert.equal(c.added, 3); assert.equal(c.removed, 1);
  assert.equal(c.agent, 'claude'); assert.equal(c.methodology, 'review'); assert.ok(c.auto && c.head);
  const [p] = attachPrompts([c], [{ t: 'user', ts: 1699999999000, text: 'hi' }]);
  assert.equal(p.prompt, 'hi');
});

test('autoCommit records agent + methodology trailers, timeline shows them', async () => {
  const d = repo();
  w(d, 'b.txt', 'x\n');
  assert.ok((await git.autoCommit(d, 'do it', { agent: 'claude', methodology: 'review' })).committed);
  assert.equal(sh(d, 'log', '-1', '--format=%s'), 'flowstate: do it');
  const l = await v.list(d);
  assert.equal(l.current, AUTO_BRANCH);
  const top = l.commits.find((c) => c.auto);
  assert.equal(top.agent, 'claude'); assert.equal(top.methodology, 'review'); assert.equal(top.files, 1);
  assert.ok(l.branches.some((b) => b.name === 'main'));
  assert.ok((await git.undoTurn(d)).ok); // undo still works with trailers
});

test('save version -> tag, listing, compare, restore file + project, undo', async () => {
  const d = repo();
  w(d, 'a.txt', 'two\n'); w(d, 'new.txt', 'n\n');
  const s = await v.save(d, { label: 'Draft one', note: 'before the big change' });
  assert.ok(s.ok, JSON.stringify(s));
  assert.equal(s.tag, 'checkpoint/draft-one');
  assert.equal((await v.save(d, { label: 'Draft one' })).tag, 'checkpoint/draft-one-2');
  assert.equal((await v.save(d, { label: '' })).ok, false);
  let l = await v.list(d);
  const tag = l.tags.find((t) => t.name === s.tag);
  assert.equal(tag.label, 'Draft one'); assert.equal(tag.note, 'before the big change'); assert.equal(tag.auto, false);

  w(d, 'a.txt', 'three\n'); w(d, 'extra.txt', 'e\n');
  const cmp = await v.compare(d, { from: 'checkpoint/draft-one' });
  assert.deepEqual(cmp.files.map((f) => [f.path, f.status]), [['a.txt', 'M'], ['extra.txt', 'A']]);
  const df = await v.compare(d, { from: 'checkpoint/draft-one', path: 'a.txt' });
  assert.match(df.diff, /\+three/);
  const two = await v.compare(d, { from: sh(d, 'rev-list', '--max-parents=0', 'HEAD'), to: 'checkpoint/draft-one' });
  assert.ok(two.files.some((f) => f.path === 'new.txt' && f.status === 'A'));
  assert.equal((await v.compare(d, { from: '--output=x' })).ok, false);
  assert.equal((await v.compare(d, { from: 'main', path: '../x' })).ok, false);

  const rf = await v.restore(d, { ref: 'checkpoint/draft-one', path: 'a.txt' });
  assert.ok(rf.ok, JSON.stringify(rf));
  assert.equal(r(d, 'a.txt'), 'two\n');
  assert.equal(r(d, 'extra.txt'), 'e\n');
  const first = sh(d, 'rev-list', '--max-parents=0', 'HEAD');
  const rp = await v.restore(d, { ref: first });
  assert.ok(rp.ok, JSON.stringify(rp));
  assert.equal(r(d, 'a.txt'), 'one\n');
  assert.ok(!fs.existsSync(path.join(d, 'new.txt')));
  assert.ok(!fs.existsSync(path.join(d, 'extra.txt')));
  assert.equal(sh(d, 'status', '--porcelain'), '');
  const undo = await v.restore(d, { ref: rp.safety });
  assert.ok(undo.ok);
  assert.equal(r(d, 'a.txt'), 'two\n');
  assert.equal(r(d, 'extra.txt'), 'e\n');
  assert.equal(r(d, 'new.txt'), 'n\n');
  l = await v.list(d);
  assert.ok(l.tags.some((t) => t.auto));
});

test('branch handler: create from version, dirty switch checkpoints, rename, delete merged only', async () => {
  const d = repo();
  assert.equal((await v.branch(d, { op: 'create', name: 'bad name' })).reason, 'invalid-name');
  assert.equal((await v.branch(d, { op: 'create', name: '-x' })).reason, 'invalid-name');
  assert.equal((await v.branch(d, { op: 'create', name: 'a..b' })).reason, 'invalid-name');
  const c = await v.branch(d, { op: 'create', name: 'idea', from: 'main' });
  assert.ok(c.ok, JSON.stringify(c));
  assert.equal(sh(d, 'branch', '--show-current'), 'idea');
  w(d, 'idea.txt', 'i\n'); w(d, 'a.txt', 'idea edit\n');
  const sw = await v.branch(d, { op: 'switch', name: 'main' });
  assert.ok(sw.ok, JSON.stringify(sw)); assert.ok(sw.safety);
  assert.equal(sh(d, 'branch', '--show-current'), 'main');
  assert.equal(r(d, 'a.txt'), 'one\n');
  assert.equal(sh(d, 'show', 'idea:a.txt'), 'idea edit');
  assert.equal((await v.branch(d, { op: 'delete', name: 'idea' })).reason, 'not-merged');
  assert.equal((await v.branch(d, { op: 'delete', name: 'main' })).reason, 'current');
  assert.ok((await v.branch(d, { op: 'rename', name: 'idea', to: 'idea-2' })).ok);
  const l = await v.list(d);
  const b = l.branches.find((x) => x.name === 'idea-2');
  assert.equal(b.ahead, 1); assert.equal(b.behind, 0); assert.equal(l.branches[0].name, 'main');
  const m = await v.branch(d, { op: 'merge', name: 'idea-2' });
  assert.ok(m.ok && m.merged, JSON.stringify(m));
  assert.equal(r(d, 'idea.txt'), 'i\n');
  assert.ok((await v.branch(d, { op: 'delete', name: 'idea-2' })).ok);
  assert.ok(!sh(d, 'branch').includes('idea-2'));
});

test('merge preview predicts conflicts; merge aborts cleanly and leaves the tree untouched', async () => {
  const d = repo();
  sh(d, 'checkout', '-b', 'other');
  w(d, 'a.txt', 'other side\n'); w(d, 'only-other.txt', 'o\n'); sh(d, 'add', '.'); sh(d, 'commit', '-m', 'other');
  sh(d, 'checkout', 'main');
  w(d, 'a.txt', 'main side\n'); sh(d, 'add', '.'); sh(d, 'commit', '-m', 'main change');
  const p = await v.branch(d, { op: 'previewMerge', name: 'other' });
  assert.ok(p.ok); assert.deepEqual(p.conflicts, ['a.txt']); assert.equal(p.upToDate, false);
  assert.ok(p.files.some((f) => f.path === 'only-other.txt'));
  w(d, 'wip.txt', 'work in progress\n');
  const head0 = sh(d, 'rev-parse', 'HEAD');
  const m = await v.branch(d, { op: 'merge', name: 'other' });
  assert.equal(m.ok, false); assert.equal(m.reason, 'conflict'); assert.deepEqual(m.conflicts, ['a.txt']);
  assert.ok(!fs.existsSync(path.join(d, '.git', 'MERGE_HEAD')));
  assert.equal(r(d, 'a.txt'), 'main side\n');
  assert.equal(r(d, 'wip.txt'), 'work in progress\n');
  assert.equal(sh(d, 'status', '--porcelain'), '');
  assert.notEqual(sh(d, 'rev-parse', 'HEAD'), head0);
  assert.equal((await v.branch(d, { op: 'previewMerge', name: 'main' })).reason, 'same');
  assert.equal((await v.branch(d, { op: 'merge', name: 'nope' })).reason, 'bad-ref');
});

test('not a repo is reported, not thrown', async () => {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fs-ver-')));
  assert.equal((await v.list(d)).isRepo, false);
  assert.equal((await v.save(d, { label: 'x' })).reason, 'not-repo');
});

test('save with ref tags an older commit without touching files', async () => {
  const d = repo();
  const first = sh(d, 'rev-parse', 'HEAD');
  w(d, 'a.txt', 'later\n'); sh(d, 'commit', '-am', 'later');
  w(d, 'dirty.txt', 'x');
  const s = await v.save(d, { label: 'Old one', ref: first });
  assert.ok(s.ok, JSON.stringify(s));
  assert.equal(sh(d, 'rev-parse', `${s.tag}^{commit}`), first);
  assert.equal(r(d, 'dirty.txt'), 'x');
  assert.equal((await v.save(d, { label: 'x', ref: '--bad' })).ok, false);
});
