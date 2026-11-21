import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveInside, classify, createFiles } from '../../src/main/files.js';

const tmp = () => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fs-files-')));

test('resolveInside accepts normal paths and rejects traversal/absolute/UNC/ADS', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'a'));
  fs.writeFileSync(path.join(root, 'a', 'f.txt'), 'x');
  assert.equal(resolveInside(root, '').abs, root);
  assert.equal(resolveInside(root, 'a/f.txt').rel, 'a/f.txt');
  assert.equal(resolveInside(root, 'a\\f.txt').rel, 'a/f.txt');
  assert.equal(resolveInside(root, 'not/yet.txt').rel, 'not/yet.txt');
  for (const bad of ['..', '../x', 'a/../../x', 'a\\..\\..\\x', '/etc/passwd', 'C:\\Windows', 'C:/x', '\\\\server\\share\\x', '//server/x',
    'a/f.txt:stream', 'a/f.txt::$DATA', '... ', 'a/.. /x', 'bad\0name']) {
    assert.throws(() => resolveInside(root, bad), undefined, JSON.stringify(bad));
  }
  assert.throws(() => resolveInside(root, 5));
});

test('resolveInside rejects symlinks escaping the project', (t) => {
  const root = tmp();
  const outside = tmp();
  fs.writeFileSync(path.join(outside, 'secret.txt'), 's');
  try { fs.symlinkSync(outside, path.join(root, 'link'), 'junction'); } catch { t.skip('cannot create junction'); return; }
  assert.throws(() => resolveInside(root, 'link'), /escapes/);
  assert.throws(() => resolveInside(root, 'link/secret.txt'), /escapes/);
  assert.throws(() => resolveInside(root, 'link/new.txt'), /escapes/);
});

test('classify kinds', () => {
  assert.equal(classify('README.md').kind, 'markdown');
  assert.equal(classify('a/b.HTML').kind, 'html');
  assert.deepEqual(classify('x.svg'), { kind: 'image', mime: 'image/svg+xml' });
  assert.equal(classify('x.PNG').mime, 'image/png');
  assert.deepEqual(classify('s.py'), { kind: 'text', lang: 'python' });
  assert.equal(classify('app.js').kind, 'text');
  assert.equal(classify('Dockerfile').lang, 'dockerfile');
  assert.equal(classify('x.exe').kind, 'binary');
  assert.equal(classify('noext').kind, 'binary');
});

function setup() {
  const root = tmp();
  const f = createFiles({ getProject: (id) => (id === 'p' ? { id: 'p', path: root } : null), shell: {} });
  return { root, f };
}

test('list ignores heavy folders, sorts dirs first, caps entries', () => {
  const { root, f } = setup();
  for (const d of ['.git', 'node_modules', '.venv', '__pycache__', 'zdir', 'adir']) fs.mkdirSync(path.join(root, d));
  fs.writeFileSync(path.join(root, 'b.txt'), 'bb');
  fs.writeFileSync(path.join(root, 'a.txt'), 'a');
  fs.writeFileSync(path.join(root, 'adir', 'in.md'), '# hi');
  const names = f.list('p').map((e) => e.name);
  assert.deepEqual(names, ['adir', 'zdir', 'a.txt', 'b.txt']);
  const sub = f.list('p', 'adir');
  assert.equal(sub[0].rel, 'adir/in.md');
  assert.equal(sub[0].size, 4);
  assert.throws(() => f.list('p', '..'));
  assert.throws(() => f.list('nope'), /Unknown project/);
  fs.mkdirSync(path.join(root, 'many'));
  for (let i = 0; i < 2100; i++) fs.writeFileSync(path.join(root, 'many', `f${i}.txt`), '');
  assert.equal(f.list('p', 'many').length, 2000);
});

test('read: text, truncation, binary, image', () => {
  const { root, f } = setup();
  fs.writeFileSync(path.join(root, 'a.py'), 'print(1)\n');
  fs.writeFileSync(path.join(root, 'big.txt'), 'x'.repeat(1024 * 1024 + 10));
  fs.writeFileSync(path.join(root, 'nul.txt'), Buffer.from([65, 0, 66]));
  fs.writeFileSync(path.join(root, 'p.svg'), '<svg/>');
  fs.writeFileSync(path.join(root, 'r.md'), '# t');
  fs.writeFileSync(path.join(root, 'prog.exe'), 'MZ');
  const a = f.read('p', 'a.py');
  assert.deepEqual([a.kind, a.lang, a.content, a.truncated], ['text', 'python', 'print(1)\n', false]);
  const big = f.read('p', 'big.txt');
  assert.equal(big.truncated, true);
  assert.equal(big.content.length, 1024 * 1024);
  assert.equal(f.read('p', 'nul.txt').kind, 'binary');
  assert.equal(f.read('p', 'nul.txt').content, undefined);
  const s = f.read('p', 'p.svg');
  assert.equal(s.kind, 'image');
  assert.ok(s.dataUrl.startsWith('data:image/svg+xml;base64,'));
  assert.equal(f.read('p', 'r.md').kind, 'markdown');
  assert.deepEqual(f.read('p', 'prog.exe'), { kind: 'binary', size: 2, truncated: false });
  assert.throws(() => f.read('p', 'a'), /ENOENT|Not a file/);
});

test('open refuses executables, reveal/open stay inside the project', async () => {
  const root = tmp();
  const calls = [];
  const f = createFiles({
    getProject: () => ({ id: 'p', path: root }),
    shell: { openPath: async (p) => { calls.push(['open', p]); return ''; }, showItemInFolder: (p) => calls.push(['reveal', p]) },
  });
  for (const n of ['x.exe', 'x.BAT', 'x.cmd', 'x.ps1', 'x.lnk', 'x.vbs', 'x.msi', 'x.jar']) {
    fs.writeFileSync(path.join(root, n), '');
    await assert.rejects(f.open('p', n), /not allowed/);
  }
  fs.writeFileSync(path.join(root, 'ok.html'), '<p>');
  await f.open('p', 'ok.html');
  await f.reveal('p', 'ok.html');
  assert.deepEqual(calls.map((c) => c[0]), ['open', 'reveal']);
  await assert.rejects(f.open('p', '../x.html'));
  await assert.rejects(f.reveal('p', 'C:\\Windows\\notepad.exe'));
});

test('watch: debounced rel paths, ignores heavy dirs, switching closes previous', async () => {
  const root = tmp();
  const handlers = [];
  const closed = [];
  const fakeFs = {
    ...fs,
    watch(dir, opts, cb) { handlers.push(cb); return { close: () => closed.push(dir), on() {} }; },
  };
  const events = [];
  const f = createFiles({ getProject: (id) => ({ id, path: root }), shell: {}, fsx: fakeFs, push: (e) => events.push(e), debounceMs: 20 });
  f.watch('p1');
  f.watch('p1');
  assert.equal(handlers.length, 1);
  handlers[0]('change', 'src\\a.js');
  handlers[0]('change', 'src\\a.js');
  handlers[0]('rename', 'node_modules\\x\\y.js');
  handlers[0]('rename', '.git\\index');
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(events, [{ projectId: 'p1', changed: ['src/a.js'] }]);
  f.watch('p2');
  assert.equal(closed.length, 1);
  f.closeWatcher('p1'); // different project: no-op
  assert.equal(closed.length, 1);
  f.closeWatcher();
  assert.equal(closed.length, 2);
});
