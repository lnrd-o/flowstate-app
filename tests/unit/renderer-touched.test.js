import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isWriteTool, toolPath, relativeTo, isPreviewable, touchedPath, lastTouchedFile } from '../../src/renderer/lib/touched.js';
import { formatBytes, sortEntries, flattenTree, parentOf, baseName } from '../../src/renderer/lib/files.js';

const ROOT = 'C:\\Users\\leo\\Code\\proj';

test('write tool names are case-insensitive and include antigravity tools', () => {
  for (const n of ['Write', 'edit', 'MultiEdit', 'write_file', 'replace_file_content']) assert.equal(isWriteTool(n), true, n);
  for (const n of ['Read', 'Bash', 'Grep', '', undefined]) assert.equal(isWriteTool(n), false, String(n));
});

test('toolPath reads the common path keys', () => {
  assert.equal(toolPath({ file_path: 'a' }), 'a');
  assert.equal(toolPath({ TargetFile: 'b' }), 'b');
  assert.equal(toolPath({ command: 'x' }), null);
  assert.equal(toolPath(null), null);
});

test('relativeTo handles windows absolute, mixed slashes, case and outside paths', () => {
  assert.equal(relativeTo(ROOT, 'C:\\Users\\leo\\Code\\proj\\artifacts\\r.md'), 'artifacts/r.md');
  assert.equal(relativeTo(ROOT, 'c:/users/LEO/code/proj/src/a.js'), 'src/a.js');
  assert.equal(relativeTo(ROOT, 'C:\\Users\\leo\\Code\\other\\a.js'), null);
  assert.equal(relativeTo(ROOT, 'C:\\Users\\leo\\Code\\proj-evil\\a.js'), null);
  assert.equal(relativeTo(ROOT, './src/a.js'), 'src/a.js');
  assert.equal(relativeTo(ROOT, '../x.js'), null);
  assert.equal(relativeTo('/home/u/p', '/home/u/p/a/b.txt'), 'a/b.txt');
  assert.equal(relativeTo(ROOT, ''), null);
});

test('isPreviewable rejects opaque binaries only', () => {
  assert.equal(isPreviewable('a.md'), true);
  assert.equal(isPreviewable('Makefile'), true);
  assert.equal(isPreviewable('a.EXE'), false);
  assert.equal(isPreviewable('a.png'), true);
});

test('touchedPath ignores non-write tools', () => {
  assert.equal(touchedPath('Write', { file_path: ROOT + '\\a.md' }, ROOT), 'a.md');
  assert.equal(touchedPath('Read', { file_path: ROOT + '\\a.md' }, ROOT), null);
});

test('lastTouchedFile picks the newest successful previewable write', () => {
  const msgs = [
    { role: 'tool', name: 'Write', input: { file_path: ROOT + '\\one.md' }, status: 'done' },
    { role: 'user', text: 'x' },
    { role: 'tool', name: 'Edit', input: { file_path: ROOT + '\\two.js' }, status: 'done' },
    { role: 'tool', name: 'Write', input: { file_path: ROOT + '\\bad.md' }, status: 'error' },
    { role: 'tool', name: 'Write', input: { file_path: ROOT + '\\tool.exe' }, status: 'done' },
    { role: 'tool', name: 'Bash', input: { command: 'ls' }, status: 'done' },
  ];
  assert.equal(lastTouchedFile(msgs, ROOT), 'two.js');
  assert.equal(lastTouchedFile([], ROOT), null);
  assert.equal(lastTouchedFile(undefined, ROOT), null);
});

test('formatBytes', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(20 * 1024), '20 KB');
  assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MB');
  assert.equal(formatBytes(-1), '');
});

test('sortEntries pins artifacts first at the root, then folders, then files', () => {
  const e = (name, isDir) => ({ name, rel: name, isDir });
  const out = sortEntries([e('z.txt', false), e('src', true), e('artifacts', true), e('a.txt', false), e('Docs', true)]);
  assert.deepEqual(out.map((x) => x.name), ['artifacts', 'Docs', 'src', 'a.txt', 'z.txt']);
  assert.deepEqual(sortEntries([e('artifacts', true), e('b', true)], 'src').map((x) => x.name), ['artifacts', 'b']);
});

test('flattenTree shows children of expanded folders with depth', () => {
  const kids = new Map([
    ['', [{ name: 'src', rel: 'src', isDir: true }, { name: 'r.md', rel: 'r.md', isDir: false }]],
    ['src', [{ name: 'a.js', rel: 'src/a.js', isDir: false }]],
  ]);
  assert.deepEqual(flattenTree(kids, new Set()).map((r) => r.entry.rel), ['src', 'r.md']);
  const rows = flattenTree(kids, new Set(['src']));
  assert.deepEqual(rows.map((r) => [r.entry.rel, r.depth]), [['src', 1], ['src/a.js', 2], ['r.md', 1]]);
  assert.equal(parentOf('src/a.js'), 'src');
  assert.equal(parentOf('a.js'), '');
  assert.equal(baseName('src/a.js'), 'a.js');
});
