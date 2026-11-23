// Versions panel real-Electron test (NO model calls): IPC + the rendered tab against a temp git project with commits, a tag and a branch.
// Run: npm run e2e:versions   (isolated profile; E2E_EXE=<packaged exe> tests the built app)
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { launch, makeChecker, sleep } from './lib.mjs';

const PORT = 9611;
const { check, done } = makeChecker();
const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'flowstate-ver-')));
const proj = join(base, 'ver-project');
mkdirSync(proj, { recursive: true });
const sh = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: proj, encoding: 'utf8' });
sh('init', '-b', 'main');
writeFileSync(join(proj, 'a.txt'), 'one\n'); sh('add', '.'); sh('commit', '-m', 'flowstate: first idea\n\nFlowstate-Agent: claude');
sh('tag', '-a', '-m', 'First draft', 'checkpoint/first-draft');
sh('checkout', '-b', 'idea');
writeFileSync(join(proj, 'b.txt'), 'side\n'); sh('add', '.'); sh('commit', '-m', 'flowstate: side work');
sh('checkout', 'main');
writeFileSync(join(proj, 'a.txt'), 'two\n'); sh('commit', '-am', 'flowstate: second\n\nFlowstate-Methodology: review');
writeFileSync(join(proj, 'dirty.txt'), 'wip');

let app = null;
try {
  app = await launch({ profile: join(base, 'profile'), port: PORT });
  await app.ready();
  const p = await app.call(`window.flowstate.projects.add({ name: 'ver-project', path: ${JSON.stringify(proj)}, autoCommit: false })`);
  check('project added', !!p.id);

  const l = await app.call(`window.flowstate.versions.list(${JSON.stringify(p.id)}, {})`);
  check('versions.list: repo, timeline, branches, tag', l.isRepo && l.commits.length === 3 && l.branches.some((b) => b.name === 'idea') && l.tags.some((t) => t.label === 'First draft'), JSON.stringify(l).slice(0, 300));
  check('versions.list: agent + methodology trailers and dirty count', l.commits.some((c) => c.agent === 'claude') && l.commits.some((c) => c.methodology === 'review') && l.dirty >= 1, JSON.stringify(l.commits.map((c) => [c.agent, c.methodology])) + l.dirty);
  const pv = await app.call(`window.flowstate.versions.branch(${JSON.stringify(p.id)}, { op: 'previewMerge', name: 'idea' })`);
  check('merge preview via IPC (no conflicts, 1 file)', pv.ok && pv.conflicts.length === 0 && pv.files.length === 1, JSON.stringify(pv));
  const bad = await app.call(`window.flowstate.versions.branch(${JSON.stringify(p.id)}, { op: 'create', name: '--evil' })`);
  check('invalid branch name rejected', bad.ok === false && bad.reason === 'invalid-name');

  // UI: reload so the renderer lists the new project, select it, open the Versions tab
  await app.reload();
  await app.waitFor(`[...document.querySelectorAll('button, [role=button], a, li')].some((n) => n.textContent.includes('ver-project'))`);
  await app.ev(`
    const el = [...document.querySelectorAll('button, [role=button], a, li')].find((n) => n.textContent.includes('ver-project'));
    if (el) el.click();
    return 1`);
  await sleep(800);
  await app.ev(`if (document.getElementById('art-tab-versions') === null || document.getElementById('art-tab-versions').offsetParent === null) { window.flowstate.menu.invoke('view.toggleArtifacts'); } return 1`);
  await sleep(500);
  const tab = await app.ev(`const b = document.getElementById('art-tab-versions'); if (!b) return false; b.click(); return true`);
  check('Versions tab exists and opens', tab === true, await app.ev(`return document.body.innerText.slice(0, 300) + '|' + [...document.querySelectorAll('[id^=art-tab]')].map((x) => x.id)`));
  let items = 0;
  for (let i = 0; i < 30 && items < 3; i++) { await sleep(300); items = await app.ev(`return document.querySelectorAll('.ver__item').length`); }
  check('timeline renders 3 commits with graph svg', items === 3 && (await app.ev(`return document.querySelectorAll('.ver__item svg.ver__graph').length`)) === 3, String(items));
  const txt = await app.ev(`return document.querySelector('.ver')?.innerText || ''`);
  check('panel shows saved version badge and unsaved count', /First draft/.test(txt) && /unsaved|sin guardar/i.test(txt), txt.slice(0, 300));
  await app.ev(`document.querySelector('.ver__main').click(); return 1`);
  check('row expands with actions', (await app.ev(`return document.querySelectorAll('.ver__detail .ver__actions button').length`)) >= 4);
  await app.ev(`[...document.querySelectorAll('.ver__tabs [role=tab]')][2].click(); return 1`);
  await sleep(200);
  check('branches view lists branches with current highlighted', (await app.ev(`return document.querySelectorAll('.ver__branch').length`)) >= 2 && (await app.ev(`return document.querySelectorAll('.ver__branch.is-current').length`)) === 1);
  check('no renderer errors', app.problems.length === 0, app.problems.join(' | ').slice(0, 300));
} catch (e) {
  check('e2e ran without exception', false, e.stack || String(e));
} finally {
  if (app) await app.shutdown();
}
process.exit(done());
