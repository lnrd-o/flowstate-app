import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { _setDictionaries, setLanguage } from '../../src/renderer/lib/i18n.js';
import { createChatState, reduceEvent, addUserMessage } from '../../src/renderer/lib/events.js';
import { replayHistory } from '../../src/renderer/lib/history.js';
import { effectiveDeveloperMode, isDev, isGlobalDev, createInitialState } from '../../src/renderer/lib/store.js';
import { debounce, mergeUi, fitUi, restorePlan, globalSlice, UI_MAX_BYTES } from '../../src/renderer/lib/ui-state.js';
import {
  elapsedText, agentElapsed, todoProgress, groupTasks, taskCount, stateBadge, serviceTitle, stopNeedsConfirm,
} from '../../src/renderer/lib/tasks.js';
import {
  effortValues, displayEffort, modelToStore, effectiveModelId, modelOptions, currentModelLabel, modelsNeedSignIn,
} from '../../src/renderer/lib/models.js';
import {
  acceleratorLabel, acceleratorMatches, buildMenuView, altMnemonic, moveIndex, edgeIndex, typeAheadIndex, keyAction, shortcutGroups, labelOf,
} from '../../src/renderer/lib/menu-state.js';
import { MENU, flattenMenu } from '../../src/shared/menu.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src/renderer/i18n');
const load = (n) => JSON.parse(readFileSync(path.join(dir, n + '.json'), 'utf8'));
let en;
let es;
before(async () => { en = load('en'); es = load('es'); _setDictionaries(en, es); await setLanguage('en'); });

const run = (events, start = createChatState()) => events.reduce((s, e) => reduceEvent(s, e), start);

test('reducer: limit event becomes one card per kind/status and keeps the CLI text verbatim', () => {
  let s = addUserMessage(createChatState(), 'go', { agent: 'claude' });
  s = reduceEvent(s, { type: 'limit', agent: 'claude', kind: 'five_hour', status: 'rejected', resetsAt: 123 });
  s = reduceEvent(s, { type: 'limit', agent: 'claude', kind: 'unknown', status: 'rejected', message: "You've hit your limit - resets 3pm" });
  const cards = s.messages.filter((m) => m.role === 'limit');
  assert.equal(cards.length, 1);
  assert.equal(cards[0].kind, 'five_hour');
  assert.equal(cards[0].message, "You've hit your limit - resets 3pm");
  assert.equal(cards[0].resetsAt, 123);
  // the failed result must not add a second, generic error that repeats the same text
  s = reduceEvent(s, { type: 'result', ok: false, text: "You've hit your limit - resets 3pm" });
  assert.equal(s.messages.filter((m) => m.role === 'error').length, 0);
  assert.equal(s.running, false);
});

test('reducer: warning and rejected cards are separate; unrelated failures still show an error', () => {
  let s = addUserMessage(createChatState(), 'go', { agent: 'claude' });
  s = reduceEvent(s, { type: 'limit', agent: 'claude', kind: 'five_hour', status: 'warning', utilization: 0.9 });
  s = reduceEvent(s, { type: 'result', ok: false, text: 'boom' });
  assert.equal(s.messages.filter((m) => m.role === 'limit').length, 1);
  assert.equal(s.messages.filter((m) => m.role === 'error').length, 1);
  // a limit error event after a rejected card is absorbed
  let r = addUserMessage(createChatState(), 'go', { agent: 'agy' });
  r = reduceEvent(r, { type: 'limit', agent: 'agy', kind: 'quota', status: 'rejected', message: 'Usage limit reached' });
  r = reduceEvent(r, { type: 'error', kind: 'api', message: 'Usage limit reached, try again in 2 hours' });
  assert.equal(r.messages.filter((m) => m.role === 'error').length, 0);
});

test('reducer: todos and subagent events stay out of the message flow', () => {
  let s = run([
    { type: 'todos', items: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }, { content: 'c', status: 'weird' }, { nope: 1 }] },
    { type: 'subagent', id: 's1', name: 'Explore', description: 'look around', state: 'running' },
    { type: 'subagent', id: 's1', name: 'Explore', state: 'done' },
    { type: 'subagent', id: 's2', name: 'Plan', state: 'error' },
  ]);
  assert.equal(s.messages.length, 0);
  assert.deepEqual(s.todos.map((x) => x.status), ['completed', 'in_progress', 'pending']);
  assert.equal(s.subagents.length, 2);
  assert.equal(s.subagents[0].state, 'done');
  assert.equal(s.subagents[0].description, 'look around');
  s = reduceEvent(s, { type: 'todos', items: [] });
  assert.equal(s.todos.length, 0);
});

