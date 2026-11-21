// Project file access for the renderer: every path is relative to the project root and strictly guarded.
import fs from 'node:fs';
import path from 'node:path';

export const IGNORED = new Set(['.git', 'node_modules', '.venv', '__pycache__']);
export const MAX_ENTRIES = 2000;
export const MAX_TEXT = 1024 * 1024;
export const MAX_IMAGE = 5 * 1024 * 1024;
export const REFUSED_OPEN = new Set(['.exe', '.bat', '.cmd', '.com', '.msi', '.scr', '.lnk', '.ps1', '.vbs', '.wsf', '.jar', '.reg', '.hta',
  '.vbe', '.jse', '.pif', '.msc', '.cpl', '.url', '.psm1', '.msp', '.appx', '.msix']);

const IMAGE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
const LANGS = {
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript', '.ts': 'typescript', '.tsx': 'typescript',
  '.json': 'json', '.py': 'python', '.css': 'css', '.scss': 'scss', '.xml': 'xml', '.yml': 'yaml', '.yaml': 'yaml', '.toml': 'ini', '.ini': 'ini',
  '.sh': 'bash', '.ps1': 'powershell', '.bat': 'dos', '.cmd': 'dos', '.java': 'java', '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.hpp': 'cpp',
  '.cs': 'csharp', '.go': 'go', '.rs': 'rust', '.rb': 'ruby', '.php': 'php', '.sql': 'sql', '.r': 'r', '.kt': 'kotlin', '.swift': 'swift',
  '.txt': 'plaintext', '.log': 'plaintext', '.csv': 'plaintext', '.tsv': 'plaintext', '.env': 'ini', '.gitignore': 'plaintext', '.cfg': 'ini',
  '.ipynb': 'json', '.lock': 'plaintext',
};
const NAMED = { dockerfile: 'dockerfile', makefile: 'makefile', license: 'plaintext', readme: 'plaintext' };

/** Pure: classify a relative path by name. -> {kind:'markdown'|'html'|'image'|'text'|'binary', lang?, mime?} */
export function classify(rel) {
  const base = path.posix.basename(String(rel).replace(/\\/g, '/')).toLowerCase();
  const ext = path.posix.extname(base);
  if (ext === '.md' || ext === '.markdown') return { kind: 'markdown', lang: 'markdown' };
  if (ext === '.html' || ext === '.htm') return { kind: 'html', lang: 'xml' };
  if (IMAGE_MIME[ext]) return { kind: 'image', mime: IMAGE_MIME[ext] };
  if (LANGS[ext]) return { kind: 'text', lang: LANGS[ext] };
  if (NAMED[base]) return { kind: 'text', lang: NAMED[base] };
  return { kind: 'binary' };
}

const sameOrInside = (root, p) => {
  const r = path.relative(root.toLowerCase(), p.toLowerCase());
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
};

function nearestRealpath(fsx, p) {
  let cur = p;
  for (;;) {
    try { return { real: (fsx.realpathSync.native ?? fsx.realpathSync)(cur), rest: path.relative(cur, p) }; } catch { /* go up */ }
    const up = path.dirname(cur);
    if (up === cur) throw new Error('Path not resolvable');
    cur = up;
  }
}

/**
 * Resolve a project-relative path. Throws on absolute paths, '..', UNC, drive letters / alternate data streams (':'),
 * NUL and on symlinks/junctions that resolve outside the project. Returns {abs, rel} (rel uses forward slashes).
 */
export function resolveInside(root, rel = '', fsx = fs) {
  if (typeof rel !== 'string') throw new TypeError('path must be a string');
  if (rel.length > 1024) throw new TypeError('path too long');
  if (rel.includes('\0')) throw new Error('Invalid path');
  if (rel.includes(':')) throw new Error('Invalid path (drive or stream)');
  const norm = rel.replace(/\\/g, '/');
  if (norm.startsWith('/') || path.isAbsolute(rel)) throw new Error('Absolute paths are not allowed');
  const parts = norm.split('/').filter((s) => s !== '' && s !== '.');
  for (const s of parts) {
    if (s === '..' || /^[. ]+$/.test(s)) throw new Error('Path traversal is not allowed');
  }
  const realRoot = (fsx.realpathSync.native ?? fsx.realpathSync)(root);
  const abs = path.join(realRoot, ...parts);
  if (!sameOrInside(realRoot, abs)) throw new Error('Path escapes the project');
  const { real, rest } = nearestRealpath(fsx, abs);
  if (!sameOrInside(realRoot, real)) throw new Error('Path escapes the project');
  return { abs: rest ? path.join(real, rest) : real, rel: parts.join('/') };
}

