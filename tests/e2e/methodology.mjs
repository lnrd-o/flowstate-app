// Real-Electron methodology test with REAL agy turns (plan mode, no file writes; a few cents of model use).
// Covers: record from history -> save -> run on a NEW folder (ask-user, prompt, condition branches, checkpoint,
// command confirmation, artifact warn, git-commit), checkpoint reject, deny-list, stop, one-run-per-project.
// Run: npm run e2e:method   (isolated profile; E2E_EXE=<packaged exe> tests the built app)
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, rmSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PORT = 9445;
const root = resolve(new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'flowstate-meth-')));
const dirA = join(base, 'source-project'); const dirB = join(base, 'new-project');
mkdirSync(dirA); mkdirSync(dirB);
const shotDir = process.env.SHOT_DIR;

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? '  -> ' + detail : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const packaged = process.env.E2E_EXE;
const child = spawn(packaged || join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
  [...(packaged ? [] : [root]), `--user-data-dir=${join(base, 'profile')}`, `--remote-debugging-port=${PORT}`], { stdio: process.env.E2E_LOG ? 'inherit' : 'ignore' });
child.on('exit', (code) => { if (!process.env.E2E_QUIET_EXIT) console.log(`[electron exited code=${code}]`); });
let ws; let id = 0; const pending = new Map(); const problems = [];
async function connect() {
  for (let i = 0; i < 40; i++) {
    try {
      const t = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((x) => x.type === 'page' && x.url.split('?')[0].endsWith('index.html'));
      if (t) { ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; }); return; }
    } catch { /* not up */ }
    await sleep(500);
  }
  throw new Error('no page target');
}
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: `(async()=>{ ${expr} })()`, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
};
const J = (v) => JSON.stringify(v);
const call = async (expr) => JSON.parse(await ev(`return JSON.stringify(await (${expr}))`));
const rejects = async (expr) => { try { await ev(`return await (${expr})`); return false; } catch (e) { return e.message; } };
const shot = async (name) => { if (!shotDir) return; const s = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(shotDir, `${name}.png`), Buffer.from(s.data, 'base64')); };

/** Drive a run: answer prompts as scripted until it ends. script = { askAnswer, checkpoint:true|false, command:true|false } */
async function drive(projectId, script, timeoutMs = 240000) {
  const t0 = Date.now(); const seen = [];
  while (Date.now() - t0 < timeoutMs) {
    const st = await call(`window.flowstate.method.runState(${J(projectId)})`);
    if (st && st.waiting) {
      const w = st.waiting; const key = `${w.nodeId}:${w.kind}`;
      if (!seen.includes(key)) {
        seen.push(key);
        if (w.kind === 'ask-user') await ev(`return await window.flowstate.method.respond(${J(st.runId)}, ${J(w.nodeId)}, {answer:${J(script.askAnswer ?? 'alpha')}})`);
        else if (w.kind === 'checkpoint') await ev(`return await window.flowstate.method.respond(${J(st.runId)}, ${J(w.nodeId)}, {approve:${script.checkpoint !== false}})`);
        else if (w.kind === 'command-confirm') await ev(`return await window.flowstate.method.respond(${J(st.runId)}, ${J(w.nodeId)}, {approve:${script.command !== false}})`);
      }
    }
    if (st && ['done', 'error', 'stopped'].includes(st.status)) return { st, seen };
    await sleep(400);
  }
  throw new Error('run timed out');
}

const turn = async (projectId, text) => call(`(async()=>{
  const evs=[]; const off=window.flowstate.onAgentEvent(e=>evs.push(e));
  await window.flowstate.agent.send({projectId:${J(projectId)}, text:${J(text)}});
  const t0=Date.now(); while(Date.now()-t0<120000 && !evs.some(e=>['result','error'].includes(e.event?.type))) await new Promise(r=>setTimeout(r,400));
  off(); return evs.map(e=>e.event.type);
})()`);

