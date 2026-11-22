import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simplifyMath, mathToText } from '../../src/renderer/lib/md-utils.js';
import { layoutFor, detectLayout, layoutNote } from '../../src/shared/layout.js';

test('simplifyMath turns LaTeX spans into plain text', () => {
  assert.equal(simplifyMath('Estan a unos $30 - 35\text{ cm}$ del suelo y $60\text{ cm}$.'), 'Estan a unos 30 - 35 cm del suelo y 60 cm.');
  assert.equal(mathToText('x^{2} + 3 \times 4'), 'x² + 3 × 4');
  assert.equal(mathToText('\frac{1}{2}'), '(1)/(2)');
});

test('simplifyMath leaves money and code alone', () => {
  assert.equal(simplifyMath('Cuesta $30 y luego $40.'), 'Cuesta $30 y luego $40.');
  assert.equal(simplifyMath('use `$x\text{a}$` here'), 'use `$x\text{a}$` here');
  assert.equal(simplifyMath('```\n$a^2$\n```'), '```\n$a^2$\n```');
});

test('project layout follows the language and detects existing folders', () => {
  assert.deepEqual({ ...layoutFor('es') }, { data: 'datos', outputs: 'salidas' });
  assert.deepEqual({ ...layoutFor('en') }, { data: 'data', outputs: 'outputs' });
  assert.equal(detectLayout((n) => n === 'data', 'es').data, 'data');
  assert.equal(detectLayout(() => false, 'es').outputs, 'salidas');
  assert.match(layoutNote(layoutFor('es')), /datos\/.*salidas\//);
});
