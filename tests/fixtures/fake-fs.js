// In-memory fs stand-in for platform tests. entries: 'path' | [path, mode?, content?]. Directories are implied.
// style 'win32' uses win32 path rules, anything else posix, independent of the host running the tests.
import path from 'node:path';

export function fakeFs(entries, style = 'posix') {
  const P = style === 'win32' ? path.win32 : path.posix;
  const norm = (p) => { const n = P.normalize(String(p)); return n.length > 1 ? n.replace(/[\\/]+$/, '') : n; };
  const files = new Map();
  for (const e of entries) {
    const [p, mode = 0o755, content = ''] = Array.isArray(e) ? e : [e];
    files.set(norm(p), { mode, content });
  }
  const keys = () => [...files.keys()];
  const isDir = (n) => keys().some((f) => f.startsWith(n + P.sep));
  const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  return {
    existsSync: (p) => { const n = norm(p); return files.has(n) || isDir(n); },
    statSync: (p) => {
      const n = norm(p);
      if (files.has(n)) return { mode: 0o100000 | files.get(n).mode, isDirectory: () => false, isFile: () => true };
      if (isDir(n)) return { mode: 0o40755, isDirectory: () => true, isFile: () => false };
      throw enoent();
    },
    readdirSync: (p) => {
      const n = norm(p) + (norm(p).endsWith(P.sep) ? '' : P.sep);
      const kids = new Set(keys().filter((f) => f.startsWith(n)).map((f) => f.slice(n.length).split(P.sep)[0]));
      if (!kids.size) throw enoent();
      return [...kids];
    },
    readFileSync: (p) => { const f = files.get(norm(p)); if (!f) throw enoent(); return f.content; },
  };
}
