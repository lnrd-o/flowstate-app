import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { create, sanitizeName, MAX_IMPORT_BYTES } from '../../src/main/svc/imports.js';
import { validateVars } from '../../src/main/runner.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fs-imp-'));
function setup(extra = {}) {
  const proj = tmp();
  const src = tmp();
  const svc = create({ getProject: (id) => (id === 'p' ? { id: 'p', path: proj } : null), getWindow: () => null,
    dialog: { showOpenDialog: async () => ({ canceled: true }) }, app: { getPath: () => tmp() }, ...extra });
  return { proj, src, svc };
}

test('importFile copies, de-duplicates, never moves', () => {
  const { proj, src, svc } = setup();
  const f = path.join(src, 'Sales 2026.csv');
  fs.writeFileSync(f, 'a,b\n1,2\n');
  const r1 = svc.importFile('p', f);
  assert.deepEqual(r1, { rel: 'data/Sales 2026.csv', name: 'Sales 2026.csv', size: 8 });
  assert.equal(svc.importFile('p', f).rel, 'data/Sales 2026 (2).csv');
  assert.equal(svc.importFile('p', f).rel, 'data/Sales 2026 (3).csv');
  assert.ok(fs.existsSync(f));
  assert.equal(fs.readFileSync(path.join(proj, 'data', 'Sales 2026.csv'), 'utf8'), 'a,b\n1,2\n');
});

test('importFile refusals: symlink, oversize, extension, unknown project, relative path, directory', () => {
  const { src, svc } = setup();
  const f = path.join(src, 'a.csv');
  fs.writeFileSync(f, 'x');
  const link = path.join(src, 'link.csv');
  let linked = true;
  try { fs.symlinkSync(f, link); } catch { linked = false; }
  if (linked) assert.throws(() => svc.importFile('p', link), /Links/);
  const exe = path.join(src, 'a.exe');
  fs.writeFileSync(exe, 'x');
  assert.throws(() => svc.importFile('p', exe), /not supported/);
  assert.throws(() => svc.importFile('zz', f), /Unknown project/);
  assert.throws(() => svc.importFile('p', 'a.csv'), /Invalid file path/);
  fs.mkdirSync(path.join(src, 'd.csv'));
  assert.throws(() => svc.importFile('p', path.join(src, 'd.csv')), /regular/);
  assert.throws(() => svc.importFile('p', path.join(src, 'missing.csv')), /not found/);
  const big = create({ getProject: () => ({ id: 'p', path: src }), app: {}, fsx: { ...fs, lstatSync: () => ({ isSymbolicLink: () => false, isFile: () => true, size: MAX_IMPORT_BYTES + 1 }) } });
  assert.throws(() => big.importFile('p', f), /too large/);
});

test('sanitizeName strips separators, reserved chars and device names', () => {
  assert.equal(sanitizeName('..\\..\\evil.csv'), 'evil.csv');
  assert.equal(sanitizeName('a<b>:c|d?.csv'), 'a_b__c_d_.csv');
  assert.equal(sanitizeName('con.txt'), '_con.txt');
  assert.equal(sanitizeName('...'), 'file');
  assert.ok(!sanitizeName('x/../../y.csv').includes('/'));
});

test('pick: filters per kind, cancelled -> []', async () => {
  const calls = [];
  let res = { canceled: true, filePaths: [] };
  const dialog = { showOpenDialog: async (...a) => { calls.push(a); return res; } };
  const win = {};
  const { svc } = setup({ dialog, getWindow: () => win });
  assert.deepEqual(await svc.pick({ kind: 'office' }), []);
  res = { canceled: false, filePaths: [path.resolve('x.csv')] };
  assert.equal((await svc.pick({ kind: 'data', multi: true })).length, 1);
  await svc.pick({ kind: 'any' });
  assert.equal(calls[0][0], win);
  assert.ok(calls[0][1].filters[0].extensions.includes('docx'));
  assert.deepEqual(calls[1][1].properties, ['openFile', 'multiSelections']);
  assert.ok(!calls[1][1].filters[0].extensions.includes('docx'));
  assert.equal(calls[2][1].filters, undefined);
});

