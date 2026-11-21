import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseTemplate, serializeTemplate, validateTemplate, createPrompts, commandBody, DEFAULT_DIR } from '../../src/main/prompts.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fs-prompts-'));

const sample = {
  id: 'my-prompt', source: 'user', name: { en: 'Mine', es: 'Mio' }, description: { en: 'Desc', es: 'Descripcion' },
  tags: ['a', 'b'], body: 'Do {{first}} then {{second}}.\n\nDone.',
  vars: [
    { key: 'first', type: 'text', label: { en: 'First', es: 'Primero' }, required: true },
    { key: 'second', type: 'select', label: { en: 'Second', es: 'Segundo' }, default: 'x', options: ['x', 'y'] },
  ],
};

test('frontmatter round trip', () => {
  const text = serializeTemplate(sample);
  const back = parseTemplate(text, 'user');
  assert.deepEqual(back, sample);
  assert.throws(() => parseTemplate('no frontmatter'));
});

test('all 10 bundled prompts parse with EN+ES names and valid vars', () => {
  const p = createPrompts({ userDir: tmp() });
  const list = p.list();
  assert.equal(list.length, 10);
  const ids = ['bug-fix', 'code-review', 'refactor', 'explain-code', 'write-tests', 'python-dashboard', 'project-readme', 'release-notes', 'security-review', 'data-analysis'];
  assert.deepEqual(list.map((t) => t.id).sort(), [...ids].sort());
  for (const t of list) {
    assert.equal(t.source, 'default');
    assert.ok(t.name.en && t.name.es && t.description.en && t.description.es, t.id);
    assert.ok(t.body.length > 200, t.id);
    validateTemplate(t); // same rules as user templates
    for (const v of t.vars) assert.ok(t.body.includes(`{{${v.key}}}`), `${t.id} uses ${v.key}`);
    for (const m of t.body.matchAll(/\{\{(\w+)\}\}/g)) assert.ok(t.vars.some((v) => v.key === m[1]), `${t.id} declares ${m[1]}`);
  }
  const ex = list.find((t) => t.id === 'explain-code');
  assert.deepEqual(ex.vars[1].options, ['beginner', 'intermediate', 'expert']);
  assert.ok(list.find((t) => t.id === 'data-analysis').body.includes('artifacts/report.md'));
  const raw = fs.readFileSync(path.join(DEFAULT_DIR, 'bug-fix.md'));
  assert.notEqual(raw[0], 0xef); // no BOM
});

test('save validates, user overrides default, delete is user-only', () => {
  const p = createPrompts({ userDir: tmp() });
  assert.throws(() => p.save({ ...sample, id: '../evil' }), /invalid id/);
  assert.throws(() => p.save({ ...sample, id: 'Bad' }));
  assert.throws(() => p.save({ ...sample, body: 'x'.repeat(30000) }), /too long/);
  assert.throws(() => p.save({ ...sample, vars: [{ key: 'k', type: 'select', label: { en: 'a', es: 'a' } }] }), /options/);
  assert.throws(() => p.save({ ...sample, vars: [{ key: 'K!', type: 'text', label: { en: 'a', es: 'a' } }] }));
  const saved = p.save(sample);
  assert.equal(saved.source, 'user');
  assert.equal(p.list().find((t) => t.id === 'my-prompt').source, 'user');
  const over = p.save({ ...sample, id: 'bug-fix', name: { en: 'Mine', es: 'Mio' } });
  assert.equal(p.list().find((t) => t.id === 'bug-fix').name.en, over.name.en);
  assert.equal(p.list().find((t) => t.id === 'bug-fix').source, 'user');
  p.delete('bug-fix');
  assert.equal(p.list().find((t) => t.id === 'bug-fix').source, 'default');
  assert.throws(() => p.delete('bug-fix'), /user templates/);
  p.delete('my-prompt');
  assert.equal(p.list().length, 10);
});

test('export writes command file, converts vars and keeps a .bak', () => {
  const root = tmp();
  const p = createPrompts({ userDir: tmp() });
  p.save(sample);
  assert.equal(commandBody(sample), 'Do $ARGUMENTS then <SECOND>.\n\nDone.');
  const r = p.export({ path: root }, 'my-prompt');
  assert.equal(r.path, '.claude/commands/my-prompt.md');
  const file = path.join(root, '.claude', 'commands', 'my-prompt.md');
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.startsWith('---\ndescription: Desc\n---'));
  assert.ok(text.includes('$ARGUMENTS') && text.includes('<SECOND>') && !text.includes('{{'));
  assert.ok(!fs.existsSync(`${file}.bak`));
  fs.writeFileSync(file, 'user edits', 'utf8');
  p.export({ path: root }, 'my-prompt');
  assert.equal(fs.readFileSync(`${file}.bak`, 'utf8'), 'user edits');
  assert.throws(() => p.export({ path: root }, 'nope-nope'), /Unknown/);
});
