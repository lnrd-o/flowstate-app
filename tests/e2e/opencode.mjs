// OpenCode in the real Electron app (needs opencode installed; NO model calls): detection, sign-in status, the in-app sign-in
// terminal running `opencode auth login`, and the model list. Run: npm run e2e:opencode   (E2E_EXE=<packaged exe> for the build)
import fs, { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, makeChecker, sleep } from './lib.mjs';

const PORT = 9613;
const { check, done } = makeChecker();
const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'flowstate-oc-')));
const proj = join(base, 'oc-project');
mkdirSync(proj, { recursive: true });

let app = null;
try {
  app = await launch({ profile: join(base, 'profile'), port: PORT });
  await app.ready();
  const hc = await app.call('window.flowstate.health.check()');
  check('health finds opencode (desktop app CLI included)', hc.opencode && hc.opencode.found === true, JSON.stringify(hc.opencode));
  check('health reports opencode version and sign-in', /\d+\.\d+/.test(hc.opencode.version || '') && hc.opencode.loggedIn === true, JSON.stringify(hc.opencode));
  const st = await app.call('window.flowstate.login.status()');
  check('login.status: opencode signed in', st.opencode && st.opencode.loggedIn === true, JSON.stringify(st));

  const p = await app.call(`window.flowstate.projects.add({ name: 'oc-project', path: ${JSON.stringify(proj)}, agent: 'opencode', autoCommit: false })`);
  check('project with agent opencode', p.agent === 'opencode');
  const models = await app.call(`window.flowstate.models.list('opencode', { force: true })`);
  check('opencode models listed and grouped by provider', Array.isArray(models.models) && models.models.length > 0 && models.models.every((m) => /^opencode:/.test(m.group)), JSON.stringify(models).slice(0, 300));

  // One real turn (only with E2E_OPENCODE_MODEL, e.g. opencode-go/glm-5.3-flash, so CI never spends credits)
  const model = process.env.E2E_OPENCODE_MODEL;
  if (model) {
    await app.call(`window.flowstate.projects.update(${JSON.stringify(p.id)}, { model: ${JSON.stringify(model)} })`);
    await app.call(`window.flowstate.agent.send({ projectId: ${JSON.stringify(p.id)}, text: 'Create hi.txt containing hola, then reply OK' })`);
    let recs = [];
    for (let i = 0; i < 90 && !recs.some((r) => r.t === 'event' && (r.event.type === 'result' || r.event.type === 'error')); i++) { await sleep(1000); recs = await app.call(`window.flowstate.history.get(${JSON.stringify(p.id)})`); }
    const types = recs.filter((r) => r.t === 'event').map((r) => r.event.type);
    check('real opencode turn: tool use, text and a closing result', types.includes('tool-use') && types.includes('result') && !types.includes('error'), types.join(','));
    const fc = recs.filter((r) => r.t === 'event' && r.event.type === 'file-change').map((r) => r.event.path);
    check('turn wrote the file and a file-change card', fc.length > 0 && fs.existsSync(join(proj, 'hi.txt')), JSON.stringify(fc) + ' exists=' + fs.existsSync(join(proj, 'hi.txt')) + ' ' + fs.readdirSync(proj).join(','));
    let running = true;
    for (let i = 0; i < 20 && running; i++) { await sleep(500); running = (await app.call(`window.flowstate.agent.status(${JSON.stringify(p.id)})`)).running; }
    check('agent is idle after the turn', running === false);
    const pj = (await app.call('window.flowstate.projects.list()')).find((x) => x.id === p.id);
    check('opencode session id saved for the next turn', /^ses_/.test(pj.sessionId || ''), String(pj.sessionId));
  }

  // Sign-in dialog: OpenCode tab + terminal with `opencode auth login`
  await app.reload();
  await app.ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 1`);
  await sleep(300);
  await app.ev(`document.querySelector('.settings-btn').click(); return 1`);
  let btn = false;
  for (let i = 0; i < 20 && !btn; i++) { await sleep(250); btn = await app.ev(`return !!document.getElementById('set-src-opencode')`); }
  check('Settings > Sources lists OpenCode', btn === true);
  let clicked = false;
  for (let i = 0; i < 40 && !clicked; i++) {
    await sleep(250);
    clicked = await app.ev(`const row = document.getElementById('set-src-opencode')?.closest('.list-row'); const b = row && [...row.querySelectorAll('button')].find((x) => /Sign in|Iniciar|provider|proveedor/i.test(x.textContent)); if (b) b.click(); return !!b`);
  }
  check('Sources row has an OpenCode sign-in button', clicked === true, await app.ev(`return (document.getElementById('set-src-opencode')?.closest('.list-row')?.innerText || 'no row') + ' | modals: ' + document.querySelectorAll('.modal').length`));
  let tab = false;
  for (let i = 0; i < 20 && !tab; i++) { await sleep(250); tab = await app.ev(`const t = document.getElementById('login-tab-opencode'); return !!t && t.getAttribute('aria-selected') === 'true'`); }
  check('sign-in dialog opens on the OpenCode tab', tab === true);
  await app.waitFor(`[...document.querySelectorAll('.modal--login .login__pane button')].some((b) => !b.closest('[hidden]') && b.offsetParent)`, 15000);
  await app.ev(`[...document.querySelectorAll('.modal--login .login__pane button')].find((b) => !b.closest('[hidden]') && b.offsetParent).click(); return 1`);
  let text = '';
  for (let i = 0; i < 40 && !/provider|Anthropic|OpenCode|Select|login/i.test(text); i++) {
    await sleep(500);
    text = await app.ev(`return document.querySelector('.modal--login .login-term')?.innerText || ''`);
  }
  check('terminal shows the opencode auth login screen', /provider|Anthropic|OpenCode|Select|login/i.test(text), text.slice(0, 300));
  await app.ev(`[...document.querySelectorAll('.modal--login .login__foot .btn')].pop().click(); return 1`);
  await sleep(800);
  check('cancel closes the sign-in dialog', await app.ev(`return !document.querySelector('.modal--login')`));
  check('no renderer errors', app.problems.length === 0, app.problems.join(' | ').slice(0, 400));
} catch (e) {
  check('e2e ran without exception', false, e.stack || String(e));
} finally {
  if (app) await app.shutdown();
}
process.exit(done());
