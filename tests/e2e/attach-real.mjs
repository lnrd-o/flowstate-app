// Attach common files in the chat with the REAL claude CLI (one short turn): xlsx/pptx/docx/csv/txt/md are chosen like a file dialog
// does (CDP DOM.setFileInputFiles on the attach input), copied into the project's data folder, shown as chips, and sent with the message.
// Run: npm run e2e:attach
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, makeChecker, sleep } from './lib.mjs';

const PORT = 9618;
const { check, done } = makeChecker();
const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'flowstate-attach-')));
const proj = join(base, 'attach-project');
const src = join(base, 'src-files');
mkdirSync(proj, { recursive: true });
mkdirSync(src, { recursive: true });
const files = {
  csv: join(src, 'numbers.csv'), md: join(src, 'notes.md'), txt: join(src, 'readme.txt'),
  xlsx: join(src, 'ventas.xlsx'), pptx: join(src, 'deck.pptx'),
};
writeFileSync(files.csv, 'name,value\nA,3\nB,4\n');
writeFileSync(files.md, '# Notes\nhello\n');
writeFileSync(files.txt, 'plain text\n');
writeFileSync(files.xlsx, 'PK-not-a-real-workbook');
writeFileSync(files.pptx, 'PK-not-a-real-deck');
const bad = join(src, 'program.exe');
writeFileSync(bad, 'MZ');

let app = null;
const setFiles = async (paths) => {
  const r = await app.send('Runtime.evaluate', { expression: "document.querySelector('.att-input')" });
  await app.send('DOM.setFileInputFiles', { objectId: r.result.objectId, files: paths });
};
try {
  app = await launch({ profile: join(base, 'profile'), port: PORT });
  await app.ready();
  const p = await app.call(`window.flowstate.projects.add({ name: 'attach-project', path: ${JSON.stringify(proj)}, agent: 'claude', autoCommit: false })`);
  await app.reload();
  await app.ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 1`);
  await app.waitFor(`[...document.querySelectorAll('button, [role=button], a, li')].some((n) => n.textContent.includes('attach-project'))`);
  await app.ev(`[...document.querySelectorAll('button, [role=button], a, li')].find((n) => n.textContent.includes('attach-project')).click(); return 1`);
  await app.waitFor(`!!document.getElementById('composer-input') && !document.getElementById('composer-input').disabled`, 15000);

  const accept = await app.ev(`return document.querySelector('.att-input').accept`);
  check('the attach input accepts documents and images (xlsx, pptx, docx, csv, txt, md, png ...)', ['.xlsx', '.pptx', '.docx', '.csv', '.txt', '.md', 'image/png'].every((x) => accept.includes(x)), accept.slice(0, 120));

  await setFiles([files.xlsx, files.pptx, files.csv]);
  const chips = await app.waitFor(`(() => { const c = [...document.querySelectorAll('.att--file.att--done')]; return c.length >= 3 ? c.map((x) => x.innerText.replace(/\\s+/g, ' ')).join(' | ') : ''; })()`, 15000);
  check('three document chips appear and finish (xlsx, pptx, csv)', /ventas\.xlsx/.test(chips) && /deck\.pptx/.test(chips) && /numbers\.csv/.test(chips), chips);
  const dataDir = existsSync(join(proj, 'datos')) ? 'datos' : 'data';
  const copied = existsSync(join(proj, dataDir)) ? readdirSync(join(proj, dataDir)) : [];
  check('the files were copied into the project data folder (originals untouched)', ['ventas.xlsx', 'deck.pptx', 'numbers.csv'].every((f) => copied.includes(f)) && existsSync(files.xlsx), copied.join(','));

  await setFiles([files.md, files.txt]);
  await sleep(500);
  const total = await app.ev(`return document.querySelectorAll('.att--file').length`);
  check('the limit is 5 files per message (a 6th is refused)', total === 5, String(total));
  await setFiles([bad]);
  await sleep(400);
  check('unsupported types (.exe) are not attached', (await app.ev(`return document.querySelectorAll('.att--file').length`)) === 5);

  // remove the md and txt chips, then send with the csv (+ the two fake office files)
  for (let i = 0; i < 2; i++) await app.ev(`const c = [...document.querySelectorAll('.att--file')].find((x) => /notes\\.md|readme\\.txt/.test(x.innerText)); if (c) c.querySelector('.att__remove').click(); return 1`);
  await sleep(300);
  check('a chip can be removed', (await app.ev(`return document.querySelectorAll('.att--file').length`)) === 3);
  await app.ev(`const i = document.getElementById('composer-input'); i.value = 'Using ONLY numbers.csv, reply with just the sum of the value column as a number. Ignore the other files.'; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return 1`);
  let recs = [];
  for (let i = 0; i < 150 && !recs.some((r) => r.t === 'event' && (r.event.type === 'result' || r.event.type === 'error')); i++) { await sleep(1000); recs = await app.call(`window.flowstate.history.get(${JSON.stringify(p.id)})`); }
  const user = recs.find((r) => r.t === 'user');
  check('the message carries the attached file paths for the agent', !!user && new RegExp(dataDir + '/numbers\\.csv').test(user.text) && /Attached files/.test(user.text), user ? user.text.slice(-260) : 'no user record');
  const res = recs.find((r) => r.t === 'event' && r.event.type === 'result');
  const answer = recs.filter((r) => r.t === 'event' && r.event.type === 'text').map((r) => r.event.text).join(' ') + ' ' + (res ? res.event.text : '');
  check('the agent read the attached CSV (sum = 7)', /\b7\b/.test(answer), answer.slice(0, 160));
  check('chips are cleared after sending', (await app.ev(`return document.querySelectorAll('.att--file').length`)) === 0);
  check('no renderer errors', app.problems.length === 0, app.problems.join(' | ').slice(0, 400));
} catch (e) {
  check('e2e ran without exception', false, e.stack || String(e));
} finally {
  if (app) await app.shutdown();
}
process.exit(done());
