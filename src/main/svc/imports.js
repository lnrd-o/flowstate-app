// Office cases: native file picker, safe COPY of a user file into <project>/data/, default projects folder.
import fs from 'node:fs';
import path from 'node:path';
import nodeOs from 'node:os';
import { resolveInside } from '../files.js';
import { folderNameFromTitle, uniqueFolderName } from '../../shared/folder-name.js';
import { layoutFor, detectLayout, layoutNote } from '../../shared/layout.js';

export const MAX_IMPORT_BYTES = 200 * 1024 * 1024;
export const OFFICE_EXT = Object.freeze(['xlsx', 'xlsm', 'xls', 'csv', 'tsv', 'txt', 'json', 'md', 'docx', 'pdf', 'html', 'htm', 'xml']);
export const DATA_EXT = Object.freeze(['csv', 'tsv', 'txt', 'json', 'xlsx', 'xls']);
export const IMAGE_EXT = Object.freeze(['png', 'jpg', 'jpeg', 'gif', 'webp']);
export const IMPORT_EXT = Object.freeze([...OFFICE_EXT, ...IMAGE_EXT]);
export const DATA_DIR = 'data';
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Safe file name for Windows: base name only, no reserved chars/control chars, no trailing dots/spaces, not a device name. */
export function sanitizeName(name) {
  const base = String(name ?? '').split(/[\\/]/).pop().replace(/[\x00-\x1f\x7f<>:"|?*]/g, '_').replace(/[. ]+$/, '').trim();
  const ext = path.extname(base);
  let stem = ext ? base.slice(0, -ext.length) : base;
  stem = stem.replace(/^[. ]+/, '').slice(0, 120);
  if (!stem || /^_*$/.test(stem)) stem = 'file';
  if (WIN_RESERVED.test(stem)) stem = `_${stem}`;
  return `${stem}${ext.slice(0, 12)}`;
}

export function create({ electron, getProject, getWindow = () => null, fsx = fs, dialog, app, settings, os = nodeOs, platform = process.platform } = {}) {
  const dlg = dialog ?? electron?.dialog;
  const application = app ?? electron?.app;
  const need = (id) => {
    const p = typeof id === 'string' ? getProject(id) : null;
    if (!p) throw new Error('Unknown project');
    return p;
  };
  const langNow = () => (settings?.get?.()?.language === 'es' ? 'es' : 'en');
  const layoutOf = (p) => detectLayout((n) => { try { return fsx.statSync(path.join(p.path, n)).isDirectory(); } catch { return false; } }, langNow());
  return {
    /** Prompt note with the project's real data/outputs folder names (null for an unknown project). */
    layoutNote(projectId) { const p = typeof projectId === 'string' ? getProject(projectId) : null; return p ? layoutNote(layoutOf(p)) : null; },
    async pick({ kind = 'office', multi = false } = {}) {
      const filters = kind === 'data' ? [{ name: 'Data', extensions: [...DATA_EXT] }]
        : kind === 'any' ? []
          : [{ name: 'Office files', extensions: [...OFFICE_EXT] }];
      const opts = { properties: multi ? ['openFile', 'multiSelections'] : ['openFile'], ...(filters.length ? { filters } : {}) };
      const win = getWindow();
      const r = win ? await dlg.showOpenDialog(win, opts) : await dlg.showOpenDialog(opts);
      if (!r || r.canceled || !Array.isArray(r.filePaths)) return [];
      return r.filePaths.filter((p) => typeof p === 'string' && path.isAbsolute(p));
    },

    importFile(projectId, sourcePath) {
      const p = need(projectId);
      if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath) || sourcePath.includes('\0')) throw new Error('Invalid file path');
      const ext = path.extname(sourcePath).slice(1).toLowerCase();
      if (!IMPORT_EXT.includes(ext)) throw new Error(`File type .${ext} is not supported`);
      let st;
      try { st = fsx.lstatSync(sourcePath); } catch { throw new Error('File not found'); }
      if (st.isSymbolicLink()) throw new Error('Links are not allowed; pick the real file');
      if (!st.isFile()) throw new Error('Only regular files can be imported');
      if (st.size > MAX_IMPORT_BYTES) throw new Error('File too large (max 200 MB)');
      try { fsx.accessSync(p.path, fs.constants.W_OK); } catch { throw new Error('The project folder is not writable'); }
      const { abs: dir } = resolveInside(p.path, layoutOf(p).data, fsx);
      fsx.mkdirSync(dir, { recursive: true });
      const clean = sanitizeName(path.basename(sourcePath));
      const cext = path.extname(clean);
      const stem = cext ? clean.slice(0, -cext.length) : clean;
      for (let i = 1; i < 1000; i++) {
        const name = i === 1 ? clean : `${stem} (${i})${cext}`;
        try {
          fsx.copyFileSync(sourcePath, path.join(dir, name), fs.constants.COPYFILE_EXCL);
        } catch (e) {
          if (e?.code === 'EEXIST') continue;
          throw new Error(`Could not copy the file: ${e?.message ?? e}`);
        }
        return { rel: `${layoutOf(p).data}/${name}`, name, size: st.size };
      }
      throw new Error('Too many files with the same name');
    },

    defaultDir() {
      const es = settings?.get?.()?.language === 'es';
      let parent = application.getPath('documents');
      if (es) {
        const cands = [path.join(path.dirname(parent), 'Documentos'), path.join(os.homedir(), 'Documentos')];
        for (const c of cands) {
          try { if (fsx.statSync(c).isDirectory()) { parent = c; break; } } catch { /* not there */ }
        }
      }
      const dir = path.join(parent, es ? 'Proyectos' : 'Projects');
      fsx.mkdirSync(dir, { recursive: true });
      return dir;
    },

    /** Create a fresh <default dir>/<Folder_Name_From_Title> -> {path, folder}. */
    newProjectDir(title) {
      const parent = this.defaultDir();
      const lang = settings?.get?.()?.language === 'es' ? 'es' : 'en';
      const base = folderNameFromTitle(title, lang);
      const ci = platform === 'win32';
      const taken = () => new Set(fsx.readdirSync(parent).map((n) => (ci ? n.toLowerCase() : n)));
      const make = (skip) => {
        const set = taken();
        for (const s of skip) set.add(ci ? s.toLowerCase() : s);
        const folder = uniqueFolderName(base, (n) => set.has(ci ? n.toLowerCase() : n));
        const abs = path.join(parent, folder);
        const rel = path.relative(parent, abs);
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel !== folder) throw new Error('Invalid project folder name');
        fsx.mkdirSync(abs); // not recursive: a race fails loudly
        const lay = layoutFor(lang);
        for (const d of [lay.data, lay.outputs]) { try { fsx.mkdirSync(path.join(abs, d)); } catch { /* best effort */ } }
        return { path: abs, folder };
      };
      try { return make([]); } catch (e) {
        if (e?.code !== 'EEXIST') throw e;
        return make([]); // listing is re-read, so the winner of the race is now taken
      }
    },
  };
}
