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

test('usage: per-model totals (today + 7 days) from finished turns', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { createUsage } = await import('../../src/main/svc/usage.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-use-'));
  const u = createUsage({ dir, getProject: () => ({ agent: 'opencode', model: 'opencode-go/glm-5.3-flash' }), runUsage: async () => ({ code: 1, stdout: '' }) });
  u.onAgentEvent('p1', { type: 'result', ok: true, usage: { input_tokens: 1000, output_tokens: 200 } }, { agent: 'opencode' });
  u.onAgentEvent('p1', { type: 'result', ok: true, usage: { input_tokens: 500, output_tokens: 100 }, costUsd: 0.25 }, { agent: 'opencode' });
  const m = u.snapshot().models;
  const k = 'opencode|opencode-go/glm-5.3-flash';
  assert.deepEqual(m.week[k], { inputTokens: 1500, outputTokens: 300, turns: 2, costUsd: 0.25 });
  assert.equal(m.today[k].turns, 2);
  u.dispose();
});

test('queue: continues only after a clean turn; model groups put the plan-covered provider first; opencode plan detection', async () => {
  const { turnEndedClean } = await import('../../src/renderer/components/queue-resend.js');
  const { groupModelOptions } = await import('../../src/renderer/lib/models.js');
  const { parseOpencodeAuthList } = await import('../../src/main/svc/models.js');
  const { preferredOpencodeModel } = await import('../../src/shared/events.js');
  const chat = (msgs, over = {}) => ({ running: false, turn: { id: 2, endedAt: 5 }, messages: msgs.map((m) => ({ turn: 2, ...m })), ...over });
  assert.equal(turnEndedClean(chat([{ role: 'assistant' }])), true);
  assert.equal(turnEndedClean(chat([{ role: 'error' }])), false);
  assert.equal(turnEndedClean(chat([{ role: 'limit', status: 'rejected' }])), false);
  assert.equal(turnEndedClean(chat([{ role: 'limit', status: 'warning' }])), true); // a usage warning does not pause the queue
  assert.equal(turnEndedClean(chat([{ role: 'system', key: 'chat.stopped' }])), false);
  assert.equal(turnEndedClean(chat([{ role: 'approval' }])), false);
  assert.equal(turnEndedClean(chat([], { running: true })), false);
  assert.equal(turnEndedClean(chat([{ role: 'error', turn: 1 }])), true); // an old turn's error does not count
  const groups = groupModelOptions([{ id: 'opencode/a', group: 'opencode:opencode' }, { id: 'x/y', group: 'opencode:anthropic' }, { id: 'opencode-go/b', group: 'opencode:opencode-go' }]);
  assert.deepEqual(groups.map((g) => g.provider), ['opencode-go', 'anthropic', 'opencode']);
  assert.deepEqual(parseOpencodeAuthList('OpenCode Go       OpenCode Go 2               stored\nOpenCode Console  Personal                    stored\nAnthropic         key                         env'), ['opencode-go', 'opencode', 'anthropic']);
  assert.deepEqual(parseOpencodeAuthList(''), []);
  assert.equal(preferredOpencodeModel([{ id: 'opencode/big' }, { id: 'opencode-go/kimi-k3' }, { id: 'opencode-go/glm-5.3-flash' }]), 'opencode-go/glm-5.3-flash');
  assert.equal(preferredOpencodeModel([{ id: 'opencode/big' }]), null);
});

test('attachable files: shared type list, project note for the agent', async () => {
  const { DOC_EXT, isDocName, isImageName, extOf, attachNote, ATTACH_ACCEPT } = await import('../../src/shared/filetypes.js');
  const { OFFICE_EXT, IMPORT_EXT } = await import('../../src/main/svc/imports.js');
  for (const e of ['xlsx', 'pptx', 'docx', 'csv', 'txt', 'md', 'pdf', 'json']) assert.ok(DOC_EXT.includes(e) && IMPORT_EXT.includes(e), e);
  assert.ok(OFFICE_EXT.includes('pptx'));
  assert.equal(isDocName('Ventas 2026.XLSX'), true);
  assert.equal(isDocName('virus.exe'), false);
  assert.equal(isImageName('a.PNG'), true);
  assert.equal(extOf('archivo'), '');
  assert.match(ATTACH_ACCEPT, /\.pptx/);
  assert.match(ATTACH_ACCEPT, /image\/png/);
  assert.equal(attachNote([]), '');
  const n = attachNote(['data/ventas.xlsx', 'data/deck.pptx', 'data/nota.md']);
  assert.match(n, /data\/ventas\.xlsx, data\/deck\.pptx, data\/nota\.md/);
  assert.match(n, /openpyxl/);
  assert.match(n, /python-pptx/);
  assert.match(n, /Never change the originals/);
});

test('approval policy per agent/mode and pay-as-you-go model acceptance', async () => {
  const { policyOf, paygKind, modelNeedsAccept, acceptPatch } = await import('../../src/renderer/lib/policy.js');
  assert.deepEqual(policyOf('claude', 'default'), { key: 'ask', tone: 'green' });
  assert.deepEqual(policyOf('claude', 'acceptEdits'), { key: 'edits', tone: 'amber' });
  assert.deepEqual(policyOf('claude', 'plan'), { key: 'plan', tone: 'green' });
  assert.deepEqual(policyOf('claude', 'auto'), { key: 'all', tone: 'red' });
  assert.deepEqual(policyOf('opencode', 'default'), { key: 'none', tone: 'amber' }); // opencode run never asks
  assert.deepEqual(policyOf('opencode', 'plan'), { key: 'plan', tone: 'green' });
  assert.deepEqual(policyOf('agy', 'default'), { key: 'edits', tone: 'amber' });
  assert.equal(paygKind('opencode/beam-free'), 'zen');
  assert.equal(paygKind('opencode-go/glm-5.3-flash'), null); // plan-covered: no OK needed
  assert.equal(paygKind('deepseek-chat'), 'deepseek');
  assert.equal(paygKind('opus'), null);
  assert.equal(modelNeedsAccept('opencode/beam-free', {}), 'zen');
  assert.equal(modelNeedsAccept('opencode/beam-free', { acceptedModels: ['opencode/beam-free'] }), null);
  assert.equal(modelNeedsAccept('deepseek-chat', { acceptAllPayg: true }), null);
  assert.equal(modelNeedsAccept('opencode-go/x', {}), null);
  assert.deepEqual(acceptPatch({ acceptedModels: ['a'] }, 'b', false), { acceptedModels: ['a', 'b'] });
  assert.deepEqual(acceptPatch({}, 'b', true), { acceptAllPayg: true });
});
