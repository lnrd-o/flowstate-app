// "Plan first" with the REAL claude CLI (uses a few tokens of your plan; nothing is changed: the turn runs in plan mode and the
// plan is NOT executed). Run: npm run e2e:plan
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, makeChecker, sleep } from './lib.mjs';

const PORT = 9615;
const { check, done } = makeChecker();
const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'flowstate-plan-')));
const proj = join(base, 'plan-project');
mkdirSync(proj, { recursive: true });
writeFileSync(join(proj, 'notes.txt'), 'buy milk\ncall Ana\n');

let app = null;
try {
  app = await launch({ profile: join(base, 'profile'), port: PORT });
  await app.ready();
  await app.call(`window.flowstate.projects.add({ name: 'plan-project', path: ${JSON.stringify(proj)}, agent: 'claude', autoCommit: false })`);
  await app.reload();
  await app.ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 1`);
  await app.waitFor(`[...document.querySelectorAll('button, [role=button], a, li')].some((n) => n.textContent.includes('plan-project'))`);
  await app.ev(`const el = [...document.querySelectorAll('button, [role=button], a, li')].find((n) => n.textContent.includes('plan-project')); if (el) el.click(); return 1`);
  await sleep(800);
  await app.ev(`document.querySelector('.composer__plan').click(); return 1`);
  await sleep(200);
  await app.ev(`const i = document.getElementById('composer-input'); i.value = 'Turn notes.txt into a tidy checklist file called todo.md'; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return 1`);
  let card = '';
  for (let i = 0; i < 180 && !card; i++) { await sleep(1000); card = await app.ev(`const c = document.querySelector('.plan-card'); return c ? c.innerText : ''`); }
  const steps = await app.ev(`return document.querySelectorAll('.plan-card__step').length`);
  check('plan-first turn ends with a plan card', !!card, card.slice(0, 300));
  check('the plan is split into editable steps', steps >= 2, String(steps));
  check('nothing was changed in plan mode (no todo.md)', !readdirSync(proj).includes('todo.md'), readdirSync(proj).join(','));
  check('Run plan button is offered', /Run plan|Ejecutar el plan/.test(card));
  check('no renderer errors', app.problems.length === 0, app.problems.join(' | ').slice(0, 400));
} catch (e) {
  check('e2e ran without exception', false, e.stack || String(e));
} finally {
  if (app) await app.shutdown();
}
process.exit(done());
