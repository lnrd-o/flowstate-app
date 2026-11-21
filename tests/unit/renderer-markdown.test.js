import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  closeOpenFence, detectLanguage, classifyDiffLine, splitHighlightedLines, isSafeHref, isSafeClass, escapeHtml,
} from '../../src/renderer/lib/md-utils.js';
import { filterProjects } from '../../src/renderer/lib/store.js';
import { clampWidth } from '../../src/renderer/components/artifacts.js';

test('closeOpenFence closes only unfinished fences', () => {
  assert.equal(closeOpenFence('hello'), 'hello');
  assert.equal(closeOpenFence('```js\nlet a'), '```js\nlet a\n```');
  assert.equal(closeOpenFence('```js\nlet a\n'), '```js\nlet a\n```');
  assert.equal(closeOpenFence('```js\nx\n```\ntext'), '```js\nx\n```\ntext');
  assert.equal(closeOpenFence('~~~\nx'), '~~~\nx\n~~~');
  assert.equal(closeOpenFence('````md\n```\ninner\n```\n'), '````md\n```\ninner\n```\n````');
  assert.equal(closeOpenFence('use ```inline``` here'), 'use ```inline``` here');
  assert.equal(closeOpenFence('```js\nx\n```\n```py\ny'), '```js\nx\n```\n```py\ny\n```');
});

test('detectLanguage maps aliases and falls back to plaintext', () => {
  assert.deepEqual(detectLanguage('js'), { label: 'js', lang: 'javascript' });
  assert.equal(detectLanguage('ts title="a"').lang, 'typescript');
  assert.equal(detectLanguage('sh').lang, 'bash');
  assert.equal(detectLanguage('PS1').lang, 'powershell');
  assert.equal(detectLanguage('html').lang, 'xml');
  assert.equal(detectLanguage('patch').lang, 'diff');
  assert.equal(detectLanguage('c++').lang, 'cpp');
  assert.equal(detectLanguage('klingon').lang, 'plaintext');
  assert.deepEqual(detectLanguage(''), { label: 'text', lang: 'plaintext' });
  assert.deepEqual(detectLanguage(undefined), { label: 'text', lang: 'plaintext' });
});

test('classifyDiffLine', () => {
  assert.equal(classifyDiffLine('+added'), 'add');
  assert.equal(classifyDiffLine('-removed'), 'del');
  assert.equal(classifyDiffLine('+++ b/file'), 'ctx');
  assert.equal(classifyDiffLine('--- a/file'), 'ctx');
  assert.equal(classifyDiffLine('@@ -1,2 +1,2 @@'), 'hunk');
  assert.equal(classifyDiffLine(' context'), 'ctx');
  assert.equal(classifyDiffLine(''), 'ctx');
});

test('splitHighlightedLines keeps spans balanced per line', () => {
  const lines = splitHighlightedLines('<span class="a">one\ntwo</span>\nthree');
  assert.deepEqual(lines, [
    '<span class="a">one</span>',
    '<span class="a">two</span>',
    'three',
  ]);
  assert.deepEqual(splitHighlightedLines(''), ['']);
  assert.equal(splitHighlightedLines('a\n\nb').length, 3);
});

test('link and class allow-lists', () => {
  assert.ok(isSafeHref('https://nodejs.org/api'));
  assert.ok(isSafeHref('http://x.y'));
  assert.ok(isSafeHref('mailto:a@b.c'));
  assert.ok(!isSafeHref('javascript:alert(1)'));
  assert.ok(!isSafeHref(' JaVaScRiPt:alert(1)'));
  assert.ok(!isSafeHref('data:text/html,x'));
  assert.ok(!isSafeHref('file:///c:/x'));
  assert.ok(!isSafeHref('/relative'));
  assert.ok(isSafeClass('language-js'));
  assert.ok(isSafeClass('language-c++'));
  assert.ok(!isSafeClass('modal'));
  assert.ok(!isSafeClass('language-js modal'));
  assert.equal(escapeHtml('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
});

test('filterProjects and clampWidth', () => {
  const ps = [{ name: 'Alpha', path: 'C:\\x\\alpha' }, { name: 'Beta', path: 'C:\\y\\beta' }];
  assert.equal(filterProjects(ps, '').length, 2);
  assert.equal(filterProjects(ps, 'ALP').length, 1);
  assert.equal(filterProjects(ps, 'y\\b').length, 1);
  assert.equal(clampWidth(100, 280, 1400), 280);
  assert.equal(clampWidth(2000, 280, 1000), 600);
  assert.equal(clampWidth(420, 280, 1400), 420);
});
