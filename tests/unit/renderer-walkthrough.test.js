import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STEPS, stepsFor, folderName, prerequisitesSatisfied } from '../../src/renderer/components/walkthrough.js';
import {
  CASE_FILTERS, QUICK_PICKS, caseIcon, casesOf, filterCases, resolveQuickPick, defaultProjectName, folderPreview, joinPath,
  wizardSteps, preferredAgent, filesToImport, importFileVars, baseName,
} from '../../src/renderer/lib/cases.js';
import { SETUP_STEPS, stepProgress, stepError, toolRows, helpersState, nextIndex, prevIndex } from '../../src/renderer/lib/setup-steps.js';
import { CASES } from '../../src/renderer/lib/mock-phase8.js';

const sum = (m) => ({ id: m.id, name: m.name, description: m.description, tags: m.tags, meta: m.meta });
const list = [...CASES.map(sum), { id: 'plain', name: { en: 'Plain' }, meta: undefined }];

test('new-project wizard steps: questions only when the case has variables', () => {
  assert.deepEqual(STEPS, ['help', 'name', 'agent', 'ready']);
  assert.deepEqual(stepsFor(true), ['help', 'questions', 'name', 'agent', 'ready']);
  assert.deepEqual(wizardSteps(false), STEPS);
});

test('folderName handles windows and posix paths', () => {
  assert.equal(folderName('C:\\Users\\x\\My Project\\'), 'My Project');
  assert.equal(folderName('/home/x/proj'), 'proj');
  assert.equal(baseName('C:\\a\\b.xlsx'), 'b.xlsx');
});

test('there are 10 mock cases and only cases are listed', () => {
  assert.equal(CASES.length, 10);
  assert.equal(casesOf(list).length, 10);
  assert.ok(CASES.some((c) => c.vars.some((v) => v.type === 'file')) && CASES.some((c) => c.vars.some((v) => v.type === 'textarea')));
});

test('filterCases by category, several categories and words', () => {
  assert.equal(filterCases(list, { category: 'excel' }).length, 3);
  assert.equal(filterCases(list, { category: ['data', 'dashboard'] }).length, 2);
  assert.equal(filterCases(list, { category: 'all' }).length, 10);
  assert.equal(filterCases(list, { query: 'dashboard csv' }).length >= 1, true);
  assert.equal(filterCases(list, { query: 'hoja', lang: 'es' }).length >= 1, true);
  assert.equal(filterCases(list, { query: 'zzzz' }).length, 0);
  assert.ok(CASE_FILTERS.includes('all') && CASE_FILTERS.length === 8);
});

test('quick picks: one match selects the case, several open the filtered grid', () => {
  const by = (id) => QUICK_PICKS.find((p) => p.id === id);
  assert.deepEqual(resolveQuickPick(list, by('web')), { kind: 'case', id: 'case-web-page' });
  assert.deepEqual(resolveQuickPick(list, by('research')), { kind: 'case', id: 'case-research-topic' });
  assert.deepEqual(resolveQuickPick(list, by('excel')), { kind: 'grid', categories: ['excel'] });
  assert.equal(resolveQuickPick(list, by('data')).kind, 'grid');
  assert.deepEqual(resolveQuickPick([], by('excel')), { kind: 'grid', categories: [] });
});

test('icons map to inline icons with a fallback', () => {
  assert.equal(caseIcon('file-text'), 'fileText');
  assert.equal(caseIcon('table'), 'table');
  assert.equal(caseIcon('nope'), 'sparkles');
});

test('default project name and folder preview text', () => {
  assert.equal(defaultProjectName('Sales analysis', new Date(2026, 10, 22)), 'Sales analysis - 2026-11-22');
  assert.equal(folderPreview('C:\\Users\\x\\Documents\\Projects', 'An\u00e1lisis de ventas 2026', 'es'), 'C:\\Users\\x\\Documents\\Projects\\Analisis_De_Ventas_2026');
  assert.equal(folderPreview('/home/x/Projects/', 'my app'), '/home/x/Projects/My_App');
  assert.equal(folderPreview('', '***', 'es'), 'Proyecto');
  assert.equal(joinPath('C:\\a\\', 'b'), 'C:\\a\\b');
});

test('preferred agent is the signed-in one', () => {
  assert.equal(preferredAgent({ claude: false, agy: true }), 'agy');
  assert.equal(preferredAgent({ claude: true, agy: true }), 'claude');
  assert.equal(preferredAgent({ claude: null, agy: null }), 'claude');
});

test('file vars are copied into the project and replaced by the relative path', async () => {
  const vars = [{ key: 'input', type: 'file' }, { key: 'goal', type: 'textarea' }, { key: 'extra', type: 'file' }];
  const values = { input: 'C:\\docs\\sales.xlsx', goal: 'totals', extra: '' };
  assert.deepEqual(filesToImport(vars, values), [{ key: 'input', path: 'C:\\docs\\sales.xlsx', name: 'sales.xlsx' }]);
  const calls = [];
  const api = { files: { import: async (pid, p) => { calls.push([pid, p]); return { rel: 'data/sales.xlsx', name: 'sales.xlsx', size: 1 }; } } };
  const done = {};
  const out = await importFileVars(api, 'p9', vars, values, done);
  assert.deepEqual(out, { input: 'data/sales.xlsx', goal: 'totals', extra: '' });
  assert.deepEqual(values.input, 'C:\\docs\\sales.xlsx');
  await importFileVars(api, 'p9', vars, values, done); // retry does not copy twice
  assert.equal(calls.length, 1);
  await assert.rejects(importFileVars({ files: { import: async () => { throw new Error('too big'); } } }, 'p', vars, values), /too big/);
});

test('setup steps: language first, progress and validation', () => {
  assert.equal(SETUP_STEPS[0], 'language');
  assert.equal(SETUP_STEPS.at(-1), 'done');
  assert.equal(SETUP_STEPS.length, 9);
  assert.deepEqual(stepProgress(0), { current: 1, total: 9, pct: 0 });
  assert.equal(stepProgress(99).current, 9);
  assert.equal(stepError('language', { language: 'fr' }), 'language');
  assert.equal(stepError('language', { language: 'es' }), null);
  assert.equal(stepError('tools', {}), null);
  assert.equal(nextIndex(8), 8);
  assert.equal(prevIndex(0), 0);
});

test('tool rows and helpers state never block', () => {
  const rows = toolRows({ git: { found: true, version: '2.4' }, node: { found: false }, python: { found: false } });
  assert.deepEqual(rows.map((r) => [r.id, r.ok]), [['git', true], ['node', false], ['python', false]]);
  assert.equal(toolRows(null)[0].ok, null);
  assert.equal(helpersState({ claude: false, agy: null }), 'later');
  assert.equal(helpersState({ claude: true, agy: false }), 'ready');
  assert.equal(prerequisitesSatisfied({ claude: true }, 'claude'), true);
});
