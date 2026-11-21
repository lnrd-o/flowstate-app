import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createGit, isSecretPath, commitMessage } from '../../src/main/git.js';

const git = createGit();
const sh = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
const tmp = () => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fs-git-')));

test('secret patterns and commit message', () => {
  for (const f of ['.env', '.env.local', 'a/b/server.pem', 'x.pfx', 'k.key', 'id_rsa', 'id_rsa.pub']) assert.ok(isSecretPath(f), f);
  for (const f of ['app.js', 'environment.md', 'monkey.txt']) assert.ok(!isSecretPath(f), f);
  assert.equal(commitMessage('x'.repeat(100)), `flowstate: ${'x'.repeat(60)}`);
  assert.equal(commitMessage('a\nb'), 'flowstate: a b');
});

test('autoCommit: not a repo -> skipped; init; branch; secrets skipped; clean skipped; undo', async () => {
  const d = tmp();
  assert.equal((await git.autoCommit(d, 'p')).reason, 'not-repo');
  assert.deepEqual(await git.status(d), { isRepo: false, branch: null, dirty: 0 });
  assert.ok((await git.init(d)).ok);

  fs.writeFileSync(path.join(d, 'a.txt'), 'one');
  fs.writeFileSync(path.join(d, '.env'), 'SECRET=1');
  fs.writeFileSync(path.join(d, 'cert.pem'), 'x');
  const r = await git.autoCommit(d, 'first turn');
  assert.equal(r.committed, true, JSON.stringify(r));
  assert.equal(sh(d, 'rev-parse', '--abbrev-ref', 'HEAD'), 'claude/auto');
  assert.equal(sh(d, 'log', '-1', '--format=%s'), 'flowstate: first turn');
  const tracked = sh(d, 'ls-files').split(/\r?\n/);
  assert.deepEqual(tracked, ['a.txt']);
  assert.equal(sh(d, 'rev-list', '--count', 'HEAD'), '2'); // initial snapshot + turn

  // only secrets dirty -> nothing committed
  assert.equal((await git.autoCommit(d, 'again')).committed, false);
  assert.equal((await git.status(d)).branch, 'claude/auto');

  fs.writeFileSync(path.join(d, 'a.txt'), 'two');
  assert.equal((await git.autoCommit(d, 'second')).committed, true);
  assert.equal(sh(d, 'show', 'HEAD:a.txt'), 'two');

  const u = await git.undoTurn(d);
  assert.ok(u.ok, u.message);
  assert.equal(fs.readFileSync(path.join(d, 'a.txt'), 'utf8'), 'one');
  assert.ok(fs.existsSync(path.join(d, '.env'))); // untracked secrets untouched
});

test('undoTurn refuses when last commit is not a flowstate commit', async () => {
  const d = tmp();
  await git.init(d);
  fs.writeFileSync(path.join(d, 'a.txt'), '1');
  sh(d, 'add', '.');
  sh(d, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'human commit');
  fs.writeFileSync(path.join(d, 'a.txt'), '2');
  sh(d, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-am', 'second human');
  const u = await git.undoTurn(d);
  assert.equal(u.ok, false);
  assert.equal(fs.readFileSync(path.join(d, 'a.txt'), 'utf8'), '2');
});