test('reducer: user messages carry images and history replay restores them', () => {
  const s = addUserMessage(createChatState(), 'look', { agent: 'claude', images: ['.flowstate/attachments/a.png', '', 5] });
  assert.deepEqual(s.messages[0].images, ['.flowstate/attachments/a.png']);
  assert.equal('images' in addUserMessage(createChatState(), 'x', {}).messages[0], false);
  const h = replayHistory([{ ts: 1, t: 'user', text: 'what is this', images: ['.flowstate/attachments/b.webp'] }], undefined, { agent: 'agy' });
  assert.deepEqual(h.messages[0].images, ['.flowstate/attachments/b.webp']);
});

test('effectiveDeveloperMode: project override wins, null follows the global setting', () => {
  assert.equal(effectiveDeveloperMode({ developerMode: true }, { developerMode: false }), true);
  assert.equal(effectiveDeveloperMode({ developerMode: false }, { developerMode: true }), false);
  assert.equal(effectiveDeveloperMode({ developerMode: null }, { developerMode: false }), false);
  assert.equal(effectiveDeveloperMode({}, { developerMode: true }), true);
  assert.equal(effectiveDeveloperMode(null, {}), true);
  assert.equal(effectiveDeveloperMode(undefined, { developerMode: false }), false);
  const st = { ...createInitialState(), projects: [{ id: 'p', developerMode: false }], activeProjectId: 'p' };
  assert.equal(isDev(st), false);
  assert.equal(isGlobalDev(st), true);
  assert.equal(isDev({ ...st, activeProjectId: null }), true);
});

test('ui-state: debounce, merge, fit and restore plan', () => {
  const calls = [];
  const fake = { id: 0, fns: new Map() };
  const timers = { set: (fn) => { fake.id += 1; fake.fns.set(fake.id, fn); return fake.id; }, clear: (id) => fake.fns.delete(id) };
  const d = debounce((x) => calls.push(x), 400, timers);
  d(1); d(2); d(3);
  assert.equal(fake.fns.size, 1);
  assert.equal(d.pending(), true);
  d.flush();
  assert.deepEqual(calls, [3]);
  assert.equal(d.pending(), false);
  d.flush();
  assert.deepEqual(calls, [3]);
  d(4); d.cancel();
  assert.equal(fake.fns.size, 0);
  assert.deepEqual(mergeUi({ a: 1, b: 2 }, { b: undefined, c: 3 }), { a: 1, c: 3 });
  assert.deepEqual(mergeUi(null, { a: 1 }), { a: 1 });
  const big = { draft: 'x'.repeat(UI_MAX_BYTES * 2), tab: 'files' };
  const fit = fitUi(big);
  assert.ok(JSON.stringify(fit).length <= UI_MAX_BYTES);
  assert.equal(fit.tab, 'files');
  const plan = restorePlan(
    { sidebarCollapsed: true, artifactsCollapsed: 'no', artifactsWidth: 480.4, sidebarWidth: 10, view: 'tasks' },
    { artifactsTab: 'files', openFile: 'src/a.js', draft: 'hello', scroll: 120.6 });
  assert.deepEqual(plan, { sidebarCollapsed: true, artifactsWidth: 480, view: 'tasks', artifactsTab: 'files', openFile: 'src/a.js', draft: 'hello', scroll: 121 });
  assert.deepEqual(restorePlan(null, { openFile: '../secret', artifactsTab: 'nope', scroll: -3 }), {});
  assert.deepEqual(globalSlice({ sidebarCollapsed: 1, artifactsCollapsed: 0, view: 'project', artifactsWidth: 400 }), { sidebarCollapsed: true, artifactsCollapsed: false, view: 'project', artifactsWidth: 400 });
});

