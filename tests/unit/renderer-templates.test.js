import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickLang, extractVars, render, validate, defaultValues, syncVars, filterTemplates, slugify, isValidId,
  parseTags, buildTemplate, duplicateId,
} from '../../src/renderer/lib/templates.js';

test('pickLang prefers the language, falls back to en then any value', () => {
  assert.equal(pickLang({ en: 'Hi', es: 'Hola' }, 'es'), 'Hola');
  assert.equal(pickLang({ en: 'Hi' }, 'es'), 'Hi');
  assert.equal(pickLang({ es: 'Hola' }, 'en'), 'Hola');
  assert.equal(pickLang({ en: '', es: 'Hola' }, 'en'), 'Hola');
  assert.equal(pickLang(null, 'en'), '');
  assert.equal(pickLang('plain', 'en'), 'plain');
});

test('extractVars finds unique keys in order, tolerating spaces', () => {
  assert.deepEqual(extractVars('A {{x}} B {{ y }} C {{x}} {{1bad}} {{ok-1}}'), ['x', 'y', 'ok-1']);
  assert.deepEqual(extractVars(''), []);
  assert.deepEqual(extractVars(null), []);
});

test('render substitutes plain text without escaping or dollar patterns', () => {
  const vars = [{ key: 'a', type: 'text', default: 'DEF' }, { key: 'b', type: 'text' }];
  assert.equal(render('1 {{a}} 2 {{ b }}', { a: 'x', b: '<b>$&</b>' }, vars), '1 x 2 <b>$&</b>');
  assert.equal(render('{{a}}|{{b}}|{{c}}', {}, vars), 'DEF||');
  assert.equal(render('{{a}}', { a: '' }, vars), 'DEF');
  assert.equal(render('{{a}}', { a: '{{b}}', b: 'no' }, vars), '{{b}}');
  assert.equal(render('no vars'), 'no vars');
});

test('validate flags blank required vars only', () => {
  const vars = [{ key: 'a', required: true }, { key: 'b' }, { key: 'c', required: true }];
  const r = validate(vars, { a: '  ', b: '', c: 'x' });
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, { a: 'required' });
  assert.equal(validate(vars, { a: 'x', c: 'y' }).ok, true);
});

test('defaultValues uses defaults and the first select option', () => {
  const v = defaultValues([{ key: 'a', default: 'x' }, { key: 'b', type: 'select', options: ['one', 'two'] }, { key: 'c' }]);
  assert.deepEqual(v, { a: 'x', b: 'one', c: '' });
});

test('syncVars keeps editor settings, adds new keys, drops removed ones', () => {
  const existing = [{ key: 'a', type: 'textarea', label: { en: 'A', es: 'A' } }, { key: 'gone', type: 'text', label: { en: 'g', es: 'g' } }];
  const out = syncVars('{{a}} {{new}}', existing);
  assert.deepEqual(out.map((v) => v.key), ['a', 'new']);
  assert.equal(out[0].type, 'textarea');
  assert.equal(out[1].type, 'text');
});

test('filterTemplates searches names, descriptions, tags and id in both languages', () => {
  const list = [
    { id: 'bug-fix', name: { en: 'Fix a bug', es: 'Arreglar un error' }, description: { en: 'Find root cause', es: 'Causa raiz' }, tags: ['debug'] },
    { id: 'review', name: { en: 'Review code', es: 'Revisar codigo' }, description: { en: 'x', es: 'y' }, tags: ['quality'] },
  ];
  assert.equal(filterTemplates(list, '', 'en').length, 2);
  assert.deepEqual(filterTemplates(list, 'arreglar', 'es').map((t) => t.id), ['bug-fix']);
  assert.deepEqual(filterTemplates(list, 'QUALITY', 'en').map((t) => t.id), ['review']);
  assert.deepEqual(filterTemplates(list, 'fix bug', 'en').map((t) => t.id), ['bug-fix']);
  assert.equal(filterTemplates(list, 'zzz', 'en').length, 0);
});

test('slugify / isValidId / parseTags / duplicateId', () => {
  assert.equal(slugify('  Mi Plantilla Genial! '), 'mi-plantilla-genial');
  assert.equal(slugify('Cafe\u0301 ni\u00f1o'), 'cafe-nino');
  assert.equal(isValidId('ok-id_1'), true);
  assert.equal(isValidId('Bad Id'), false);
  assert.equal(isValidId(''), false);
  assert.deepEqual(parseTags(' A, b ,a,, c'), ['a', 'b', 'c']);
  assert.equal(duplicateId('x', ['x']), 'x-copy');
  assert.equal(duplicateId('x', ['x', 'x-copy', 'x-copy-2']), 'x-copy-3');
});

test('buildTemplate normalises a draft', () => {
  const tpl = buildTemplate({
    id: 'x', name: { en: 'N', es: '' }, description: { en: 'D' }, tags: ['t'], body: 'Hi {{who}}',
    vars: [{ key: 'who', type: 'select', options: ['a', '', 'b'], label: { en: 'Who' }, required: true, default: 'a' }, { key: 'stale' }],
  });
  assert.equal(tpl.source, 'user');
  assert.equal(tpl.name.es, 'N');
  assert.equal(tpl.vars.length, 1);
  assert.deepEqual(tpl.vars[0], { key: 'who', label: { en: 'Who', es: 'Who' }, type: 'select', default: 'a', options: ['a', 'b'], required: true });
});
