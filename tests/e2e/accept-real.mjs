// "Needs your OK" with the REAL claude CLI (one short turn that gets blocked, then Accept all): the approval bar shows what is waiting,
// "Accept all" lets the blocked action run, plus the pay-as-you-go model confirmation. Run: npm run e2e:accept
import { mkdtempSync, mkdirSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, makeChecker, sleep } from './lib.mjs';

const PORT = 9619;
const { check, done } = makeChecker();
const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'flowstate-accept-')));
const proj = join(base, 'accept-project');
mkdirSync(proj, { recursive: true });

let app = null;
const send = (text) => app.ev(`const i = document.getElementById('composer-input'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return 1`);
try {
  app = await launch({ profile: join(base, 'profile'), port: PORT });
  await app.ready();
  const p = await app.call(`window.flowstate.projects.add({ name: 'accept-project', path: ${JSON.stringify(proj)}, agent: 'claude', mode: 'default', autoCommit: false })`);
  await app.reload();
  await app.ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 1`);
  await app.waitFor(`[...document.querySelectorAll('button, [role=button], a, li')].some((n) => n.textContent.includes('accept-project'))`);
  await app.ev(`[...document.querySelectorAll('button, [role=button], a, li')].find((n) => n.textContent.includes('accept-project')).click(); return 1`);
  await app.waitFor(`!!document.getElementById('composer-input') && !document.getElementById('composer-input').disabled`, 15000);

  // policy chip: what Claude in "default" mode asks about
  const chip = await app.ev(`const c = document.querySelector('.policy-chip'); return c && !c.hidden ? c.className + ' | ' + c.textContent + ' | ' + c.title : ''`);
  check('the policy chip says Claude asks first (green)', /policy-chip--green/.test(chip) && /(Asks first|Pregunta antes)/.test(chip), chip);

  // a blocked action -> approval bar -> Accept all
  await send('Create a file named hi.txt containing the word hola, using your Write tool. Do not ask me anything.');
  const bar = await app.waitFor(`(() => { const b = document.querySelector('.approval-bar'); return b && !b.hidden ? b.innerText : ''; })()`, 120000);
  check('the approval bar shows that Claude needs your OK, with Accept all and Review', /(needs your OK|necesita tu OK)/.test(bar) && /(Accept all|Aceptar todo)/.test(bar) && /(Review|Revisar)/.test(bar), bar.slice(0, 200));
  check('nothing was written before the OK', !existsSync(join(proj, 'hi.txt')));
  const cardBtn = await app.ev(`const b = document.querySelector('.approval-card .btn--primary'); return b ? b.textContent : ''`);
  check('the approval card is there too', !!cardBtn, cardBtn);
  await app.ev(`document.querySelector('.approval-bar [data-accept-all]').click(); return 1`);
  // Claude sometimes writes the file with a shell redirect, which cannot be allowed one action at a time: then "Accept all" switches
  // the project to Auto-accept and asks for the risk confirmation first. Confirm it like a user would.
  for (let i = 0; i < 150 && !existsSync(join(proj, 'hi.txt')); i++) {
    await app.ev(`const m = [...document.querySelectorAll('.modal')].pop(); if (m && !m.querySelector('.settings-form, .wizard, .wt__content') ) { const b = [...m.querySelectorAll('.dialog__footer .btn')].pop(); if (b && /Auto|auto|Aceptar|Accept|Switch|Cambiar|Continue|Continuar/.test(m.innerText)) b.click(); } return 1`).catch(() => {});
    await sleep(1000);
  }
  check('Accept all lets the blocked action run (hi.txt was created)', existsSync(join(proj, 'hi.txt')) && /hola/i.test(readFileSync(join(proj, 'hi.txt'), 'utf8')));
  check('the approval bar goes away afterwards', await app.waitFor(`(() => { const b = document.querySelector('.approval-bar'); return !b || b.hidden; })()`, 120000));

  // pay-as-you-go model: needs an explicit OK before the message is sent
  const projZ = join(base, 'zen-project');
  mkdirSync(projZ, { recursive: true });
  const pz = await app.call(`window.flowstate.projects.add({ name: 'zen-project', path: ${JSON.stringify(projZ)}, agent: 'opencode', model: 'opencode/beam-free', autoCommit: false })`);
  await app.reload();
  await app.ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 1`);
  await app.waitFor(`[...document.querySelectorAll('button, [role=button], a, li')].some((n) => n.textContent.includes('zen-project'))`);
  await app.ev(`[...document.querySelectorAll('button, [role=button], a, li')].find((n) => n.textContent.includes('zen-project')).click(); return 1`);
  await app.waitFor(`!!document.getElementById('composer-input') && !document.getElementById('composer-input').disabled`, 15000);
  const before = (await app.call(`window.flowstate.history.get(${JSON.stringify(pz.id)})`)).filter((r) => r.t === 'user').length;
  await send('hello');
  const dlg = await app.waitFor(`(() => { const d = [...document.querySelectorAll('.dialog__title')].find((x) => /needs your OK|necesita tu OK/.test(x.textContent)); return d ? d.closest('.dialog').innerText : ''; })()`, 10000);
  check('a pay-as-you-go model asks for an OK before the message is sent', /opencode\/beam-free/.test(dlg) && /(Accept this model|Aceptar este modelo)/.test(dlg) && /(Accept all pay-as-you-go|Aceptar todos)/.test(dlg), dlg.slice(0, 200));
  await app.ev(`[...document.querySelectorAll('.modal')].pop().querySelector('.dialog__footer .btn').click(); return 1`); // Cancel
  await sleep(500);
  const after = (await app.call(`window.flowstate.history.get(${JSON.stringify(pz.id)})`)).filter((r) => r.t === 'user').length;
  check('Cancel sends nothing', after === before, `${before} -> ${after}`);
  check('no renderer errors', app.problems.length === 0, app.problems.join(' | ').slice(0, 400));
} catch (e) {
  check('e2e ran without exception', false, e.stack || String(e));
} finally {
  if (app) await app.shutdown();
}
process.exit(done());
