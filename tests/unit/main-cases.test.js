import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BUNDLED_DIR } from '../../src/main/methodologies.js';
import { validateMethodology, undeclaredVars, CASE_CATEGORIES } from '../../src/shared/methodology.js';

const ICONS = ['table', 'file-text', 'globe', 'chart', 'search', 'edit', 'zap', 'folder'];
const cases = fs.readdirSync(BUNDLED_DIR).filter((f) => f.endsWith('.json'))
  .map((f) => ({ f, raw: fs.readFileSync(path.join(BUNDLED_DIR, f)) }))
  .map(({ f, raw }) => ({ f, raw, m: JSON.parse(raw.toString('utf8')) }))
  .filter((c) => c.m.meta?.kind === 'case');

test('bundled cases: at least 10, unique ids, category coverage', () => {
  assert.ok(cases.length >= 10);
  assert.equal(new Set(cases.map((c) => c.m.id)).size, cases.length);
  const cats = new Set(cases.map((c) => c.m.meta.category));
  for (const c of ['excel', 'web', 'data', 'dashboard', 'research', 'document', 'automation']) assert.ok(cats.has(c), c);
});

test('bundled cases: valid, bilingual, safe prompts', () => {
  for (const { f, raw, m } of cases) {
    assert.notEqual(raw[0], 0xef, `${f} BOM`);
    assert.deepEqual(validateMethodology(m), [], f);
    assert.deepEqual(undeclaredVars(m), [], f);
    assert.equal(`${m.id}.json`, f);
    assert.ok(CASE_CATEGORIES.includes(m.meta.category), f);
    assert.ok(ICONS.includes(m.meta.icon), f);
    assert.ok(m.tags.includes('case'), f);
    assert.ok(m.name.en && m.name.es && m.description.en && m.description.es, f);
    assert.ok(m.nodes.length <= 6, f);
    for (const n of m.nodes) assert.ok(n.title.en && n.title.es, `${f}:${n.id}`);
    for (const v of m.vars) {
      assert.ok(v.label?.en && v.label?.es, `${f}:${v.key}`);
      if (v.type === 'select') assert.ok(v.options.includes(v.default), `${f}:${v.key} default`);
    }
    const prompts = m.nodes.filter((n) => n.type === 'prompt').map((n) => n.text).join('\n');
    assert.ok(prompts.includes('outputs/') && prompts.includes('data/'), f);
    assert.ok(m.nodes.some((n) => n.type === 'checkpoint'), f);
  }
});
