import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { _setDictionaries, setLanguage, getLanguage, t, detectLanguage, onChange } from '../../src/renderer/lib/i18n.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src/renderer/i18n');
const load = (n) => JSON.parse(readFileSync(path.join(dir, n + '.json'), 'utf8'));
const en = load('en');
const es = load('es');

function flat(o, p = '', out = {}) {
  for (const [k, v] of Object.entries(o)) {
    const key = p ? p + '.' + k : k;
    if (v && typeof v === 'object') flat(v, key, out); else out[key] = v;
  }
  return out;
}
const fe = flat(en);
const fs = flat(es);
const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

test('en and es have identical keys', () => {
  assert.deepEqual(Object.keys(fe).sort(), Object.keys(fs).sort());
  assert.ok(Object.keys(fe).length >= 120);
});

test('no empty values', () => {
  for (const [name, f] of [['en', fe], ['es', fs]]) {
    for (const [k, v] of Object.entries(f)) {
      assert.equal(typeof v, 'string', name + ':' + k);
      assert.ok(v.trim().length > 0, 'empty ' + name + ':' + k);
    }
  }
});

test('placeholders match between languages', () => {
  for (const k of Object.keys(fe)) assert.equal(vars(fs[k]), vars(fe[k]), k);
});

test('t() interpolates, falls back to en, then to key', async () => {
  _setDictionaries({ a: { b: 'Hi {name}', only: 'EN only' } }, { a: { b: 'Hola {name}' } });
  await setLanguage('es');
  assert.equal(getLanguage(), 'es');
  assert.equal(t('a.b', { name: 'Ana' }), 'Hola Ana');
  assert.equal(t('a.only'), 'EN only');
  assert.equal(t('missing.key'), 'missing.key');
  assert.equal(t('a.b', {}), 'Hola {name}');
  await setLanguage('en');
  assert.equal(t('a.b', { name: 'Bo' }), 'Hi Bo');
});

test('onChange fires, unsupported language falls back to en, detectLanguage', async () => {
  _setDictionaries(en, es);
  let seen = null;
  const off = onChange((l) => { seen = l; });
  await setLanguage('es');
  assert.equal(seen, 'es');
  off();
  await setLanguage('fr');
  assert.equal(getLanguage(), 'en');
  assert.equal(seen, 'es');
  assert.equal(detectLanguage('es-MX'), 'es');
  assert.equal(detectLanguage('de-DE'), 'en');
});
