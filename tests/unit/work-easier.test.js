import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffSheets } from '../../src/main/svc/workflow.js';
import { nextRun, cleanTask } from '../../src/main/svc/schedule.js';
import { parsePlanSteps, runPlanPrompt, fileActions, askPrompt } from '../../src/renderer/components/work-easier.js';

test('parsePlanSteps: numbered, bullets and task lists; ignores prose', () => {
  const text = 'Here is the plan:\n\n1. Read **data.xlsx**\n2) Clean the `Fecha` column\n- [ ] Build the chart\n* Write the report\n\nThat is all.';
  assert.deepEqual(parsePlanSteps(text), ['Read data.xlsx', 'Clean the Fecha column', 'Build the chart', 'Write the report']);
  assert.deepEqual(parsePlanSteps('No steps here.'), []);
  assert.match(runPlanPrompt(['A', 'B']), /1\. A\n2\. B$/);
});

test('fileActions: right choices per file type, always an Explain fallback', () => {
  const ids = (n) => fileActions(n).map((a) => a.id);
  assert.deepEqual(ids('Ventas.xlsx'), ['analyze', 'clean', 'dashboard', 'explain']);
  assert.deepEqual(ids('informe.pdf'), ['summarize', 'extract', 'explain']);
  assert.deepEqual(ids('deck.pptx'), ['summarize', 'improve', 'explain']);
  assert.deepEqual(ids('foto.png'), ['describe', 'explain']);
  assert.deepEqual(ids('raro.bin'), ['explain']);
  assert.match(fileActions('a.csv')[0].prompt('datos/a.csv'), /datos\/a\.csv/);
  assert.match(askPrompt('errors', 'x.xlsx'), /Do not change the file/);
});

test('diffSheets: changed / added / removed cells and sheets', () => {
  const before = [{ name: 'S1', rows: [['a', '1'], ['b', '2']] }, { name: 'Old', rows: [['x']] }];
  const after = [{ name: 'S1', rows: [['a', '10'], ['b', '2'], ['c', '3']] }, { name: 'New', rows: [['y']] }];
  const d = diffSheets(before, after);
  const s1 = d.find((s) => s.name === 'S1');
  assert.equal(s1.status, 'changed');
  assert.deepEqual(s1.changes.map((c) => [c.cell, c.before, c.after, c.kind]), [['B1', '1', '10', 'changed'], ['A3', '', 'c', 'added'], ['B3', '', '3', 'added']]);
  assert.equal(d.find((s) => s.name === 'Old').status, 'removed');
  assert.equal(d.find((s) => s.name === 'New').status, 'added');
  assert.equal(diffSheets([{ name: 'A', rows: [['1']] }], [{ name: 'A', rows: [['1']] }])[0].status, 'same');
});

test('schedule: nextRun for hourly, daily and weekly (local time)', () => {
  const at = (y, mo, d, h, mi) => new Date(y, mo, d, h, mi, 0, 0).getTime();
  const mon9 = at(2026, 10, 23, 9, 0); // Monday 23 Nov 2026 09:00
  assert.equal(new Date(mon9).getDay(), 1);
  assert.equal(nextRun({ freq: 'daily', time: '09:00', days: [] }, at(2026, 10, 23, 8, 0)), mon9);
  assert.equal(nextRun({ freq: 'daily', time: '09:00', days: [] }, mon9), at(2026, 10, 24, 9, 0));
  assert.equal(nextRun({ freq: 'weekly', time: '09:00', days: [1] }, mon9), at(2026, 10, 30, 9, 0));
  assert.equal(nextRun({ freq: 'weekly', time: '18:30', days: [3, 5] }, mon9), at(2026, 10, 25, 18, 30));
  assert.equal(nextRun({ freq: 'hourly', time: '00:15', days: [] }, at(2026, 10, 23, 9, 20)), at(2026, 10, 23, 10, 15));
  assert.equal(nextRun({ freq: 'hourly', time: '00:15', days: [] }, at(2026, 10, 23, 9, 10)), at(2026, 10, 23, 9, 15));
});

test('schedule: cleanTask validates and normalises', () => {
  const t = cleanTask({ name: ' Dashboard ', projectId: 'p1', prompt: 'Update it', freq: 'weekly', time: '07:05', days: [5, 1, 1, 9] });
  assert.deepEqual([t.name, t.kind, t.freq, t.time, t.days, t.enabled, t.catchUp], ['Dashboard', 'prompt', 'weekly', '07:05', [1, 5], true, true]);
  assert.throws(() => cleanTask({ name: 'x', projectId: 'p1', prompt: '' }), /prompt/);
  assert.throws(() => cleanTask({ name: '', projectId: 'p1', prompt: 'a' }), /name/);
  assert.throws(() => cleanTask({ name: 'x', projectId: 'p1', prompt: 'a', freq: 'weekly', days: [] }), /day/);
  assert.equal(cleanTask({ name: 'x', projectId: 'p1', prompt: 'a', time: '25:00' }).time, '09:00');
  assert.equal(cleanTask({ name: 'x', projectId: 'p1', kind: 'recipe', recipeId: 'data-analysis', vars: { q: 'why' } }).recipeId, 'data-analysis');
});
