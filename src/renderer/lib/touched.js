// Derive "the last file the agent wrote or edited" from tool-use data (pure, no DOM).

const WRITE_TOOLS = new Set([
  'write', 'edit', 'multiedit', 'write_file', 'replace_file_content', 'multi_replace_file_content',
  'write_to_file', 'create_file', 'edit_file', 'str_replace_editor', 'notebookedit',
]);
const PATH_KEYS = ['file_path', 'path', 'TargetFile', 'target_file', 'AbsolutePath', 'filePath', 'notebook_path'];
const NO_PREVIEW = new Set([
  'exe', 'dll', 'bin', 'zip', 'gz', 'tgz', '7z', 'rar', 'iso', 'class', 'jar', 'so', 'dylib', 'pyc', 'lnk', 'msi',
  'mp3', 'mp4', 'mov', 'avi', 'woff', 'woff2', 'ttf', 'otf', 'ico', 'pdf', 'db', 'sqlite',
]);

const norm = (p) => String(p || '').replace(/\\/g, '/');

/** Is this tool name a file write/edit tool? */
export function isWriteTool(name) {
  return WRITE_TOOLS.has(String(name || '').toLowerCase());
}

/** Raw path argument of a tool input, or null. */
export function toolPath(input) {
  if (!input || typeof input !== 'object') return null;
  for (const k of PATH_KEYS) if (typeof input[k] === 'string' && input[k]) return input[k];
  return null;
}

/**
 * Path relative to the project root with forward slashes, or null when the path is outside the project.
 * Relative inputs are returned normalised (leading "./" removed). Case-insensitive for drive-letter paths.
 */
export function relativeTo(root, p) {
  let path = norm(p).trim();
  if (!path) return null;
  const isAbs = /^[a-zA-Z]:\//.test(path) || path.startsWith('/');
  if (!isAbs) {
    path = path.replace(/^\.\//, '');
    return path.split('/').includes('..') ? null : path;
  }
  const base = norm(root).replace(/\/+$/, '');
  const win = /^[a-zA-Z]:/.test(base);
  const a = win ? path.toLowerCase() : path;
  const b = win ? base.toLowerCase() : base;
  if (a === b || !a.startsWith(b + '/')) return null;
  const rel = path.slice(base.length + 1);
  return rel.split('/').includes('..') ? null : rel;
}

/** Whether a file looks previewable (not a known opaque binary type). */
export function isPreviewable(rel) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(rel || ''));
  return !m || !NO_PREVIEW.has(m[1].toLowerCase());
}

/** Relative path touched by one tool-use (name + input), or null. */
export function touchedPath(name, input, root) {
  if (!isWriteTool(name)) return null;
  const raw = toolPath(input);
  return raw ? relativeTo(root, raw) : null;
}

/**
 * Last previewable file written/edited, scanning chat messages (role 'tool', with name/input/status)
 * from newest to oldest. Failed tool calls are ignored. Returns rel path or null.
 */
export function lastTouchedFile(messages, root) {
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== 'tool' || m.status === 'error' || m.status === 'blocked') continue;
    const rel = touchedPath(m.name, m.input, root);
    if (rel && isPreviewable(rel)) return rel;
  }
  return null;
}
