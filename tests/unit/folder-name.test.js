import { test } from 'node:test';
import assert from 'node:assert/strict';
import { folderNameFromTitle, uniqueFolderName, MAX_FOLDER_NAME } from '../../src/shared/folder-name.js';

test('titles become Capitalised_Words_With_Underscores, accents removed', () => {
  assert.equal(folderNameFromTitle('Analisis de ventas 2026'), 'Analisis_De_Ventas_2026');
  assert.equal(folderNameFromTitle('An\u00e1lisis de ventas \u00f1and\u00fa'), 'Analisis_De_Ventas_Nandu');
  assert.equal(folderNameFromTitle('sales report - Q3 (final)'), 'Sales_Report_Q3_Final');
  assert.equal(folderNameFromTitle('CSV cleanup'), 'CSV_Cleanup');
  assert.equal(folderNameFromTitle('  weird///name:*?  '), 'Weird_Name');
  assert.equal(folderNameFromTitle('mi_proyecto-v2'), 'Mi_Proyecto_V2');
});

test('never empty, never a Windows reserved name, never path-like', () => {
  assert.equal(folderNameFromTitle(''), 'Project');
  assert.equal(folderNameFromTitle('', 'es'), 'Proyecto');
  assert.equal(folderNameFromTitle('***'), 'Project');
  assert.equal(folderNameFromTitle('\u4e2d\u6587'), 'Project'); // nothing usable survives
  assert.equal(folderNameFromTitle('con'), 'Project_Con');
  assert.equal(folderNameFromTitle('nul', 'es'), 'Proyecto_Nul');
  assert.equal(folderNameFromTitle('com1'), 'Project_Com1');
  assert.equal(folderNameFromTitle('..\\..\\Windows'), 'Windows');
  assert.equal(folderNameFromTitle('C:\\Users\\x'), 'C_Users_X');
  assert.ok(!/[\\/:*?"<>|.\s]/.test(folderNameFromTitle('a.b c/d')));
});

test('long titles are cut at a word boundary within the limit, no trailing underscore', () => {
  const long = 'word '.repeat(40);
  const n = folderNameFromTitle(long);
  assert.ok(n.length <= MAX_FOLDER_NAME && !n.endsWith('_'), n);
  assert.ok(/^(Word_)*Word$/.test(n), n);
  const one = folderNameFromTitle('x'.repeat(200));
  assert.equal(one.length, MAX_FOLDER_NAME);
});

test('uniqueFolderName appends _2, _3 ...', () => {
  const taken = new Set(['Sales', 'Sales_2']);
  assert.equal(uniqueFolderName('Sales', (n) => taken.has(n)), 'Sales_3');
  assert.equal(uniqueFolderName('Fresh', (n) => taken.has(n)), 'Fresh');
  assert.throws(() => uniqueFolderName('A', () => true, 5), /free folder name/);
});
