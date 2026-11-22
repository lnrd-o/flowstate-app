// Real-Electron smoke test (no model calls). Run: npm run e2e
// Launches the app with an ISOLATED profile (--user-data-dir) and drives the real preload API over CDP.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { API_SHAPE } from '../../src/shared/ipc.js';

const PORT = 9444;
const root = resolve(new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const electron = join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'flowstate-e2e-')));
const profile = join(base, 'profile');
const proj = join(base, 'project');
mkdirSync(join(proj, 'artifacts'), { recursive: true });
writeFileSync(join(proj, 'artifacts', 'report.md'), '# Report\n\nHello **world**\n');
writeFileSync(join(proj, 'artifacts', 'page.html'), '<h1>hi</h1><script>alert(1)</script>');
writeFileSync(join(proj, 'app.py'), "import streamlit as st\nst.title('x')\n");

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? '  -> ' + detail : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// E2E_EXE=<path to packaged FlowState.exe> tests the built app instead of the dev checkout.
const packaged = process.env.E2E_EXE;
const child = spawn(packaged || electron, [...(packaged ? [] : [root]), `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`], { stdio: 'ignore' });
let ws; let id = 0; const pending = new Map(); const problems = [];

async function connect() {
  for (let i = 0; i < 40; i++) {
    try {
      const t = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((x) => x.type === 'page' && x.url.split('?')[0].endsWith('index.html'));
      if (t) { ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; }); return; }
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error('Electron did not expose a page target');
}
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: `(async()=>{ ${expr} })()`, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
};
const rejects = async (expr) => { try { await ev(expr); return false; } catch { return true; } };

