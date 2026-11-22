// Phase 7 real-Electron test (NO model calls): splash boot, window state, models, usage, tasks, menu, project store, DeepSeek.
// Run: npm run e2e:p7   (isolated profiles; E2E_EXE=<packaged exe> tests the built app)
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, makeChecker, sleep } from './lib.mjs';

const PORT = 9602;
const { check, done } = makeChecker();
const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'flowstate-p7-')));
const profileA = join(base, 'profile-a');
const profileB = join(base, 'profile-b');
const proj = join(base, 'My Project (store)');
mkdirSync(proj, { recursive: true });
writeFileSync(join(proj, 'readme.txt'), 'precious');
const J = JSON.stringify;
let app = null;

async function readyAndSettle(a) {
  await a.ev('try { await window.flowstate.app.ready(); } catch {} return 1'); // do not wait for the 10 s fallback
  for (let i = 0; i < 30; i++) {
    const t = await a.targets();
    if (!t.some((x) => x.url.includes('splash.html'))) return t;
    await sleep(200);
  }
  return a.targets();
}

try {
  // ---- 1. boot through the splash ----------------------------------------------------------------------------------------
  app = await launch({ profile: profileA, port: PORT });
  check('splash window was shown during boot', app.seen.splash === true);
  const t1 = await readyAndSettle(app);
  const pages = t1.filter((x) => x.type === 'page');
  check('after app:ready exactly one page remains and it is index.html (splash closed)', pages.length === 1 && pages[0].url.endsWith('index.html'), pages.map((p) => p.url).join(','));
  const info = await app.call('window.flowstate.app.info()');
  check('app.info shape', ['name', 'version', 'electron', 'chrome', 'node', 'platform', 'arch', 'userData', 'packaged'].every((k) => k in info) && info.packaged === Boolean(process.env.E2E_EXE) && info.name === 'FlowState', J(info));
  check('app.info.userData is the isolated profile', info.userData.toLowerCase() === profileA.toLowerCase(), info.userData);

  // ---- 2. models ---------------------------------------------------------------------------------------------------------
  const cm = await app.call(`window.flowstate.models.list('claude')`);
  check('models.list(claude) is static with the aliases', cm.source === 'static' && ['default', 'opus', 'sonnet', 'haiku', 'fable'].every((id) => cm.models.some((m) => m.id === id)) && cm.efforts.join() === 'low,medium,high,xhigh,max', J(cm).slice(0, 200));
  const am = await app.call(`window.flowstate.models.list('agy')`);
  check('models.list(agy) is LIVE from `agy models` (signed in)', am.source === 'live' && !am.error && am.models.length > 0 && am.models.every((m) => m.id && m.name), J(am).slice(0, 300));
  const am2 = Date.now();
  await app.call(`window.flowstate.models.list('agy')`);
  check('second agy list is served from the 60 s cache', Date.now() - am2 < 500);

  // ---- 3. usage / tasks / menu / deepseek ----------------------------------------------------------------------------------
  const us = await app.call('window.flowstate.usage.get()');
  check('usage.get shape', typeof us.at === 'number' && 'five_hour' in us.claude.windows && 'seven_day' in us.claude.windows && us.claude.today.turns === 0 && 'thinkingTokens' in us.agy.today && us.deepseek.configured === false, J(us).slice(0, 300));
  // the background `claude -p /usage` refresh (local, no model call, ~8 s) merges the plan windows
  let us2 = us;
  for (let i = 0; i < 40 && !us2.claude.windows.five_hour; i++) { await sleep(1000); us2 = await app.call('window.flowstate.usage.get()'); }
  check('usage windows merged from the local /usage command', !!us2.claude.windows.five_hour && us2.claude.windows.five_hour.utilization >= 0 && us2.claude.windows.five_hour.resetsAt > Date.now(), J(us2.claude.windows));
  const tk = await app.call('window.flowstate.tasks.list()');
  check('tasks.list shape (idle: no agents, no dashboards)', Array.isArray(tk.agents) && tk.agents.length === 0 && Array.isArray(tk.services) && !tk.services.some((s) => s.kind === 'dashboard') && typeof tk.todos === 'object' && Array.isArray(tk.subagents), J(tk));
  check('tasks.stop with an unknown id answers {ok:false}', (await app.call(`window.flowstate.tasks.stop({kind:'dashboard', id:'nope'})`)).ok === false);
  const ds = await app.call('window.flowstate.deepseek.status()');
  check('deepseek.status -> configured:false by default', ds.configured === false, J(ds));
  check('deepseek.setKey rejects an invalid short key', await app.ev(`try { await window.flowstate.deepseek.setKey('abc'); return false } catch { return true }`) === true);
  const sk = await app.call(`window.flowstate.deepseek.setKey('sk-e2e-not-a-real-key-123456')`);
  const keyFile = join(profileA, 'deepseek.key');
  check('deepseek.setKey stores only an encrypted key (or reports encryption-unavailable and stores nothing)',
    (sk.ok === true && existsSync(keyFile) && !readFileSync(keyFile, 'utf8').includes('sk-e2e-not-a-real-key') && !JSON.stringify(sk).includes('sk-e2e')) || (sk.ok === false && sk.error === 'encryption-unavailable' && !existsSync(keyFile)), J(sk));
  check('deepseek.status never returns the key', !JSON.stringify(await app.call('window.flowstate.deepseek.status(true)')).includes('sk-e2e'));
  await app.call(`window.flowstate.deepseek.setKey(null)`);
  check('deepseek.setKey(null) removes the key file', !existsSync(keyFile));

  // ---- 4. project store: create, configure, quit, FRESH profile, reload ----------------------------------------------------
  const p = await app.call(`window.flowstate.projects.add({name:'Store Test', path:${J(proj)}, agent:'agy', mode:'plan'})`);
  check('projects.add registers the folder', !!p.id && p.loadedFromFolder === undefined);
  const up = await app.call(`window.flowstate.projects.update(${J(p.id)}, {model:'claude-sonnet-4-6', effort:'high', developerMode:false, sessionId:'sess-e2e-1'})`);
  check('projects.update accepts model/effort/developerMode', up.model === 'claude-sonnet-4-6' && up.effort === 'high' && up.developerMode === false);
  check('projects.update rejects bad model / effort', await app.ev(`try { await window.flowstate.projects.update(${J(p.id)}, {model:'bad model'}); return false } catch { return true }`) === true
    && await app.ev(`try { await window.flowstate.projects.update(${J(p.id)}, {effort:'ultra'}); return false } catch { return true }`) === true);
  await app.ev(`await window.flowstate.ui.projectSet(${J(p.id)}, {draft:'unsent text', artifactsTab:'files'}); return 1`);
  await app.ev(`await window.flowstate.ui.set({e2eGlobal:{open:true}}); return 1`);
  const dir = join(proj, '.flowstate');
  const sv = await app.call(`window.flowstate.store.save(${J(p.id)})`);
  check('store.save flushes project.json + state.json', sv.ok === true && sv.files.includes('project.json') && sv.files.includes('state.json'), J(sv));
  writeFileSync(join(dir, 'history.jsonl'), `${J({ ts: 1, t: 'user', text: 'a previous question' })}\n${J({ ts: 2, t: 'event', event: { type: 'text', text: 'a previous answer' } })}\n`); // folder history (as written by earlier turns)
  const pj = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
  check('project.json content', pj.version === 1 && pj.name === 'Store Test' && pj.agent === 'agy' && pj.model === 'claude-sonnet-4-6' && pj.effort === 'high' && pj.developerMode === false, J(pj));
  const st = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
  check('state.json content (sessions per agent, ui)', st.sessions.agy === 'sess-e2e-1' && st.ui.draft === 'unsent text' && st.counters.turns === 0, J(st));
  check('.gitignore ignores the private files', readFileSync(join(dir, '.gitignore'), 'utf8') === 'state.json\nhistory.jsonl\nattachments/\n');
  const ss = await app.call(`window.flowstate.store.status(${J(p.id)})`);
  check('store.status', ss.exists && ss.hasProject && ss.hasState && ss.gitignored && ss.historyBytes > 0 && ss.dir.toLowerCase() === dir.toLowerCase(), J(ss));
  const mm = await app.call('window.flowstate.menu.model()');
  const names = mm.items.map((i) => i.id);
  const recent = mm.items[0].submenu.find((i) => i.dynamic === 'recent');
  check('menu.model has File/Edit/View/Help with the new project as a recent', names.join() === 'file,edit,view,help' && recent.submenu.some((r) => r.id === `file.recent:${p.id}` && r.label === 'Store Test'), J(recent));
  check('menu.model state', typeof mm.state.developerMode === 'boolean' && mm.state.platform === process.platform && mm.state.packaged === Boolean(process.env.E2E_EXE), J(mm.state));
  check('menu.invoke ignores renderer-handled ids and bad ids', (await app.call(`window.flowstate.menu.invoke('file.newProject')`)).ok === false && await app.ev(`try { await window.flowstate.menu.invoke('../x'); return false } catch { return true }`) === true);

  // window state: maximize through the real window action, then a graceful quit saves it
  const before = await app.call('window.flowstate.window.info()');
  await app.ev(`await window.flowstate.window.action('toggle-maximize'); return 1`);
  await sleep(1500);
  const quitOk = await app.quitGracefully();
  check('menu file.quit runs the quit flow and the app exits by itself', quitOk === true);
  const wsFile = join(profileA, 'window-state.json');
  const wsv = existsSync(wsFile) ? JSON.parse(readFileSync(wsFile, 'utf8')) : null;
  check('window-state.json saved on close (maximized flag + normal bounds)', !!wsv && wsv.maximized === !before.maximized && wsv.width >= 1000 && wsv.height >= 650, J({ before, wsv }));
  await app.shutdown();

  // same profile again: maximized state restored, UI state restored
  app = await launch({ profile: profileA, port: PORT });
  await readyAndSettle(app);
  await sleep(500);
  const after = await app.call('window.flowstate.window.info()');
  check('maximized state restored after a restart', after.maximized === wsv.maximized, J(after));
  check('global UI state restored after a restart', (await app.call('window.flowstate.ui.get()')).e2eGlobal?.open === true);
  await app.quitGracefully();
  await app.shutdown();

  // saved bounds are restored on a profile that has a window-state.json (seeded here: position + size)
  mkdirSync(profileB, { recursive: true });
  writeFileSync(join(profileB, 'window-state.json'), J({ x: 60, y: 50, width: 1111, height: 777, maximized: false }));
  // FRESH profile (a "new machine"): add the same folder -> everything auto-loads from .flowstate
  app = await launch({ profile: profileB, port: PORT });
  await readyAndSettle(app);
  const dims = await app.call('({w: window.outerWidth, h: window.outerHeight})');
  check('seeded window bounds restored (size)', Math.abs(dims.w - 1111) <= 24 && Math.abs(dims.h - 777) <= 48, J(dims));
  check('fresh profile starts with no projects', (await app.call('window.flowstate.projects.list()')).length === 0);
  const q = await app.call(`window.flowstate.projects.add({path:${J(proj)}})`);
  check('projects.add on a folder with .flowstate auto-loads project.json (loadedFromFolder)', q.loadedFromFolder === true && q.name === 'Store Test' && q.agent === 'agy' && q.mode === 'plan' && q.model === 'claude-sonnet-4-6' && q.effort === 'high' && q.developerMode === false, J(q));
  check('session id auto-loaded from state.json', q.sessionId === 'sess-e2e-1', J(q));
  const hist = await app.call(`window.flowstate.history.get(${J(q.id)})`);
  check('history auto-loaded from the folder', hist.length === 2 && hist[0].text === 'a previous question', J(hist));
  const ui = await app.call(`window.flowstate.ui.projectGet(${J(q.id)})`);
  check('per-project UI state auto-loaded', ui.draft === 'unsent text' && ui.artifactsTab === 'files', J(ui));
  const mt = await app.call(`window.flowstate.method.list(${J(q.id)})`);
  check('method.list(projectId) works (bundled + user + project)', Array.isArray(mt) && mt.length > 0);

  // clear history, then clear all
  await app.ev(`await window.flowstate.store.clear(${J(q.id)}, 'history'); return 1`);
  check('store.clear(history) empties the history only', (await app.call(`window.flowstate.history.get(${J(q.id)})`)).length === 0 && existsSync(join(dir, 'project.json')));
  await app.ev(`await window.flowstate.store.clear(${J(q.id)}, 'all'); return 1`);
  check('store.clear(all) removes <project>/.flowstate and keeps the project files', !existsSync(dir) && readFileSync(join(proj, 'readme.txt'), 'utf8') === 'precious');
  check('the registry entry stays after clear(all)', (await app.call('window.flowstate.projects.list()')).some((x) => x.id === q.id));
  check('store.clear rejects an unknown scope', await app.ev(`try { await window.flowstate.store.clear(${J(q.id)}, 'everything'); return false } catch { return true }`) === true);
  await sleep(800);
  check('store.clear(all) is not undone by a pending write', !existsSync(dir));
  check('no renderer exceptions in the Phase 7 flows', app.problems.length === 0, app.problems.slice(0, 3).join(' | '));
} catch (e) {
  check('phase7 run completed', false, e.stack || e.message);
} finally {
  try { await app?.shutdown(); } catch { /* ignore */ }
  await sleep(800);
  try { rmSync(base, { recursive: true, force: true }); } catch { /* temp cleanup best effort */ }
}
process.exit(done());