export function createFiles({ getProject, shell, fsx = fs, push = () => {}, debounceMs = 300 } = {}) {
  let watcher = null; // {projectId, w, timer, pending:Set}

  const need = (id) => {
    const p = typeof id === 'string' ? getProject(id) : null;
    if (!p) throw new Error('Unknown project');
    return p;
  };

  function closeWatcher(onlyProjectId) {
    if (!watcher || (onlyProjectId !== undefined && watcher.projectId !== onlyProjectId)) return;
    clearTimeout(watcher.timer);
    try { watcher.w.close(); } catch { /* ignore */ }
    watcher = null;
  }

  function list(projectId, relDir = '') {
    const p = need(projectId);
    const { abs, rel } = resolveInside(p.path, relDir, fsx);
    let names;
    try { names = fsx.readdirSync(abs, { withFileTypes: true }); } catch { throw new Error('Cannot read folder'); }
    const ents = names.filter((d) => !IGNORED.has(d.name) && !d.isSymbolicLink() && (d.isDirectory() || d.isFile()));
    ents.sort((x, y) => (x.isDirectory() === y.isDirectory() ? x.name.localeCompare(y.name, undefined, { sensitivity: 'base' }) : x.isDirectory() ? -1 : 1));
    const out = [];
    for (const d of ents.slice(0, MAX_ENTRIES)) {
      const isDir = d.isDirectory();
      let st;
      try { st = fsx.statSync(path.join(abs, d.name)); } catch { continue; }
      out.push({ name: d.name, rel: rel ? `${rel}/${d.name}` : d.name, isDir, size: isDir ? 0 : st.size, mtimeMs: st.mtimeMs });
    }
    return out;
  }

  function readHead(abs, max) {
    const fd = fsx.openSync(abs, 'r');
    try {
      const buf = Buffer.alloc(max);
      const n = fsx.readSync(fd, buf, 0, max, 0);
      return buf.subarray(0, n);
    } finally { fsx.closeSync(fd); }
  }

  function read(projectId, relPath) {
    const p = need(projectId);
    const { abs, rel } = resolveInside(p.path, relPath, fsx);
    const st = fsx.statSync(abs);
    if (!st.isFile()) throw new Error('Not a file');
    const c = classify(rel);
    const size = st.size;
    if (c.kind === 'binary') return { kind: 'binary', size, truncated: false };
    if (c.kind === 'image') {
      if (size > MAX_IMAGE) return { kind: 'binary', size, truncated: true };
      return { kind: 'image', size, truncated: false, dataUrl: `data:${c.mime};base64,${fsx.readFileSync(abs).toString('base64')}` };
    }
    const buf = readHead(abs, Math.min(size, MAX_TEXT));
    if (buf.includes(0)) return { kind: 'binary', size, truncated: false };
    const out = { kind: c.kind, size, truncated: size > MAX_TEXT, content: buf.toString('utf8') };
    if (c.lang) out.lang = c.lang;
    return out;
  }

  const target = (projectId, relPath) => resolveInside(need(projectId).path, relPath, fsx).abs;

  return {
    list, read, closeWatcher,
    async reveal(projectId, relPath) { shell.showItemInFolder(target(projectId, relPath)); },
    async open(projectId, relPath) {
      const abs = target(projectId, relPath);
      const ext = path.extname(abs).toLowerCase();
      if (REFUSED_OPEN.has(ext)) throw new Error(`Opening ${ext} files is not allowed`);
      const err = await shell.openPath(abs);
      if (err) throw new Error(`Could not open file: ${err}`);
    },
    watch(projectId) {
      const p = need(projectId);
      if (watcher?.projectId === projectId) return;
      closeWatcher();
      const root = (fsx.realpathSync.native ?? fsx.realpathSync)(p.path);
      const cur = { projectId, w: null, timer: null, pending: new Set() };
      const flush = () => {
        cur.timer = null;
        const changed = [...cur.pending].slice(0, 200);
        cur.pending.clear();
        if (changed.length && watcher === cur) push({ projectId, changed });
      };
      try {
        cur.w = fsx.watch(root, { recursive: true }, (_evt, filename) => {
          if (!filename) return;
          const rel = String(filename).replace(/\\/g, '/');
          if (rel.split('/').some((s) => IGNORED.has(s))) return;
          cur.pending.add(rel);
          if (!cur.timer) cur.timer = setTimeout(flush, debounceMs);
        });
        cur.w.on?.('error', () => closeWatcher());
      } catch (e) {
        throw new Error(`Cannot watch folder: ${e.message}`);
      }
      watcher = cur;
    },
  };
}