try {
  await connect();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d.result ?? d.error); pending.delete(d.id); }
    else if (d.method === 'Runtime.exceptionThrown') problems.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
    else if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') problems.push(d.params.args.map((a) => a.value ?? a.description).join(' '));
  };
  await send('Runtime.enable');
  await ev('try { await window.flowstate.app.ready(); } catch {} return 1'); // show the window now instead of waiting for the fallback
  await send('Page.reload'); await sleep(3000);
  await ev('await window.flowstate.settings.set({walkthroughDone:true}); return 1');

  // ---- bundled methodologies ----
  const list = await call('window.flowstate.method.list()');
  check('5 bundled methodologies listed', list.filter((m) => m.source === 'bundled').length >= 5, J(list.map((m) => m.id)));
  const b = await call(`window.flowstate.method.get('bugfix-flow')`);
  check('bundled get returns graph + bilingual names', b.nodes.length >= 4 && b.name.en && b.name.es);

  // ---- record from a real session ----
  const A = await call(`window.flowstate.projects.add({name:'Source Project', path:${J(dirA)}, agent:'agy', mode:'plan', autoCommit:true})`);
  check('record: nothing to record on empty history', /nothing|record/i.test(await rejects(`window.flowstate.method.record(${J(A.id)}, {name:'x'})`)));
  const t1 = await turn(A.id, 'Reply with exactly: step one for Source Project');
  const t2 = await turn(A.id, 'Reply with exactly: step two');
  check('real agy turns completed', t1.includes('result') && t2.includes('result'), J([t1, t2]));
  const draft = await call(`window.flowstate.method.record(${J(A.id)}, {name:'Recorded demo'})`);
  check('recorded draft: 2 prompt nodes chained', draft.nodes.filter((n) => n.type === 'prompt').length === 2 && draft.edges.length >= 1, J(draft.nodes.map((n) => n.type)));
  check('recorded draft: project name parameterised', draft.nodes.some((n) => n.text.includes('{{projectName}}')) && !draft.nodes.some((n) => /Source Project/i.test(n.text)), J(draft.nodes.map((n) => n.text)));
  check('recorded draft: source=recorded, id valid', draft.source === 'recorded' && /^[a-z0-9-]+$/.test(draft.id));
  const saved = await call(`window.flowstate.method.save(${J({ ...draft, id: 'recorded-demo' })})`);
  check('saved recorded draft as user methodology', saved.source === 'user' && (await call('window.flowstate.method.list()')).some((m) => m.id === 'recorded-demo'));

  // ---- invalid input is rejected ----
  const bad = await rejects(`window.flowstate.method.save({id:'bad id', version:1, name:{en:'x'}, nodes:[], edges:[]})`);
  check('invalid methodology rejected with reasons', typeof bad === 'string' && /id|nodes/i.test(bad), String(bad));

  // ---- a richer methodology with branches, run on a NEW folder ----
  const rich = {
    id: 'e2e-rich', version: 1, name: { en: 'E2E rich', es: 'E2E completo' }, description: { en: 'test', es: 'prueba' },
    vars: [{ key: 'topic', type: 'text', label: { en: 'Topic', es: 'Tema' } }],
    nodes: [
      { id: 'n1', type: 'ask-user', title: 'Topic', question: 'Which topic?', saveAs: 'topic' },
      { id: 'n2', type: 'prompt', title: 'Ask agent', text: 'Reply with exactly: ok {{topic}} in {{projectName}}', agent: 'agy', mode: 'plan' },
      { id: 'n3', type: 'condition', title: 'Alpha?', var: 'topic', equals: 'alpha' },
      { id: 'n4', type: 'checkpoint', title: 'Review', message: 'Looks right?' },
      { id: 'n5', type: 'command', title: 'Run node', exe: 'node', args: ['-e', 'console.log(40+2)'] },
      { id: 'n6', type: 'artifact', title: 'Report exists', path: 'artifacts/missing.md' },
      { id: 'n7', type: 'git-commit', title: 'Commit', message: 'e2e methodology' },
    ],
    edges: [
      { from: 'n1', to: 'n2' }, { from: 'n2', to: 'n3' }, { from: 'n3', to: 'n4', label: 'yes' }, { from: 'n3', to: 'n5', label: 'no' },
      { from: 'n4', to: 'n6' }, { from: 'n5', to: 'n6' }, { from: 'n6', to: 'n7' },
    ],
  };
  await call(`window.flowstate.method.save(${J(rich)})`);
  const B = await call(`window.flowstate.projects.add({name:'New Project', path:${J(dirB)}, agent:'claude', mode:'default', autoCommit:true})`);

  // run 1: alpha -> checkpoint approve
  const r1 = await call(`window.flowstate.method.run(${J(B.id)}, 'e2e-rich', {})`);
  check('method.run returns runId', !!r1.runId);
  check('second concurrent run rejected', !!(await rejects(`window.flowstate.method.run(${J(B.id)}, 'e2e-rich', {})`)));
  const run1 = await drive(B.id, { askAnswer: 'alpha', checkpoint: true });
  const s1 = run1.st.nodes;
  check('run 1 finished (done)', run1.st.status === 'done', `${run1.st.status} ${run1.st.error ?? ''}`);
  check('run 1: ask-user answer stored', run1.st.vars.topic === 'alpha');
  check('run 1: real prompt node done', s1.n2?.state === 'done', J(s1.n2));
  check('run 1: alpha branch took checkpoint, skipped command', s1.n4?.state === 'done' && ['skipped', 'pending'].includes(s1.n5?.state), J({ n4: s1.n4, n5: s1.n5 }));
  check('run 1: missing artifact is a warning, run continued', s1.n6?.state === 'warn' && s1.n7?.state === 'done', J({ n6: s1.n6, n7: s1.n7 }));
  const hist = await call(`window.flowstate.history.get(${J(B.id)})`);
  check('run prompt used {{projectName}} substitution in history', hist.some((h) => h.t === 'user' && h.text.includes('New Project')), J(hist.slice(0, 2)));
  await shot('run-done');

  // run 2: beta -> command confirmation path
  await call(`window.flowstate.method.run(${J(B.id)}, 'e2e-rich', {})`);
  const run2 = await drive(B.id, { askAnswer: 'beta', command: true });
  check('run 2 (beta) done via command branch', run2.st.status === 'done' && run2.st.nodes.n5?.state === 'done' && run2.seen.some((k) => k.endsWith('command-confirm')), `${run2.st.status} ${J(run2.st.nodes.n5)}`);
  check('run 2: checkpoint branch skipped', ['skipped', 'pending'].includes(run2.st.nodes.n4?.state));

  // ---- safety: reject checkpoint, deny command, deny-list ----
  const small = (idx, mid) => ({ id: idx, version: 1, name: { en: idx }, vars: [], nodes: mid, edges: mid.slice(1).map((n, i) => ({ from: mid[i].id, to: n.id })) });
  await call(`window.flowstate.method.save(${J(small('e2e-reject', [
    { id: 'a', type: 'checkpoint', title: 'Gate', message: 'Proceed?' }, { id: 'b', type: 'git-commit', title: 'Commit', message: 'should not run' }]))})`);
  await call(`window.flowstate.method.run(${J(B.id)}, 'e2e-reject', {})`);
  const rej = await drive(B.id, { checkpoint: false });
  check('checkpoint rejected -> run stopped, next node not executed', rej.st.status === 'stopped' && rej.st.nodes.b?.state !== 'done', `${rej.st.status} ${J(rej.st.nodes)}`);

  await call(`window.flowstate.method.save(${J(small('e2e-deny', [{ id: 'a', type: 'command', title: 'Shell', exe: 'powershell', args: ['-c', 'echo hi'] }]))})`);
  let denied = false; let denyDetail = '';
  try {
    await call(`window.flowstate.method.run(${J(B.id)}, 'e2e-deny', {})`);
    const d = await drive(B.id, { command: true }, 30000);
    denied = d.st.status === 'error' || d.st.nodes.a?.state === 'error'; denyDetail = J(d.st);
  } catch (e) { denied = /deny|not allowed|refus|shell/i.test(e.message); denyDetail = e.message; }
  check('deny-list blocks powershell command node', denied, denyDetail);

  await call(`window.flowstate.method.save(${J(small('e2e-stop', [
    { id: 'a', type: 'ask-user', title: 'Wait', question: 'Answer me', saveAs: 'x' }, { id: 'b', type: 'git-commit', title: 'Commit', message: 'no' }]))})`);
  const r5 = await call(`window.flowstate.method.run(${J(B.id)}, 'e2e-stop', {})`);
  await sleep(800);
  const waiting = await call(`window.flowstate.method.runState(${J(B.id)})`);
  check('run waits at ask-user', waiting.status === 'waiting' && waiting.waiting?.kind === 'ask-user', J(waiting));
  await shot('run-waiting');
  await ev(`return await window.flowstate.method.stop(${J(r5.runId)})`); await sleep(600);
  check('stop ends the run', (await call(`window.flowstate.method.runState(${J(B.id)})`)).status === 'stopped');

  // ---- persistence + files untouched ----
  check('last run state persisted for the project', (await call(`window.flowstate.method.runState(${J(B.id)})`)) !== null);
  check('user methodologies delete; bundled cannot be deleted', !(await rejects(`window.flowstate.method.delete('e2e-stop')`)) === true && !!(await rejects(`window.flowstate.method.delete('bugfix-flow')`)));

  // ---- UI: look at the real app (after a reload the UI re-reads projects, methodologies and the last run) ----
  await call(`window.flowstate.method.run(${J(B.id)}, 'e2e-reject', {})`); // leaves a run WAITING at a checkpoint
  await sleep(600);
  await send('Page.reload'); await sleep(3500);
  const nav = await ev(`const el=[...document.querySelectorAll('.nav-item')].find(e=>/method/i.test(e.textContent)); el?.click(); await new Promise(r=>setTimeout(r,800)); return [...document.querySelectorAll('button')].filter(b=>b.textContent.trim()==='Run').length`);
  check('Methodologies view lists runnable items in the real UI', nav >= 5, String(nav));
  await shot('methodologies-list');
  const run = await ev(`const el=[...document.querySelectorAll('.nav-item')].find(e=>/New Project/.test(e.textContent)); el?.click(); await new Promise(r=>setTimeout(r,1200)); return document.body.innerText`);
  check('run view restored for the project with a waiting card', /Proceed\?|Gate/.test(run), run.slice(0, 200).replace(/\s+/g, ' '));
  await shot('run-view-restored');
  await ev(`[...document.querySelectorAll('.nav-item')].find(e=>/Source Project/.test(e.textContent))?.click(); await new Promise(r=>setTimeout(r,800)); return 1`);
  check('no "applies changes without asking" banner for an agy project in Plan mode', !/without asking/i.test(await ev(`return document.body.innerText`)));
  await call(`window.flowstate.projects.update(${J(A.id)}, {mode:'acceptEdits'})`);
  await send('Page.reload'); await sleep(3000);
  await ev(`[...document.querySelectorAll('.nav-item')].find(e=>/Source Project/.test(e.textContent))?.click(); await new Promise(r=>setTimeout(r,800)); return 1`);
  check('banner appears for agy in Accept edits mode', /without asking/i.test(await ev(`return document.body.innerText`)));
  await shot('agy-accept-edits-banner');
  await ev(`const rs = await window.flowstate.method.runState(${J(B.id)}); if (rs) await window.flowstate.method.stop(rs.runId); return 1`);
  check('no renderer exceptions / console errors', problems.length === 0, problems.slice(0, 3).join(' | '));
} catch (e) {
  check('methodology e2e completed', false, e.stack || e.message);
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  child.kill(); await sleep(1500);
  try { rmSync(base, { recursive: true, force: true }); } catch { /* best effort */ }
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
