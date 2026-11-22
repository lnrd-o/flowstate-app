// Methodology store: bundled methodologies/*.json (read-only, repo root) + user ones in <userData>/methodologies/<id>.json.
// A user methodology with the same id overrides the bundled one; deleting it reveals the bundled one again.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateMethodology, ID_RE } from '../shared/methodology.js';
import { writeJsonAtomic } from './settings.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const BUNDLED_DIR = path.join(here, '..', '..', 'methodologies');
export const MAX_IMPORT_BYTES = 1024 * 1024;

const stripBom = (t) => (t.charCodeAt(0) === 0xFEFF ? t.slice(1) : t);
const checkId = (id) => {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new TypeError('invalid methodology id');
  return id;
};

export function summarize(m) {
  return {
    id: m.id, source: m.source, name: m.name, description: m.description ?? { en: '' }, tags: Array.isArray(m.tags) ? m.tags : [],
    nodeCount: m.nodes.length, varCount: (m.vars ?? []).length, updatedAt: m.updatedAt ?? null,
  };
}

/** dialog = { showOpenDialog, showSaveDialog } (electron). getWindow() optional. */
export function createMethodologies({ userDir, bundledDir = BUNDLED_DIR, dialog, getWindow = () => null, getProject = () => null, fsx = fs, now = () => new Date().toISOString() }) {
  const root = path.join(userDir, 'methodologies');

  function readOne(file, source) {
    try {
      if (source === 'project') { // project folders are untrusted input: regular files only, size-capped
        const st = fsx.lstatSync(file);
        if (!st.isFile() || st.size > MAX_IMPORT_BYTES) return null;
      }
      const m = JSON.parse(stripBom(fsx.readFileSync(file, 'utf8')));
      if (validateMethodology(m).length) return null;
      if (path.basename(file) !== `${m.id}.json`) return null;
      return { ...m, source };
    } catch { return null; }
  }
  function scan(dir, source) {
    let names = [];
    try { names = fsx.readdirSync(dir); } catch { return []; }
    return names.filter((n) => n.endsWith('.json')).map((n) => readOne(path.join(dir, n), source)).filter(Boolean);
  }
  const userFile = (id) => path.join(root, `${checkId(id)}.json`);

  /** <project>/.flowstate/methodologies/*.json (source 'project'); invalid files are skipped. */
  function projectDir(projectId) {
    const p = typeof projectId === 'string' ? getProject(projectId) : null;
    return p ? path.join(p.path, '.flowstate', 'methodologies') : null;
  }

  function all(projectId) {
    const map = new Map(scan(bundledDir, 'bundled').map((m) => [m.id, m]));
    for (const m of scan(root, 'user')) map.set(m.id, m);
    const pd = projectDir(projectId);
    if (pd) for (const m of scan(pd, 'project')) map.set(m.id, m);
    return map;
  }

  const store = {
    list: (projectId) => [...all(projectId).values()].map(summarize).sort((a, b) => a.id.localeCompare(b.id)),
    get(id, projectId) {
      checkId(id);
      const m = all(projectId).get(id);
      if (!m) throw new Error('Unknown methodology');
      return m;
    },
    save(m) {
      const errs = validateMethodology(m);
      if (errs.length) throw new Error(`Invalid methodology: ${errs.join('; ')}`);
      const t = now();
      const out = { ...m, source: 'user', updatedAt: t, createdAt: m.createdAt || t };
      writeJsonAtomic(userFile(out.id), out, fsx);
      return out;
    },
    delete(id) {
      const f = userFile(id);
      if (!fsx.existsSync(f)) throw new Error(all().has(id) ? 'Bundled methodologies cannot be deleted' : 'Unknown methodology');
      fsx.unlinkSync(f);
    },
    async import() {
      const r = await dialog.showOpenDialog(getWindow() ?? undefined, { properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
      if (r.canceled || !r.filePaths?.length) return null;
      const f = r.filePaths[0];
      if (!/\.json$/i.test(f)) throw new Error('Select a .json file');
      if (fsx.statSync(f).size > MAX_IMPORT_BYTES) throw new Error('File too large (max 1 MB)');
      let m;
      try { m = JSON.parse(stripBom(fsx.readFileSync(f, 'utf8'))); } catch { throw new Error('Not valid JSON'); }
      const errs = validateMethodology(m);
      if (errs.length) throw new Error(`Invalid methodology: ${errs.join('; ')}`);
      const taken = new Set(all().keys());
      let id = m.id;
      for (let n = 2; taken.has(id); n++) id = `${m.id.slice(0, 60 - String(n).length)}-${n}`;
      const t = now();
      return { ...m, id, source: 'user', createdAt: t, updatedAt: t };
    },
    async export(id) {
      const m = store.get(id);
      const r = await dialog.showSaveDialog(getWindow() ?? undefined, { defaultPath: `${m.id}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] });
      if (r.canceled || !r.filePath) return null;
      fsx.writeFileSync(r.filePath, `${JSON.stringify(m, null, 2)}\n`, 'utf8');
      return { path: r.filePath };
    },
  };
  return store;
}
