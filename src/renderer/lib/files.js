// Pure helpers for the file tree (no DOM).

export const ARTIFACTS_DIR = 'artifacts';

/** Human readable size: 512 B, 1.5 KB, 3.2 MB. */
export function formatBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return '';
  if (v < 1024) return Math.round(v) + ' B';
  if (v < 1024 * 1024) return (v / 1024).toFixed(v < 10 * 1024 ? 1 : 0) + ' KB';
  return (v / (1024 * 1024)).toFixed(1) + ' MB';
}

/** Order entries: "artifacts" folder pinned first at the root, then folders, then files, each by name. */
export function sortEntries(entries, parentRel = '') {
  const pinned = (e) => (!parentRel && e.isDir && e.name.toLowerCase() === ARTIFACTS_DIR ? 0 : 1);
  return [...(entries || [])].sort((a, b) => pinned(a) - pinned(b)
    || (a.isDir === b.isDir ? 0 : a.isDir ? -1 : 1)
    || a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
}

export function parentOf(rel) {
  const i = String(rel).lastIndexOf('/');
  return i < 0 ? '' : rel.slice(0, i);
}

export function baseName(rel) {
  return String(rel).split('/').pop();
}

/**
 * Flatten the tree into visible rows: [{ entry, depth, expanded, parent }].
 * children: Map(dirRel -> FileEntry[]), expanded: Set(dirRel).
 */
export function flattenTree(children, expanded, dir = '', depth = 1) {
  const out = [];
  for (const entry of sortEntries(children.get(dir) || [], dir)) {
    const open = entry.isDir && expanded.has(entry.rel);
    out.push({ entry, depth, expanded: open, parent: dir });
    if (open) out.push(...flattenTree(children, expanded, entry.rel, depth + 1));
  }
  return out;
}

/** Normalise a files:list entry's rel to forward slashes. */
export function normRel(rel) {
  return String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
}