test('tasks model: grouping, elapsed, progress, badges', () => {
  assert.equal(elapsedText(83_000), '1:23');
  assert.equal(elapsedText(3_725_000), '1:02:05');
  assert.equal(elapsedText(-5), '0:00');
  assert.equal(agentElapsed({ startedAt: 1000, elapsedMs: 5 }, 6000), 5000);
  assert.equal(agentElapsed({ elapsedMs: 4000 }, 6000), 4000);
  assert.deepEqual(todoProgress([{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }, { content: 'c', status: 'pending' }]), { done: 1, total: 3, percent: 33, current: 'b' });
  assert.deepEqual(todoProgress([]), { done: 0, total: 0, percent: 0, current: null });
  const snap = {
    agents: [{ projectId: 'p1', agent: 'claude', state: 'running', startedAt: 1 }],
    services: [{ kind: 'dashboard', id: 'p1', projectId: 'p1', label: 'Streamlit 127.0.0.1:8501 (pid 4242)', state: 'running', stoppable: true }],
    todos: { p1: [{ content: 'a', status: 'completed' }], p2: [{ content: 'x', status: 'completed' }, { content: 'y', status: 'pending' }], p3: [] },
    subagents: [{ projectId: 'p1', id: 's', name: 'Explore', state: 'running' }, { projectId: 'p1', id: 't', name: 'Plan', state: 'done' }],
  };
  const g = groupTasks(snap, [{ id: 'p1', name: 'Alpha' }, { id: 'p2', name: 'Beta' }]);
  assert.equal(g.agents[0].projectName, 'Alpha');
  assert.deepEqual(g.todos.map((x) => x.projectName), ['Beta', 'Alpha']); // unfinished first, empty lists dropped
  assert.equal(g.counts.runningSubagents, 1);
  assert.equal(g.runningCount, 2);
  assert.equal(taskCount(snap), 2);
  assert.equal(taskCount(null), 0);
  assert.equal(groupTasks(null, []).runningCount, 0);
  assert.deepEqual(stateBadge('running'), { key: 'tasks.state.running', tone: 'green' });
  assert.equal(stateBadge('waiting').tone, 'amber');
  assert.equal(stateBadge('???').key, 'tasks.state.running');
  assert.match(serviceTitle(snap.services[0], true), /pid 4242/);
  assert.doesNotMatch(serviceTitle(snap.services[0], false), /pid|4242|127/);
  assert.equal(stopNeedsConfirm('agent'), true);
  assert.equal(stopNeedsConfirm('dashboard'), false);
});

