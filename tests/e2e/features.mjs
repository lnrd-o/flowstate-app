// 1.1.0 features in the real Electron app (NO model calls): conversations (IPC + bar), Sources switches in Settings,
// empty-project card in the new-project wizard, LaTeX math shown as plain text, data/outputs folders for new projects.
// Run: npm run e2e:features   (isolated profile; E2E_EXE=<packaged exe> tests the built app)
import { mkdtempSync, mkdirSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, makeChecker, sleep, root } from './lib.mjs';

const PORT = 9612;
const { check, done } = makeChecker();
const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'flowstate-feat-')));
const proj = join(base, 'feat-project');
mkdirSync(proj, { recursive: true });

// data/outputs layout of a new project folder (main-process service, no Electron needed)
{
  const { create } = await import(new URL(`file:///${root.replace(/\\/g, '/')}/src/main/svc/imports.js`));
  const docs = join(base, 'docs');
  mkdirSync(docs, { recursive: true });
  const mk = (language) => create({ app: { getPath: () => docs }, settings: { get: () => ({ language }) }, getProject: () => null });
  const en = mk('en').newProjectDir('Sales Report');
  check('new project (en) gets data/ and outputs/', existsSync(join(en.path, 'data')) && existsSync(join(en.path, 'outputs')), en.path);
  const es = mk('es').newProjectDir('Analisis de ventas');
  check('new project (es) gets datos/ and salidas/', existsSync(join(es.path, 'datos')) && existsSync(join(es.path, 'salidas')), es.path);
}