try {
  await connect();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d.result ?? d.error); pending.delete(d.id); }
    else if (d.method === 'Runtime.exceptionThrown') problems.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
    else if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') problems.push(d.params.args.map((a) => a.value ?? a.description).join(' '));
  };
  await send('Runtime.enable');
  await ev('try { await window.flowstate.app.ready(); } catch {} return 1'); // show the window now instead of waiting for the 10 s fallback
  await send('Page.reload'); await sleep(3000);

  // 1. API surface matches the contract
  const shape = await ev(`const a=window.flowstate; return JSON.stringify(Object.fromEntries(Object.keys(a).map(k=>[k, typeof a[k]==='object'?Object.keys(a[k]):'fn'])))`);
  const got = JSON.parse(shape);
  const missing = [];
  for (const [ns, fns] of Object.entries(API_SHAPE)) {
    if (ns === 'subscriptions') { for (const f of fns) if (got[f] !== 'fn') missing.push(f); continue; }
    for (const f of fns) if (!got[ns]?.includes(f)) missing.push(`${ns}.${f}`);
  }
  check('preload API matches API_SHAPE', missing.length === 0, missing.join(', '));

  // 2. settings / health
  const s = JSON.parse(await ev(`return JSON.stringify(await window.flowstate.settings.get())`));
  check('settings defaults', ['en', 'es'].includes(s.language) && s.walkthroughDone === false);
  const h = JSON.parse(await ev(`return JSON.stringify(await window.flowstate.health.check())`));
  check('health has claude/agy/node/git/python/vpn', ['claude', 'agy', 'node', 'git', 'python', 'vpn'].every((k) => k in h));

  // 3. projects
  const p = JSON.parse(await ev(`return JSON.stringify(await window.flowstate.projects.add({name:'e2e', path:${JSON.stringify(proj)}, agent:'claude', mode:'plan', autoCommit:true}))`));
  check('projects.add (+git init)', !!p.id && p.autoCommit === true);
  const git = JSON.parse(await ev(`return JSON.stringify(await window.flowstate.git.status(${JSON.stringify(p.id)}))`));
  check('git repo initialised', git.isRepo === true);

  // 4. files + path guard
  const list = JSON.parse(await ev(`return JSON.stringify(await window.flowstate.files.list(${JSON.stringify(p.id)}, ''))`));
  const names = list.map((f) => f.name);
  check('files.list shows artifacts/ and app.py, hides .git', names.includes('artifacts') && names.includes('app.py') && !names.includes('.git'), names.join(','));
  const md = JSON.parse(await ev(`return JSON.stringify(await window.flowstate.files.read(${JSON.stringify(p.id)}, 'artifacts/report.md'))`));
  check('files.read markdown', md.kind === 'markdown' && md.content.includes('Hello'));
  const html = JSON.parse(await ev(`return JSON.stringify(await window.flowstate.files.read(${JSON.stringify(p.id)}, 'artifacts/page.html'))`));
  check('files.read html', html.kind === 'html');
  for (const bad of ['..\\\\outside.txt', '../outside.txt', 'C:\\\\Windows\\\\win.ini', '\\\\\\\\server\\\\share\\\\x', 'app.py:stream']) {
    check(`path guard rejects ${bad}`, await rejects(`return await window.flowstate.files.read(${JSON.stringify(p.id)}, ${JSON.stringify(bad)})`));
  }
  check('files.open refuses executables', await rejects(`return await window.flowstate.files.open(${JSON.stringify(p.id)}, 'run.bat')`));

  // 5. watcher pushes changes
  await ev(`window.__files=[]; window.flowstate.onFiles(e=>window.__files.push(e)); await window.flowstate.files.watch(${JSON.stringify(p.id)}); return 1`);
  await sleep(500);
  writeFileSync(join(proj, 'artifacts', 'new.txt'), 'x');
  await sleep(1500);
  const fe = JSON.parse(await ev(`return JSON.stringify(window.__files)`));
  check('files watcher emits evFiles', fe.some((e) => e.projectId === p.id && e.changed.some((c) => c.includes('new.txt'))), JSON.stringify(fe));

  // 6. prompts
  const prompts = JSON.parse(await ev(`return JSON.stringify(await window.flowstate.prompts.list())`));
  check('10+ bundled prompts with EN and ES names', prompts.length >= 10 && prompts.every((t) => t.name?.en && t.name?.es), String(prompts.length));
  const first = prompts[0].id;
  const ex = JSON.parse(await ev(`return JSON.stringify(await window.flowstate.prompts.export(${JSON.stringify(p.id)}, ${JSON.stringify(first)}))`));
  check('prompts.export writes .claude/commands (relative path)', existsSync(join(proj, '.claude', 'commands', `${first}.md`)) && !/^[A-Za-z]:/.test(ex.path), ex.path);
  await ev(`return await window.flowstate.prompts.export(${JSON.stringify(p.id)}, ${JSON.stringify(first)})`);
  check('second export keeps a .bak', existsSync(join(proj, '.claude', 'commands', `${first}.md.bak`)) || existsSync(join(proj, '.claude', 'commands', `${first}.bak`)));

  // 7. dashboard / remote / history
  const dash = JSON.parse(await ev(`return JSON.stringify(await window.flowstate.dashboard.status(${JSON.stringify(p.id)}))`));
  check('dashboard.status finds app.py', Array.isArray(dash.apps) && dash.apps.includes('app.py') && dash.running === false, JSON.stringify(dash));
  const rem = JSON.parse(await ev(`return JSON.stringify(await window.flowstate.remote.status(${JSON.stringify(p.id)}))`));
  check('remote.status shape', typeof rem.running === 'boolean');
  const hist = JSON.parse(await ev(`return JSON.stringify(await window.flowstate.history.get(${JSON.stringify(p.id)}))`));
  check('history empty for new project', Array.isArray(hist) && hist.length === 0);
  check('prereq.install rejects unknown id', await rejects(`return await window.flowstate.prereq.install('malware')`));

  // 7b. OPTIONAL real agent turn (costs a few cents of model use): E2E_REAL=1 npm run e2e
  if (process.env.E2E_REAL === '1') {
    const out = JSON.parse(await ev(`
      const api = window.flowstate; const evs = []; const off = api.onAgentEvent((e) => evs.push(e));
      const pid = ${JSON.stringify(p.id)};
      await api.projects.update(pid, { agent: 'agy', mode: 'plan' });
      await api.agent.send({ projectId: pid, text: 'Reply with exactly: pong' });
      const t0 = Date.now();
      while (Date.now() - t0 < 120000 && !evs.some((e) => ['result', 'error'].includes(e.event?.type))) await new Promise((r) => setTimeout(r, 500));
      off();
      const hist = await api.history.get(pid);
      const proj = (await api.projects.list()).find((x) => x.id === pid);
      return JSON.stringify({ types: evs.map((e) => e.event.type), hist: hist.map((h) => h.t + ':' + (h.event?.type || '')), session: !!proj.sessionId });`));
    check('real agy turn streams a result', out.types.includes('result'), out.types.join(','));
    check('history recorded user + text + result', out.hist.includes('user:') && out.hist.includes('event:text') && out.hist.includes('event:result'), out.hist.join(','));
    check('session id persisted for resume', out.session === true);
  }

  // 7c. Phase 7 surface (no model calls): splash gone, models, usage, tasks, menu, deepseek, store
  const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter((x) => x.type === 'page');
  check('only the index.html page remains (splash closed)', pages.length === 1 && pages[0].url.split('?')[0].endsWith('index.html'), pages.map((x) => x.url).join(','));
  const ai = JSON.parse(await ev(`return JSON.stringify(await window.flowstate.app.info())`));
  check('app.info shape', ai.name === 'FlowState' && typeof ai.version === 'string' && typeof ai.userData === 'string');
  const cm = JSON.parse(await ev(`return JSON.stringify(await window.flowstate.models.list('claude'))`));
  check('models.list(claude) static aliases', cm.source === 'static' && cm.models.some((m) => m.id === 'opus') && cm.efforts.length === 5);
  const us = JSON.parse(await ev(`return JSON.stringify(await window.flowstate.usage.get())`));
  check('usage.get shape', typeof us.at === 'number' && us.claude?.windows && us.agy?.today && us.deepseek?.configured === false);
  const tk = JSON.parse(await ev(`return JSON.stringify(await window.flowstate.tasks.list())`));
  check('tasks.list shape', Array.isArray(tk.agents) && Array.isArray(tk.services) && typeof tk.todos === 'object' && Array.isArray(tk.subagents));
  const mm = JSON.parse(await ev(`return JSON.stringify(await window.flowstate.menu.model())`));
  const recent = mm.items[0].submenu.find((i) => i.dynamic === 'recent');
  check('menu.model File/Edit/View/Help + recents', mm.items.map((i) => i.id).join() === 'file,edit,view,help' && recent.submenu.some((r) => r.id === `file.recent:${p.id}`));
  check('deepseek.status default', (await ev(`return (await window.flowstate.deepseek.status()).configured`)) === false);
  const stAll = JSON.parse(await ev(`await window.flowstate.store.save(${JSON.stringify(p.id)}); return JSON.stringify(await window.flowstate.store.status(${JSON.stringify(p.id)}))`));
  check('store writes .flowstate/project.json (gitignored private files)', stAll.hasProject && stAll.gitignored && existsSync(join(proj, '.flowstate', 'project.json')));

  // 8. UI renders the project and themes switch
  await send('Page.reload'); await sleep(3000);
  const ui = JSON.parse(await ev(`await window.flowstate.settings.set({walkthroughDone:true}); await new Promise(r=>setTimeout(r,200)); return JSON.stringify({items:document.querySelectorAll('.nav-item').length, title:document.title})`));
  check('UI renders after reload', ui.items >= 2 && ui.title === 'FlowState');
  for (const theme of ['gold', 'light', 'dark']) {
    await ev(`await window.flowstate.settings.set({theme:${JSON.stringify(theme)}}); return 1`);
    await send('Page.reload'); await sleep(1500);
    check(`theme ${theme} applies`, (await ev(`return document.documentElement.dataset.theme`)) === theme);
  }

  // 9. removal never deletes files
  await ev(`return await window.flowstate.projects.remove(${JSON.stringify(p.id)})`);
  const left = JSON.parse(await ev(`return JSON.stringify(await window.flowstate.projects.list())`));
  check('projects.remove unregisters but keeps files', left.length === 0 && existsSync(join(proj, 'app.py')));

  check('no renderer exceptions / console errors', problems.length === 0, problems.slice(0, 3).join(' | '));
} catch (e) {
  check('smoke run completed', false, e.message);
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  child.kill();
  await sleep(1500);
  try { rmSync(base, { recursive: true, force: true }); } catch { /* temp cleanup best effort */ }
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