test('models: effort sets, simple folding, store value and options', () => {
  assert.deepEqual(effortValues(true), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(effortValues(false), ['low', 'medium', 'high']);
  assert.equal(displayEffort('max', false), 'high');
  assert.equal(displayEffort('xhigh', true), 'xhigh');
  assert.equal(displayEffort(null, false), 'medium');
  const list = { agent: 'claude', source: 'static', defaultModel: 'default', models: [{ id: 'default', name: 'Default (recommended)' }, { id: 'opus', name: 'Opus' }, { id: 'sonnet', name: 'Sonnet', current: true }] };
  assert.equal(modelToStore('default', list), null);
  assert.equal(modelToStore('opus', list), 'opus');
  assert.equal(modelToStore('', list), null);
  assert.equal(effectiveModelId({ model: null }, list), 'default');
  const opts = modelOptions(list, { model: null }, true);
  assert.equal(opts.find((o) => o.current).id, 'default');
  assert.equal(opts[1].sub, 'opus');
  assert.equal(modelOptions(list, { model: 'opus' }, false)[1].sub, '');
  assert.equal(modelOptions(list, { model: 'opus' }, false).find((o) => o.current).id, 'opus');
  assert.equal(currentModelLabel(list, { model: 'opus' }, false, 'Model'), 'Opus');
  assert.equal(currentModelLabel(null, { model: 'weird-id' }, false, 'Model'), 'Model');
  assert.equal(currentModelLabel(null, { model: 'weird-id' }, true, 'Model'), 'weird-id');
  assert.equal(modelsNeedSignIn({ error: 'not-signed-in' }), true);
  assert.equal(modelsNeedSignIn({ error: 'timeout' }), false);
  assert.equal(modelsNeedSignIn({}), false);
});

const ctx = (over) => ({ t: (k) => k, platform: 'win32', developerMode: false, theme: 'gold', packaged: true, ...over });
const model = (recent = []) => ({ items: MENU.map((m) => (m.id === 'file' ? { ...m, submenu: m.submenu.map((i) => (i.id === 'file.recent' ? { ...i, submenu: recent } : i)) } : m)) });

test('menu: accelerators are formatted and matched', () => {
  assert.equal(acceleratorLabel('CmdOrCtrl+Shift+Z', 'win32'), 'Ctrl+Shift+Z');
  assert.equal(acceleratorLabel('CmdOrCtrl+Shift+Z', 'darwin'), 'Cmd+Shift+Z');
  assert.equal(acceleratorLabel('CmdOrCtrl+Plus', 'linux'), 'Ctrl++');
  assert.equal(acceleratorLabel('F11', 'win32'), 'F11');
  assert.equal(acceleratorLabel('', 'win32'), '');
  const ev = (key, o = {}) => ({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...o });
  assert.equal(acceleratorMatches(ev('u', { ctrlKey: true, shiftKey: true }), 'CmdOrCtrl+Shift+U', 'win32'), true);
  assert.equal(acceleratorMatches(ev('U', { ctrlKey: true, shiftKey: true }), 'CmdOrCtrl+Shift+U', 'win32'), true);
  assert.equal(acceleratorMatches(ev('u', { ctrlKey: true }), 'CmdOrCtrl+Shift+U', 'win32'), false);
  assert.equal(acceleratorMatches(ev('b', { metaKey: true }), 'CmdOrCtrl+B', 'darwin'), true);
  assert.equal(acceleratorMatches(ev('b', { ctrlKey: true }), 'CmdOrCtrl+B', 'darwin'), false);
  assert.equal(acceleratorMatches(ev('F11'), 'F11', 'win32'), true);
  assert.equal(acceleratorMatches(ev('=', { ctrlKey: true }), 'CmdOrCtrl+Plus', 'win32'), true);
  assert.equal(acceleratorMatches(ev(',', { ctrlKey: true }), 'CmdOrCtrl+,', 'win32'), true);
  assert.equal(acceleratorMatches(ev('/', { ctrlKey: true }), 'CmdOrCtrl+/', 'win32'), true);
  assert.equal(acceleratorMatches(ev('x'), undefined, 'win32'), false);
});

test('menu: view model reflects state, recent projects, devOnly and separators', () => {
  const v = buildMenuView(model([{ id: 'file.recent:p1', label: 'ClaudeClient', handler: 'renderer' }, { id: 'file.recent:p2', label: 'notes', handler: 'renderer' }]), ctx());
  assert.deepEqual(v.map((m) => m.id), ['file', 'edit', 'view', 'help']);
  const flat = (items) => items.flatMap((i) => (i.items ? [i, ...flat(i.items)] : [i]));
  const all = v.flatMap((m) => flat(m.items));
  const recent = all.find((i) => i.id === 'file.recent');
  assert.equal(recent.kind, 'submenu');
  assert.deepEqual(recent.items.map((i) => i.label), ['ClaudeClient', 'notes']);
  assert.equal(all.find((i) => i.id === 'view.devMode').checked, false);
  assert.equal(buildMenuView(model(), ctx({ developerMode: true })).flatMap((m) => flat(m.items)).find((i) => i.id === 'view.devMode').checked, true);
  assert.deepEqual(all.filter((i) => i.id && i.id.startsWith('view.theme.')).map((i) => [i.id, i.checked]), [['view.theme.dark', false], ['view.theme.light', false], ['view.theme.gold', true]]);
  assert.equal(all.find((i) => i.id === 'view.devtools'), undefined); // devOnly hidden in a packaged app
  assert.ok(buildMenuView(model(), ctx({ packaged: false })).flatMap((m) => flat(m.items)).find((i) => i.id === 'view.devtools'));
  assert.equal(all.find((i) => i.id === 'file.newProject').accel, 'Ctrl+N');
  // empty recent list -> disabled placeholder, submenu disabled
  const empty = buildMenuView(model([]), ctx()).flatMap((m) => flat(m.items));
  assert.equal(empty.find((i) => i.id === 'file.recent').disabled, true);
  assert.equal(empty.find((i) => i.id === 'file.recent.none').label, 'menu.noRecent');
  for (const m of v) {
    assert.notEqual(m.items[0].kind, 'separator');
    assert.notEqual(m.items[m.items.length - 1].kind, 'separator');
    m.items.forEach((it, i) => { if (it.kind === 'separator') assert.notEqual(m.items[i - 1].kind, 'separator'); });
  }
  assert.equal(labelOf({ label: 'menu.file' }, (k) => k.toUpperCase()), 'MENU.FILE');
  assert.equal(labelOf({ label: 'My menu.file project' }, (k) => 'X'), 'My menu.file project');
});

test('menu: keyboard navigation helpers and key table', () => {
  const items = [{ kind: 'item', label: 'New' }, { kind: 'separator' }, { kind: 'item', label: 'Open', disabled: true }, { kind: 'item', label: 'Save' }, { kind: 'item', label: 'Settings' }];
  assert.equal(moveIndex(items, -1, 1), 0);
  assert.equal(moveIndex(items, 0, 1), 3);
  assert.equal(moveIndex(items, 4, 1), 0);
  assert.equal(moveIndex(items, 0, -1), 4);
  assert.equal(moveIndex(items, -1, -1), 4);
  assert.equal(edgeIndex(items, 'first'), 0);
  assert.equal(edgeIndex(items, 'last'), 4);
  assert.equal(edgeIndex([], 'first'), -1);
  assert.equal(typeAheadIndex(items, 0, 's'), 3);
  assert.equal(typeAheadIndex(items, 3, 's'), 4);
  assert.equal(typeAheadIndex(items, 4, 's'), 3);
  assert.equal(typeAheadIndex(items, 0, 'o'), -1); // disabled items are skipped
  assert.equal(altMnemonic({ altKey: true, key: 'F' }), 'file');
  assert.equal(altMnemonic({ altKey: true, key: 'h' }), 'help');
  assert.equal(altMnemonic({ altKey: true, ctrlKey: true, key: 'f' }), null);
  assert.equal(altMnemonic({ altKey: false, key: 'f' }), null);
  assert.equal(altMnemonic({ altKey: true, key: 'x' }), null);
  assert.equal(keyAction({ level: 'bar' }, 'ArrowRight'), 'next-menu');
  assert.equal(keyAction({ level: 'bar' }, 'ArrowDown'), 'open-menu');
  assert.equal(keyAction({ level: 'bar' }, 'Enter'), 'open-menu');
  assert.equal(keyAction({ level: 'menu' }, 'ArrowDown'), 'next-item');
  assert.equal(keyAction({ level: 'menu' }, 'ArrowRight'), 'next-menu');
  assert.equal(keyAction({ level: 'menu', focusedHasSubmenu: true }, 'ArrowRight'), 'open-sub');
  assert.equal(keyAction({ level: 'menu', focusedHasSubmenu: true }, 'Enter'), 'open-sub');
  assert.equal(keyAction({ level: 'menu' }, 'Enter'), 'activate');
  assert.equal(keyAction({ level: 'menu' }, 'Escape'), 'close');
  assert.equal(keyAction({ level: 'sub' }, 'Escape'), 'close-sub');
  assert.equal(keyAction({ level: 'sub' }, 'ArrowLeft'), 'close-sub');
  assert.equal(keyAction({ level: 'menu' }, 'ArrowLeft'), 'prev-menu');
  assert.equal(keyAction({ level: 'menu' }, 'Home'), 'first-item');
  assert.equal(keyAction({ level: 'menu' }, 'q'), 'typeahead');
  assert.equal(keyAction({ level: 'menu' }, 'Shift'), 'none');
  assert.equal(keyAction({ level: 'menu' }, 'Tab'), 'close-all');
});

test('menu: shortcut groups list every accelerator of the model', () => {
  const view = buildMenuView(model(), ctx({ packaged: false }));
  const groups = shortcutGroups(view);
  assert.deepEqual(groups.map((g) => g.id), ['file', 'edit', 'view', 'help']);
  const withAccel = flattenMenu().filter((i) => i.accelerator).map((i) => i.id).sort();
  assert.deepEqual(groups.flatMap((g) => g.items.map((i) => i.id)).sort(), withAccel);
});

test('i18n: every menu label key used by src/shared/menu.js exists in both languages', () => {
  const flat = (o, p = '', out = {}) => { for (const [k, v] of Object.entries(o)) { const key = p ? p + '.' + k : k; if (v && typeof v === 'object') flat(v, key, out); else out[key] = v; } return out; };
  const fe = flat(en);
  const fs = flat(es);
  const keys = new Set(['menu.noRecent']);
  const walk = (items) => { for (const it of items) { if (it.label) keys.add(it.label); if (it.submenu) walk(it.submenu); } };
  walk(MENU);
  assert.ok(keys.size >= 38, 'expected the full menu, got ' + keys.size);
  for (const k of keys) {
    assert.ok(fe[k], 'en missing ' + k);
    assert.ok(fs[k], 'es missing ' + k);
  }
  for (const k of ['menu.file', 'menu.newProject', 'menu.openFolder', 'menu.openRecent', 'menu.saveState', 'menu.revealProject', 'menu.settings', 'menu.quit', 'menu.edit',
    'menu.undo', 'menu.redo', 'menu.cut', 'menu.copy', 'menu.paste', 'menu.selectAll', 'menu.find', 'menu.attachImage', 'menu.clearHistory', 'menu.view', 'menu.toggleSidebar',
    'menu.toggleArtifacts', 'menu.tasks', 'menu.usage', 'menu.devMode', 'menu.theme', 'menu.themeDark', 'menu.themeLight', 'menu.themeGold', 'menu.zoomIn', 'menu.zoomOut',
    'menu.zoomReset', 'menu.fullscreen', 'menu.devtools', 'menu.help', 'menu.shortcuts', 'menu.docs', 'menu.releases', 'menu.report', 'menu.about']) assert.ok(fe[k] && fs[k], k);
});