let app = null;
try {
  app = await launch({ profile: join(base, 'profile'), port: PORT });
  await app.ready();
  const p = await app.call(`window.flowstate.projects.add({ name: 'feat-project', path: ${JSON.stringify(proj)}, autoCommit: false })`);
  check('project added', !!p.id);
  const P = JSON.stringify(p.id);

  // conversations via IPC
  const l0 = await app.call(`window.flowstate.threads.list(${P})`);
  check('threads.list: Main conversation exists and is active', l0.active === '00000000' && l0.threads.length === 1 && l0.threads[0].main, JSON.stringify(l0));
  const c1 = await app.call(`window.flowstate.threads.create(${P}, { title: 'Charts', agent: 'agy' })`);
  check('threads.create: new conversation active with its own agent', c1.ok && c1.active === c1.id && c1.threads.length === 2, JSON.stringify(c1));
  const proj1 = (await app.call('window.flowstate.projects.list()')).find((x) => x.id === p.id);
  check('active conversation is mirrored into the project (agent, activeThread, no session)', proj1.activeThread === c1.id && proj1.agent === 'agy' && !proj1.sessionId, JSON.stringify(proj1));
  const sw = await app.call(`window.flowstate.threads.switch(${P}, '00000000')`);
  const proj2 = (await app.call('window.flowstate.projects.list()')).find((x) => x.id === p.id);
  check('threads.switch back to Main restores its agent', sw.ok && proj2.activeThread === '00000000' && proj2.agent === 'claude', JSON.stringify(proj2));
  const rn = await app.call(`window.flowstate.threads.rename(${P}, ${JSON.stringify(c1.id)}, 'Charts and KPIs')`);
  check('threads.rename', rn.ok && rn.threads.some((t) => t.title === 'Charts and KPIs'));
  check('threads.json + context notes written, private files ignored by git', existsSync(join(proj, '.flowstate', 'threads.json')) && existsSync(join(proj, '.flowstate', 'context', 'PROJECT.md'))
    && /threads\.json/.test(readFileSync(join(proj, '.flowstate', '.gitignore'), 'utf8')));
  const rmMain = await app.call(`window.flowstate.threads.remove(${P}, '00000000')`);
  check('Main conversation cannot be deleted', rmMain.ok === false && rmMain.reason === 'main');
  const rm = await app.call(`window.flowstate.threads.remove(${P}, ${JSON.stringify(c1.id)})`);
  check('threads.remove', rm.ok && rm.threads.length === 1);

  // UI: select the project, conversations bar visible
  await app.reload();
  await app.waitFor(`[...document.querySelectorAll('button, [role=button], a, li')].some((n) => n.textContent.includes('feat-project'))`);
  await app.ev(`const el = [...document.querySelectorAll('button, [role=button], a, li')].find((n) => n.textContent.includes('feat-project')); if (el) el.click(); return 1`);
  let bar = false;
  for (let i = 0; i < 20 && !bar; i++) { await sleep(250); bar = await app.ev(`const b = document.querySelector('.threads-bar'); return !!b && !b.hidden && !!document.getElementById('threads-select')`); }
  check('conversations bar renders above the chat', bar === true);
  await app.ev(`[...document.querySelectorAll('.threads-bar button')].find((b) => /New conversation|Nueva conversaci/.test(b.textContent)).click(); return 1`);
  let opts = 0;
  for (let i = 0; i < 20 && opts < 2; i++) { await sleep(250); opts = await app.ev(`return document.querySelectorAll('#threads-select option').length`); }
  check('New conversation button adds and selects a conversation', opts === 2, String(opts));

  // math rendering
  const md = await app.ev(`const m = await import('./lib/markdown.js'); const d = document.createElement('div'); d.append(m.renderMarkdown('A unos $30 - 35\\\\text{ cm}$ y cuesta $40.')); return d.textContent`);
  check('LaTeX math shown as plain text, money untouched', /A unos 30 - 35 cm y cuesta \$40\./.test(md), md);

  // Settings > Sources
  await app.ev(`document.querySelector('.settings-btn').click(); return 1`);
  let rows = 0;
  for (let i = 0; i < 20 && rows < 4; i++) { await sleep(250); rows = await app.ev(`return document.querySelectorAll('input[role=switch][id^=set-src-]').length`); }
  check('Settings shows 4 source switches', rows === 4, String(rows));
  await app.ev(`document.getElementById('set-src-agy').click(); return 1`);
  await sleep(600);
  const s1 = await app.call('window.flowstate.settings.get()');
  check('turning Antigravity off is saved', s1.agentsEnabled && s1.agentsEnabled.agy === false, JSON.stringify(s1.agentsEnabled));
  const agyHidden = await app.ev(`const b = document.querySelector('.seg-agent__item--agy'); return !!b && b.hidden`);
  check('Antigravity disappears from the agent switch', agyHidden === true);
  await app.ev(`document.getElementById('set-src-agy').click(); return 1`);
  await sleep(600);
  check('turning it back on is saved', (await app.call('window.flowstate.settings.get()')).agentsEnabled.agy === true);
  await app.ev(`document.querySelector('.modal [aria-label], .modal button')?.closest('.modal')?.querySelector('.btn--primary')?.click(); return 1`);
  await sleep(300);
  await app.ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 1`);
  await sleep(300);

  // Language: Automatic option in Settings, explicit choice turns it off, Automatic turns it back on
  await app.ev(`document.querySelector('.settings-btn').click(); return 1`);
  await app.waitFor(`!!document.getElementById('set-language')`);
  const langOpts = await app.ev(`return [...document.getElementById('set-language').options].map((o) => o.value).join(',')`);
  check('Settings language select offers Automatic + English + Spanish', langOpts === 'auto,en,es', langOpts);
  const L0 = await app.call('window.flowstate.settings.get()');
  check('language is automatic by default on a new profile', L0.languageAuto === true, JSON.stringify([L0.language, L0.languageAuto]));
  const other = L0.language === 'es' ? 'en' : 'es';
  await app.ev(`const el = document.getElementById('set-language'); el.value = '${other}'; el.dispatchEvent(new Event('change', { bubbles: true })); return 1`);
  await sleep(600);
  const L1 = await app.call('window.flowstate.settings.get()');
  check('choosing a language turns automatic off', L1.language === other && L1.languageAuto === false, JSON.stringify([L1.language, L1.languageAuto]));
  await app.ev(`const el = document.getElementById('set-language'); el.value = 'auto'; el.dispatchEvent(new Event('change', { bubbles: true })); return 1`);
  await sleep(600);
  const L2 = await app.call('window.flowstate.settings.get()');
  check('Automatic goes back to the system language', L2.languageAuto === true && L2.language === L0.language, JSON.stringify([L2.language, L2.languageAuto]));
  await app.ev(`document.querySelector('.modal .dialog__footer .btn')?.click(); return 1`);
  await sleep(300);

  // New project wizard: empty project card
  await app.ev(`document.querySelector('.new-project-btn').click(); return 1`);
  let empty = false;
  for (let i = 0; i < 20 && !empty; i++) { await sleep(250); empty = await app.ev(`return [...document.querySelectorAll('.wt-quick__btn')].some((b) => /Empty project|Proyecto vac/.test(b.textContent))`); }
  check('new-project wizard offers an Empty project card', empty === true);
  if (empty) {
    await app.ev(`[...document.querySelectorAll('.wt-quick__btn')].find((b) => /Empty project|Proyecto vac/.test(b.textContent)).click(); return 1`);
    await sleep(500);
    check('Empty project goes straight to the name step', await app.ev(`const st = [...document.querySelectorAll('.stepper')].pop(); return !!st && !!st.querySelector('.stepper__step.is-done') && /Name|Nombre/.test(st.querySelector('.stepper__step.is-active')?.textContent || '')`), await app.ev(`return ([...document.querySelectorAll('.stepper')].pop()?.innerText || 'no stepper') + ' | ' + (document.querySelector('.wt__content')?.innerText || '').slice(0, 200)`));
  }
  // Clicking outside a dialog with changes asks before discarding
  await app.ev(`[...document.querySelectorAll('.modal__backdrop')].pop().click(); return 1`);
  await sleep(400);
  const asked = await app.ev(`return [...document.querySelectorAll('.dialog__title')].some((x) => /Discard changes|Descartar cambios/.test(x.textContent))`);
  check('outside click on the new-project wizard asks "Discard changes?"', asked === true);
  await app.ev(`[...document.querySelectorAll('.modal')].pop().querySelector('.dialog__footer .btn:not(.btn--danger)').click(); return 1`);
  await sleep(300);
  check('choosing Cancel keeps the wizard open', await app.ev(`return [...document.querySelectorAll('.dialog__title')].some((x) => /New project|Proyecto nuevo/.test(x.textContent))`));
  check('no renderer errors', app.problems.length === 0, app.problems.join(' | ').slice(0, 400));
} catch (e) {
  check('e2e ran without exception', false, e.stack || String(e));
} finally {
  if (app) await app.shutdown();
}
process.exit(done());
