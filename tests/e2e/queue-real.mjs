// Message queue with the REAL claude CLI (a few short turns): a message typed while the agent works waits and is sent automatically when
// the turn ends; "Send now" stops the running turn and sends it immediately. Run: npm run e2e:queue
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, makeChecker, sleep } from './lib.mjs';

const PORT = 9617;
const { check, done } = makeChecker();
const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'flowstate-queue-')));
const proj = join(base, 'queue-project');
mkdirSync(proj, { recursive: true });

let app = null;
const typeAndSend = (text) => app.ev(`const i = document.getElementById('composer-input'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return 1`);
const userTexts = async (pid) => (await app.call(`window.flowstate.history.get(${JSON.stringify(pid)})`)).filter((r) => r.t === 'user').map((r) => r.text);
const resultCount = async (pid) => (await app.call(`window.flowstate.history.get(${JSON.stringify(pid)})`)).filter((r) => r.t === 'event' && r.event.type === 'result').length;
try {
  app = await launch({ profile: join(base, 'profile'), port: PORT });
  await app.ready();
  const p = await app.call(`window.flowstate.projects.add({ name: 'queue-project', path: ${JSON.stringify(proj)}, agent: 'claude', autoCommit: false })`);
  await app.reload();
  await app.ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 1`);
  await app.waitFor(`[...document.querySelectorAll('button, [role=button], a, li')].some((n) => n.textContent.includes('queue-project'))`);
  await app.ev(`[...document.querySelectorAll('button, [role=button], a, li')].find((n) => n.textContent.includes('queue-project')).click(); return 1`);
  await app.waitFor(`!!document.getElementById('composer-input') && !document.getElementById('composer-input').disabled`, 15000);

  // 1) queue: A runs, B waits, B is sent by itself afterwards
  await typeAndSend('Reply with exactly the word ALPHA and nothing else.');
  await app.waitFor(`document.querySelector('.composer').classList.contains('is-running')`, 10000);
  await typeAndSend('Reply with exactly the word BRAVO and nothing else.');
  const bar = await app.waitFor(`(() => { const b = document.querySelector('.queue-bar'); return b && !b.hidden ? b.innerText : ''; })()`, 8000);
  check('a message typed while the agent works shows in the queue bar with Send now', /BRAVO/.test(bar) && /(Send now|Enviar ahora)/.test(bar), bar.slice(0, 160));
  check('the queued message was not sent yet', !(await userTexts(p.id)).some((x) => /BRAVO/.test(x)), JSON.stringify(await userTexts(p.id)));
  let users = [];
  for (let i = 0; i < 120 && users.length < 2; i++) { await sleep(1000); users = await userTexts(p.id); }
  const dbg = users.length === 2 ? '' : await app.ev(`return JSON.stringify((document.querySelector('.chat__list')?.innerText || '').slice(-400)) + ' | q=' + document.querySelector('.queue-bar')?.innerText`);
  check('when the first turn ends the queued message is sent automatically', users.length === 2 && /BRAVO/.test(users[1]), JSON.stringify(users) + ' ' + dbg);
  check('the queue bar is empty afterwards', await app.waitFor(`document.querySelector('.queue-bar').hidden`, 8000));
  let results = 0;
  for (let i = 0; i < 120 && results < 2; i++) { await sleep(1000); results = await resultCount(p.id); }
  check('both turns finished', results >= 2, String(results));

  // 2) Send now: C runs (long), D is queued, "Send now" interrupts C and sends D right away
  await typeAndSend('Count from 1 to 60, one number per line, with a short sentence after each number.');
  await app.waitFor(`document.querySelector('.composer').classList.contains('is-running')`, 10000);
  await sleep(1500);
  await typeAndSend('Reply with exactly the word DELTA and nothing else.');
  await app.waitFor(`(() => { const b = document.querySelector('.queue-bar'); return !!b && !b.hidden; })()`, 8000);
  await app.ev(`[...document.querySelectorAll('.queue-bar button')].find((b) => /Send now|Enviar ahora/.test(b.textContent)).click(); return 1`);
  let u2 = [];
  for (let i = 0; i < 90 && !u2.some((x) => /DELTA/.test(x)); i++) { await sleep(1000); u2 = await userTexts(p.id); }
  check('Send now interrupts the running turn and sends the queued message', u2.some((x) => /DELTA/.test(x)), JSON.stringify(u2.slice(-2)));
  const hist = await app.call(`window.flowstate.history.get(${JSON.stringify(p.id)})`);
  check('the interrupted turn was stopped', hist.some((r) => r.t === 'event' && r.event.type === 'result' && r.event.stopped === true), String(hist.length));
  check('no renderer errors', app.problems.length === 0, app.problems.join(' | ').slice(0, 400));
} catch (e) {
  check('e2e ran without exception', false, e.stack || String(e));
} finally {
  if (app) await app.shutdown();
}
process.exit(done());
