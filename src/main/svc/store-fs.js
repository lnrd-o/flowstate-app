// Pure-ish filesystem helpers for the <project>/.flowstate/ folder (shared by store, history, attachments, methodologies).
import fs from 'node:fs';
import path from 'node:path';

export const STORE_DIR = '.flowstate';
export const GITIGNORE = 'state.json\nhistory.jsonl\nattachments/\n';
export const ATTACH_REL = `${STORE_DIR}/attachments`;

export const storeDirOf = (projectPath) => path.join(projectPath, STORE_DIR);

/** mkdir .flowstate and create its .gitignore when missing. Throws when the folder is not writable. */
export function ensureStoreDir(projectPath, fsx = fs) {
  const dir = storeDirOf(projectPath);
  fsx.mkdirSync(dir, { recursive: true });
  const gi = path.join(dir, '.gitignore');
  if (!fsx.existsSync(gi)) fsx.writeFileSync(gi, GITIGNORE, 'utf8');
  return dir;
}

/** Read + parse a JSON file; a corrupt file is renamed <file>.corrupt-<ts> and ignored. -> {data|null, corrupt:boolean}. */
export function readJsonSafe(file, { fsx = fs, now = Date.now } = {}) {
  let text;
  try { text = fsx.readFileSync(file, 'utf8'); } catch { return { data: null, corrupt: false }; }
  try {
    const data = JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);
    if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object');
    return { data, corrupt: false };
  } catch {
    try { fsx.renameSync(file, `${file}.corrupt-${now()}`); } catch { /* ignore */ }
    return { data: null, corrupt: true };
  }
}

export function fileSize(file, fsx = fs) { try { return fsx.statSync(file).size; } catch { return 0; } }

export function dirBytes(dir, fsx = fs) {
  let total = 0;
  let names = [];
  try { names = fsx.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const d of names) if (d.isFile()) total += fileSize(path.join(dir, d.name), fsx);
  return total;
}