test('defaultDir: Projects (en), Proyectos (es), prefers existing Documentos, creates missing', () => {
  const root = tmp();
  const docs = path.join(root, 'Documents');
  fs.mkdirSync(docs);
  let lang = 'en';
  const mk = (home) => create({ getProject: () => null, app: { getPath: () => docs }, settings: { get: () => ({ language: lang }) }, os: { homedir: () => home } });
  assert.equal(mk(root).defaultDir(), path.join(docs, 'Projects'));
  assert.ok(fs.statSync(path.join(docs, 'Projects')).isDirectory());
  lang = 'es';
  assert.equal(mk(root).defaultDir(), path.join(docs, 'Proyectos'));
  fs.mkdirSync(path.join(root, 'Documentos'));
  assert.equal(mk(root).defaultDir(), path.join(root, 'Documentos', 'Proyectos'));
  assert.ok(fs.statSync(path.join(root, 'Documentos', 'Proyectos')).isDirectory());
  lang = 'en';
  assert.equal(mk(root).defaultDir(), path.join(docs, 'Projects'));
});

test('newProjectDir: names, accents, reserved, suffixes, case-insensitive, es/en fallback, race retry', () => {
  const docs = tmp();
  let lang = 'en';
  const mk = (extra = {}) => create({ getProject: () => null, app: { getPath: () => docs }, settings: { get: () => ({ language: lang }) }, os: { homedir: () => docs }, platform: 'win32', ...extra });
  const a = mk().newProjectDir('Sales report');
  assert.equal(a.folder, 'Sales_Report');
  assert.equal(a.path, path.join(docs, 'Projects', 'Sales_Report'));
  assert.ok(fs.statSync(a.path).isDirectory());
  assert.equal(mk().newProjectDir('Sales report').folder, 'Sales_Report_2');
  assert.equal(mk().newProjectDir('Sales REPORT').folder, 'Sales_REPORT_2'.replace('_2', '_3')); // case-insensitive on win32
  assert.equal(mk().newProjectDir('Análisis de ventas').folder, 'Analisis_De_Ventas');
  assert.equal(mk().newProjectDir('CON').folder, 'Project_CON');
  assert.equal(mk().newProjectDir('../../x').folder, 'X');
  assert.equal(mk().newProjectDir('???').folder, 'Project');
  lang = 'es';
  const es = mk().newProjectDir('***');
  assert.equal(es.folder, 'Proyecto');
  assert.equal(path.basename(path.dirname(es.path)), 'Proyectos');
  // race: first mkdir fails with EEXIST (someone else created it), retry picks the next suffix
  let first = true;
  const racy = { ...fs, mkdirSync: (p, o) => { if (first && !o && path.basename(p) === 'Race') { first = false; fs.mkdirSync(p); const e = new Error('exists'); e.code = 'EEXIST'; throw e; } return fs.mkdirSync(p, o); } };
  assert.equal(mk({ fsx: racy }).newProjectDir('race').folder, 'Race_2');
});

test('runner: file variables must be an existing regular file under data/', () => {
  const proj = tmp();
  fs.mkdirSync(path.join(proj, 'data'));
  fs.writeFileSync(path.join(proj, 'data', 'a.csv'), 'x');
  fs.mkdirSync(path.join(proj, 'data', 'dir'));
  const project = { name: 'P', path: proj };
  const m = { vars: [{ key: 'f', type: 'file', required: true }] };
  assert.equal(validateVars(m, { f: 'data/a.csv' }, project).f, 'data/a.csv');
  for (const bad of ['data/nope.csv', '../x.csv', 'other.csv', 'data/dir', 'C:/x.csv', '/etc/passwd']) {
    assert.throws(() => validateVars(m, { f: bad }, project), /Variable f/, bad);
  }
  assert.throws(() => validateVars(m, { f: 5 }, project), /string/);
  assert.throws(() => validateVars(m, {}, project), /Missing required/);
  assert.equal(validateVars({ vars: [{ key: 'f', type: 'file', default: '' }] }, {}, project).f, '');
});
