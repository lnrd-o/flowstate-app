import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unifiedDiff } from '../../src/main/diff.js';

const L = (...a) => `${a.join('\n')}\n`;

/** Apply a unified diff (produced by unifiedDiff) to oldText -> new text (LF, trailing newline preserved by marker). */
function apply(oldText, diff) {
  const old = oldText === '' ? [] : oldText.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  const out = [];
  let pos = 0; // 0-based index into old
  const lines = diff.split('\n');
  let i = 0;
  while (i < lines.length) {
    const m = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(lines[i]);
    assert.ok(m, `bad header: ${lines[i]}`);
    const start = Number(m[2]) === 0 ? Number(m[1]) : Number(m[1]) - 1;
    while (pos < start) out.push(old[pos++]);
    i++;
    while (i < lines.length && !lines[i].startsWith('@@')) {
      const l = lines[i++];
      if (l.startsWith('\\')) continue;
      if (l[0] === ' ') { assert.equal(old[pos], l.slice(1)); out.push(old[pos++]); } else if (l[0] === '-') { assert.equal(old[pos], l.slice(1)); pos++; } else out.push(l.slice(1));
    }
  }
  while (pos < old.length) out.push(old[pos++]);
  return out;
}

test('identical text -> empty diff', () => {
  assert.deepEqual(unifiedDiff('a\nb\n', 'a\nb\n'), { diff: '', added: 0, removed: 0, truncated: false });
  assert.deepEqual(unifiedDiff('', ''), { diff: '', added: 0, removed: 0, truncated: false });
});

test('add lines at the end', () => {
  const r = unifiedDiff(L('a', 'b'), L('a', 'b', 'c', 'd'));
  assert.equal(r.added, 2); assert.equal(r.removed, 0);
  assert.equal(r.diff, '@@ -1,2 +1,4 @@\n a\n b\n+c\n+d');
});

test('remove lines', () => {
  const r = unifiedDiff(L('a', 'b', 'c'), L('a'));
  assert.equal(r.added, 0); assert.equal(r.removed, 2);
  assert.equal(r.diff, '@@ -1,3 +1,1 @@\n a\n-b\n-c');
});

test('replace in the middle with 3 lines of context', () => {
  const old = L(...Array.from({ length: 20 }, (_, i) => `l${i + 1}`));
  const nw = old.replace('l10\n', 'TEN\n');
  const r = unifiedDiff(old, nw);
  assert.equal(r.added, 1); assert.equal(r.removed, 1);
  assert.equal(r.diff, '@@ -7,7 +7,7 @@\n l7\n l8\n l9\n-l10\n+TEN\n l11\n l12\n l13');
});

test('create from empty and delete to empty', () => {
  const c = unifiedDiff('', L('a', 'b'));
  assert.equal(c.diff, '@@ -0,0 +1,2 @@\n+a\n+b');
  assert.equal(c.added, 2); assert.equal(c.removed, 0);
  const d = unifiedDiff(L('a', 'b'), '');
  assert.equal(d.diff, '@@ -1,2 +0,0 @@\n-a\n-b');
  assert.equal(d.removed, 2);
});

test('trailing newline differences are reported', () => {
  const r = unifiedDiff('a\nb', 'a\nb\n');
  assert.equal(r.added, 1); assert.equal(r.removed, 1);
  assert.match(r.diff, /-b\n\\ No newline at end of file\n\+b/);
});

test('CRLF vs LF compare equal and the output has no CR', () => {
  assert.equal(unifiedDiff('a\r\nb\r\n', 'a\nb\n').diff, '');
  const r = unifiedDiff('a\r\nb\r\n', 'a\r\nB\r\n');
  assert.ok(!r.diff.includes('\r'));
  assert.equal(r.diff, '@@ -1,2 +1,2 @@\n a\n-b\n+B');
});

test('nearby hunks merge, distant ones stay separate', () => {
  const base = Array.from({ length: 40 }, (_, i) => `l${i + 1}`);
  const mod = (idx) => { const c = [...base]; for (const i of idx) c[i] = `X${i}`; return L(...c); };
  const near = unifiedDiff(L(...base), mod([5, 11])); // gap of 5 lines <= 6
  assert.equal(near.diff.split('\n').filter((l) => l.startsWith('@@')).length, 1);
  const far = unifiedDiff(L(...base), mod([5, 30]));
  assert.equal(far.diff.split('\n').filter((l) => l.startsWith('@@')).length, 2);
  assert.equal(far.added, 2); assert.equal(far.removed, 2);
});

test('context option', () => {
  const old = L('a', 'b', 'c', 'd', 'e');
  assert.equal(unifiedDiff(old, L('a', 'b', 'C', 'd', 'e'), { context: 1 }).diff, '@@ -2,3 +2,3 @@\n b\n-c\n+C\n d');
});

test('property: applying the diff to old yields new (random edits)', () => {
  let seed = 12345;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let t = 0; t < 200; t++) {
    const a = Array.from({ length: rnd(30) }, () => `v${rnd(6)}`);
    const b = [...a];
    for (let e = rnd(6); e > 0; e--) {
      const op = rnd(3); const i = rnd(b.length + 1);
      if (op === 0) b.splice(i, 0, `n${rnd(9)}`); else if (op === 1) b.splice(i, 1); else if (b.length) b[i % b.length] = `m${rnd(9)}`;
    }
    const oldT = a.length ? L(...a) : ''; const newT = b.length ? L(...b) : '';
    const r = unifiedDiff(oldT, newT);
    if (oldT === newT) { assert.equal(r.diff, ''); continue; }
    assert.deepEqual(apply(oldT, r.diff), b, `case ${t}`);
    const plus = r.diff.split('\n').filter((l) => l.startsWith('+')).length;
    const minus = r.diff.split('\n').filter((l) => l.startsWith('-')).length;
    assert.equal(plus, r.added); assert.equal(minus, r.removed);
  }
});

test('large file guard falls back to a coarse replace diff', () => {
  const big = L(...Array.from({ length: 6000 }, (_, i) => `line ${i}`));
  const r = unifiedDiff(big, `${big}extra\n`, { maxLines: 100 });
  assert.equal(r.truncated, true);
  assert.equal(r.removed, 6000); assert.equal(r.added, 6001);
  assert.ok(r.diff.split('\n').length <= 101);
  const huge = `${'x'.repeat(1024 * 1024 + 1)}\n`;
  assert.equal(unifiedDiff(huge, 'y\n').truncated, true);
});

test('maxLines truncates normal diffs', () => {
  const r = unifiedDiff('', L(...Array.from({ length: 50 }, (_, i) => `n${i}`)), { maxLines: 10 });
  assert.equal(r.truncated, true);
  assert.equal(r.diff.split('\n').length, 10);
  assert.equal(r.added, 50);
});
