// "Work easier" features in the real Electron app (NO model calls): after-turn bar (from a replayed history), PDF export,
// spreadsheet compare, scheduled tasks, quick ask, plan-first toggle, ask-about-file, drop overlay, settings switches, updater.
// Run: npm run e2e:work   (E2E_EXE=<packaged exe> tests the built app)
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { launch, makeChecker, sleep } from './lib.mjs';

const PORT = 9616;
const { check, done } = makeChecker();
const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'flowstate-work-')));
const proj = join(base, 'work-project');
mkdirSync(join(proj, '.flowstate'), { recursive: true });
const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: proj, encoding: 'utf8' });
git('init', '-b', 'main');
writeFileSync(join(proj, 'ventas.csv'), 'mes,total\nene,100\nfeb,200\n');
git('add', '.'); git('commit', '-m', 'first');
writeFileSync(join(proj, 'ventas.csv'), 'mes,total\nene,150\nfeb,200\nmar,300\n');
git('commit', '-am', 'flowstate: update totals');
// A finished turn in the history: user prompt, answer text, a file change on ventas.csv, result.
const now = Date.now();
const recs = [
  { ts: now - 5000, t: 'user', text: 'Update the sales totals' },
  { ts: now - 4000, t: 'event', event: { type: 'tool-use', id: 't1', name: 'Edit', kind: 'edit', input: { file_path: 'ventas.csv' } } },
  { ts: now - 3500, t: 'event', event: { type: 'tool-result', id: 't1', name: 'Edit', kind: 'edit', output: 'ok' } },
  { ts: now - 3400, t: 'event', event: { type: 'file-change', id: 't1', path: 'ventas.csv', op: 'modify', added: 2, removed: 1, diff: '@@ -1,3 +1,4 @@\n mes,total\n-ene,100\n+ene,150\n feb,200\n+mar,300\n' } },
  { ts: now - 3000, t: 'event', event: { type: 'text', text: '# Sales update\n\nJanuary is now **150** and March was added.\n\n| mes | total |\n|---|---|\n| ene | 150 |' } },
  { ts: now - 2900, t: 'event', event: { type: 'result', ok: true, text: 'done' } },
];
writeFileSync(join(proj, '.flowstate', 'history.jsonl'), recs.map((r) => JSON.stringify(r)).join('\n') + '\n');


const pad = (n) => String(n).padStart(2, '0');
const d0 = new Date();
const today = d0.getFullYear() + '-' + pad(d0.getMonth() + 1) + '-' + pad(d0.getDate());
mkdirSync(join(base, 'profile'), { recursive: true });
writeFileSync(join(base, 'profile', 'usage.json'), JSON.stringify({ days: { [today]: { models: { 'claude|default': { inputTokens: 12000, outputTokens: 3400, turns: 3, costUsd: 0.12 } } } } }));
let app = null;
try {
  app = await launch({ profile: join(base, 'profile'), port: PORT });
  await app.ready();
  const p = await app.call(`window.flowstate.projects.add({ name: 'work-project', path: ${JSON.stringify(proj)}, autoCommit: true })`);
  const P = JSON.stringify(p.id);

  // IPC: spreadsheet compare (HEAD~1 vs HEAD), PDF export, schedule CRUD, updater
  const cmp = await app.call(`window.flowstate.workflow.compareSheet(${P}, 'ventas.csv')`);
  const cells = cmp.ok ? cmp.sheets[0].changes.map((c) => `${c.cell}:${c.before}>${c.after}`) : [];
  check('compareSheet: previous vs current version, cell by cell', cmp.ok && cmp.from === 'HEAD~1' && cells.includes('B2:100>150') && cells.includes('A4:>mar'), JSON.stringify(cmp).slice(0, 300));
  const pdf = await app.call(`window.flowstate.workflow.exportPdf(${P}, { html: '<h1>Report</h1><p>Hola</p>', title: 'Reporte de ventas' })`);
  check('exportPdf writes a PDF into the outputs folder', pdf.ok && /^(outputs|salidas)\/Reporte_de_ventas_.*\.pdf$/.test(pdf.rel) && existsSync(join(proj, pdf.rel)), JSON.stringify(pdf));
  const task = await app.call(`window.flowstate.schedule.save({ name: 'Weekly dashboard', projectId: ${P}, prompt: 'Update the dashboard', freq: 'weekly', time: '09:00', days: [1] })`);
  check('schedule.save returns a task with its next run on a Monday 09:00', !!task.id && new Date(task.nextAt).getDay() === 1 && new Date(task.nextAt).getHours() === 9, JSON.stringify(task));
  const list = await app.call('window.flowstate.schedule.list()');
  check('schedule.list shows it with the project name', list.length === 1 && list[0].projectName === 'work-project');
  let bad = null;
  try { await app.call(`window.flowstate.schedule.save({ name: 'x', projectId: ${P}, prompt: '' })`); } catch (e) { bad = String(e.message || e); }
  check('schedule.save rejects an empty request', !!bad && /prompt/.test(bad), String(bad));
  const up = await app.call('window.flowstate.update.status()');
  check('updater reports its state (no self-update in dev or portable builds)', typeof up.status === 'string' && typeof up.supported === 'boolean', JSON.stringify(up));

  // UI
  await app.reload();
  await app.ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 1`);
  await app.waitFor(`[...document.querySelectorAll('button, [role=button], a, li')].some((n) => n.textContent.includes('work-project'))`);
  await app.ev(`const el = [...document.querySelectorAll('button, [role=button], a, li')].find((n) => n.textContent.includes('work-project')); if (el) el.click(); return 1`);
  let bar = '';
  for (let i = 0; i < 30 && !/PDF/.test(bar); i++) { await sleep(300); bar = await app.ev(`const b = document.querySelector('.after-turn'); return b && !b.hidden ? b.innerText : ''`); }
  check('after-turn bar: what changed + Undo, Compare, Export, Save as recipe', /PDF/.test(bar) && /Word/.test(bar) && /PowerPoint/.test(bar) && /(Undo|Deshacer)/.test(bar) && /(Compare|Comparar) ventas\.csv/.test(bar) && /(recipe|receta)/i.test(bar), bar.slice(0, 300));
  await app.ev(`[...document.querySelectorAll('.after-turn button')].find((b) => /Compar/.test(b.textContent)).click(); return 1`);
  let rows = 0;
  for (let i = 0; i < 20 && !rows; i++) { await sleep(300); rows = await app.ev(`return document.querySelectorAll('.sheet-cmp__table tbody tr').length`); }
  check('Compare opens the cell-by-cell table', rows >= 2, String(rows));
  await app.ev(`[...document.querySelectorAll('.modal')].pop().querySelector('.dialog__footer .btn').click(); return 1`);
  await sleep(300);
  const before = readdirSync(proj).includes('outputs') ? readdirSync(join(proj, 'outputs')).length : readdirSync(proj).includes('salidas') ? readdirSync(join(proj, 'salidas')).length : 0;
  await app.ev(`[...document.querySelectorAll('.after-turn button')].find((b) => b.textContent.trim() === 'PDF').click(); return 1`);
  let after = before;
  for (let i = 0; i < 30 && after === before; i++) { await sleep(400); const dir = readdirSync(proj).includes('salidas') ? 'salidas' : 'outputs'; after = existsSync(join(proj, dir)) ? readdirSync(join(proj, dir)).filter((f) => f.endsWith('.pdf')).length : 0; }
  check('Export PDF button saves the answer as a PDF', after > before, `${before} -> ${after}`);

  // Plan-first toggle
  const pressed = await app.ev(`const b = document.querySelector('.composer__plan'); b.click(); return b.getAttribute('aria-pressed')`);
  await sleep(200);
  check('Plan first toggle switches on', (await app.ev(`return document.querySelector('.composer__plan').getAttribute('aria-pressed')`)) === 'true', String(pressed));
  await app.ev(`document.querySelector('.composer__plan').click(); return 1`);

  // Quick ask
  await app.ev(`document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', ctrlKey: true, bubbles: true })); return 1`);
  await sleep(300);
  check('Ctrl+Space opens the quick-ask bar', await app.ev(`const q = document.querySelector('.quick-ask'); return !!q && !q.hidden && document.activeElement === q.querySelector('input')`));
  await app.ev(`document.querySelector('.quick-ask input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 1`);
  await sleep(200);
  check('Esc closes it', await app.ev(`return document.querySelector('.quick-ask').hidden`));

  // Drop overlay
  await app.ev(`const dt = new DataTransfer(); dt.items.add(new File(['a'], 'x.csv')); document.querySelector('.chat').dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true })); return 1`);
  await sleep(200);
  check('dragging a file over the window shows "Drop to start"', await app.ev(`return !document.querySelector('.drop-start').hidden`));
  await app.ev(`document.dispatchEvent(new DragEvent('dragleave', { bubbles: true })); return 1`);

  // Ask about this file (file viewer)
  await app.ev(`window.__flowstateActions && 1; return 1`);
  // open the file from the chat's turn summary ("open file" button), like a user would
  await app.ev(`const b = [...document.querySelectorAll('.chat button')].find((x) => (x.title || '').includes('ventas.csv')); if (b) b.click(); return !!b`);
  await sleep(800);
  let ask = false;
  for (let i = 0; i < 20 && !ask; i++) { await sleep(300); ask = await app.ev(`const b = [...document.querySelectorAll('.fv__actions button')].find((x) => /Ask|Preguntar/.test(x.textContent) && x.offsetParent && !x.disabled); if (b) { b.click(); return true } return false`); }
  await sleep(300);
  check('file viewer "Ask" opens the ask-about-this-file choices', ask && await app.ev(`return document.querySelectorAll('.ask-file__opt').length === 5`), await app.ev(`return 'tabs=' + [...document.querySelectorAll('[id^=art-tab]')].map((x) => x.id).join(',') + ' fv=' + [...document.querySelectorAll('.fv__actions button')].map((b) => b.textContent + (b.offsetParent ? '' : '(hidden)')).join('|') + ' items=' + [...document.querySelectorAll('.files-tab *')].filter((n) => /ventas/.test(n.textContent) && !n.children.length).map((n) => n.tagName + '.' + n.className).slice(0,4).join(',')`));
  await app.ev(`[...document.querySelectorAll('.modal')].pop()?.querySelector('.dialog__footer .btn')?.click(); return 1`);
  await sleep(200);

  // Scheduled tasks dialog
  await app.ev(`window.__flowstateActions; return 1`);
  await app.ev(`document.querySelector('.topbar__actions button[aria-haspopup=menu]')?.click(); return 1`);
  await sleep(300);
  await app.ev(`const m = [...document.querySelectorAll('[role=menuitem], .menu__item, button')].find((x) => /Scheduled tasks|Tareas programadas/.test(x.textContent)); if (m) m.click(); return 1`);
  let sched = '';
  for (let i = 0; i < 20 && !/Weekly dashboard/.test(sched); i++) { await sleep(300); sched = await app.ev(`return document.querySelector('.sched')?.innerText || ''`); }
  check('Scheduled tasks dialog lists the task with when it runs next', /Weekly dashboard/.test(sched) && /(next|pr.xima)/i.test(sched), sched.slice(0, 200));
  await app.ev(`[...document.querySelectorAll('.modal')].pop()?.querySelector('.dialog__footer .btn')?.click(); return 1`);
  await sleep(200);

  // Settings switches
  await app.ev(`document.querySelector('.settings-btn').click(); return 1`);
  await sleep(500);
  await app.ev(`document.querySelector('.modal .dialog__footer .btn')?.click(); return 1`);
  await sleep(300);
  // Threads bar: no stray "null" text; Context notes open even on a brand-new conversation
  const tb = await app.ev(`return document.querySelector('.threads-bar')?.innerText || ''`);
  check('conversations bar has no stray "null" text', !!tb && !/null/.test(tb), tb);
  await app.ev(`[...document.querySelectorAll('.threads-bar button')].find((b) => /Context notes|Notas de contexto/.test(b.textContent)).click(); return 1`);
  let note = '';
  for (let i = 0; i < 20 && !note; i++) { await sleep(300); note = await app.ev(`const c = [...document.querySelectorAll('.fv__content')].find((x) => x.offsetParent); return c ? c.innerText : ''`); }
  check('Context notes open (written on demand, no file-not-found error)', !!note && !/ENOENT|no existe|does not exist/.test(note), note.slice(0, 160));
  // Model picker: estimated usage per model
  await app.ev(`document.querySelector('.mp__btn').click(); return 1`);
  let use = '';
  for (let i = 0; i < 30 && !use; i++) { await sleep(300); use = await app.ev(`const u = document.querySelector('.mp__item-use'); return u ? u.textContent : ''`); }
  check('model picker shows estimated usage per model', /15\.4k/.test(use) && /3/.test(use), use);
  await app.ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 1`);
  await sleep(200);
  await app.ev(`document.querySelector('.settings-btn').click(); return 1`);
  await sleep(400);
  // Side tabs are icon-only (name on hover), plus Context and Terminal tabs
  await app.ev(`document.querySelector('.modal .dialog__footer .btn')?.click(); return 1`);
  await sleep(300);
  const tabs = await app.ev(`return [...document.querySelectorAll('.artifacts__header .pill-tab')].map((b) => b.id.replace('art-tab-', '') + ':' + (b.title ? 'T' : '-') + (b.textContent.trim() ? 'x' : '') + (b.querySelector('svg') ? 'i' : '')).join(',')`);
  check('side tabs are icon-only with hover names (incl. Context and Terminal)', /context:Ti/.test(tabs) && /terminal:Ti/.test(tabs) && !/x/.test(tabs.replace(/[a-z]+:/g, '')), tabs);
  await app.ev(`document.getElementById('art-tab-context').click(); return 1`);
  let ctx = '';
  for (let i = 0; i < 30 && !/(Project overview|Resumen del proyecto)/.test(ctx); i++) { await sleep(300); ctx = await app.ev(`return document.querySelector('.ctx-tab')?.innerText || ''`); }
  check('Context tab shows the project overview and this conversation', /(Project overview|Resumen del proyecto)/.test(ctx) && /(This conversation|Esta conversaci)/.test(ctx), ctx.slice(0, 200));
  await app.ev(`document.getElementById('art-tab-terminal').click(); return 1`);
  await app.waitFor(`!!document.querySelector('.term-tab__host .xterm')`, 20000);
  await sleep(1500);
  await app.call(`window.flowstate.term.input(${P}, 'echo FS_TERM_OK_' + (6*7) + '\\r')`);
  let tbuf = '';
  for (let i = 0; i < 40 && !/FS_TERM_OK_42/.test(tbuf.replace(/echo FS_TERM_OK_[^\r\n]*/g, '')); i++) { await sleep(300); tbuf = (await app.call(`window.flowstate.term.start(${P}, {})`)).buffer || ''; }
  check('Terminal tab runs commands in the project folder (shell answers)', /FS_TERM_OK_42/.test(tbuf.replace(/echo FS_TERM_OK_[^\r\n]*/g, '')), tbuf.slice(-200));
  check('terminal starts in the project folder', tbuf.includes('work-project'), tbuf.slice(0, 200));
  await app.call(`window.flowstate.term.stop(${P})`);
  // Usage ring in the composer
  check('usage ring is in the composer', await app.ev(`return !!document.querySelector('.composer .usage-ring') && !document.querySelector('.usage-ring__wrap').hidden`));
  await app.ev(`document.querySelector('.usage-ring').click(); return 1`);
  await sleep(300);
  check('clicking the ring opens the usage popover', await app.ev(`const p = document.querySelector('.usage-pop'); return !!p && !p.hidden && p.innerText.length > 5`));
  await app.ev(`document.querySelector('.usage-ring').click(); return 1`);
  await app.ev(`document.querySelector('.settings-btn').click(); return 1`);
  await sleep(400);
  // Resend with another model: dialog with grouped models, then Cancel (nothing is sent)
  await app.ev(`document.querySelector('.modal .dialog__footer .btn')?.click(); return 1`);
  await sleep(200);
  await app.ev(`window.__flowstateActions.openResend('Update the sales totals'); return 1`);
  await app.waitFor(`!!document.getElementById('resend-model')`, 8000);
  const ropts = await app.ev(`const s = document.getElementById('resend-model'); return s.options.length + ' options, ' + s.querySelectorAll('optgroup').length + ' groups'`);
  check('Resend dialog lists the default model plus the available models', /^[2-9]|^dd/.test(ropts), ropts);
  await app.ev(`[...document.querySelectorAll('.modal')].pop().querySelector('.dialog__footer .btn').click(); return 1`);
  await sleep(200);
  // hover actions on the user message (Copy / Edit / Send again / Resend with another model)
  const macts = await app.ev(`return [...document.querySelectorAll('.msg--user .msg__actions button')].map((b) => b.title).join('|')`);
  check('user messages have Copy, Edit, Send again and Resend-with-another-model', macts.split('|').length === 4, macts);
  await app.ev(`document.querySelector('.settings-btn').click(); return 1`);
  await sleep(400);
  check('Settings has Notifications and Auto-update switches', await app.ev(`return !!document.getElementById('set-notifications') && !!document.getElementById('set-autoupdate')`));
  check('no renderer errors', app.problems.length === 0, app.problems.join(' | ').slice(0, 400));
} catch (e) {
  check('e2e ran without exception', false, e.stack || String(e));
} finally {
  if (app) await app.shutdown();
}
process.exit(done());
