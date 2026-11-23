// Computes 'file-change' events (with a real unified diff) for edit/write tool calls: agents like agy only report the
// file Path, so FlowState snapshots the file at tool-use and diffs it at the matching tool-result. Best effort, never throws.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { toolPaths } from '../shared/events.js';
import { resolveInside } from './files.js';
import { unifiedDiff } from './diff.js';

export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_TURN_BYTES = 20 * 1024 * 1024;

const defaultReadFile = (abs) => {
  const st = fs.statSync(abs);
  if (!st.isFile()) throw Object.assign(new Error('not a file'), { code: 'ENOTFILE' });
  if (st.size > MAX_FILE_BYTES) throw Object.assign(new Error('too big'), { code: 'ETOOBIG' });
  return fs.readFileSync(abs);
};
const defaultRealpath = (p) => (fs.realpathSync.native ?? fs.realpathSync)(p);
const defaultGitShowHead = (cwd, rel) => {
  try {
    return execFileSync('git', ['show', `HEAD:${rel}`], { cwd, encoding: 'utf8', maxBuffer: MAX_FILE_BYTES * 2, timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return null; }
};

const ci = process.platform === 'win32' || process.platform === 'darwin';
const inside = (root, p) => {
  const r = ci ? path.relative(root.toLowerCase(), p.toLowerCase()) : path.relative(root, p);
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
};

export function createChangeTracker({ readFile = defaultReadFile, realpath = defaultRealpath, gitShowHead = defaultGitShowHead, now = Date.now } = {}) {
  const turns = new Map(); // projectKey -> { snaps: Map(toolId -> entries[]), bytes }
  const keyOf = (project) => String(project?.id ?? project?.path ?? '');
  const fsx = { realpathSync: Object.assign((p) => realpath(p), { native: (p) => realpath(p) }) };
  void now;

  /** Returns text | {missing:true} | {skip:true}. */
  const snapshot = (abs) => {
    let buf;
    try { buf = readFile(abs); } catch (e) { return e?.code === 'ENOENT' ? { missing: true } : { skip: true }; }
    if (typeof buf === 'string') buf = Buffer.from(buf, 'utf8');
    if (!buf || buf.length > MAX_FILE_BYTES || buf.includes(0)) return { skip: true };
    return { text: buf.toString('utf8') };
  };

  /** Project-relative candidate path -> {abs, rel} when it resolves INSIDE the project (8.3 names and symlinks resolved), else null. */
  const resolve = (project, p) => {
    try {
      const realRoot = realpath(project.path);
      const want = path.isAbsolute(p) ? path.normalize(p) : path.join(project.path, p);
      let cur = want; let real = null; let rest = '';
      for (;;) {
        try { real = realpath(cur); rest = path.relative(cur, want); break; } catch { /* go up */ }
        const up = path.dirname(cur);
        if (up === cur) return null;
        cur = up;
      }
      const realAbs = rest ? path.join(real, rest) : real;
      if (!inside(realRoot, realAbs)) return null;
      const rel = path.relative(realRoot, realAbs).split(path.sep).join('/');
      if (!rel || rel.startsWith('..')) return null;
      return resolveInside(project.path, rel, fsx);
    } catch { return null; }
  };

  const onToolUse = (project, ev, turn) => {
    const seen = new Set(); const entries = [];
    for (const p of toolPaths(ev.input)) {
      const r = resolve(project, p);
      if (!r || seen.has(r.abs)) continue;
      seen.add(r.abs);
      let before = snapshot(r.abs);
      if (before.text !== undefined) {
        if (turn.bytes + before.text.length > MAX_TURN_BYTES) before = { skip: true }; else turn.bytes += before.text.length;
      }
      entries.push({ abs: r.abs, rel: r.rel, before });
    }
    if (entries.length) turn.snaps.set(ev.id, entries);
  };

  const onToolResult = (project, ev, turn) => {
    const entries = turn.snaps.get(ev.id);
    if (!entries) return [];
    turn.snaps.delete(ev.id);
    const out = [];
    for (const { abs, rel, before } of entries) {
      try {
        const after = snapshot(abs);
        if (before.skip || after.skip) continue;
        let beforeText = before.text;
        if (before.missing && after.missing) continue;
        if (beforeText !== undefined && after.text !== undefined && beforeText === after.text) {
          // Race: the tool may have finished before the snapshot. Fall back to the committed version.
          if (ev.isError || !gitShowHead) continue;
          const head = gitShowHead(project.path, rel);
          if (typeof head !== 'string' || head === after.text) continue;
          beforeText = head;
        }
        const op = before.missing ? 'create' : after.missing ? 'delete' : 'modify';
        const d = unifiedDiff(beforeText ?? '', after.text ?? '');
        if (!d.diff && op === 'modify') continue;
        out.push({
          type: 'file-change', id: out.length === 0 ? ev.id : `${ev.id}#${out.length + 1}`, path: rel, op,
          added: d.added, removed: d.removed, diff: d.diff, truncated: d.truncated,
        });
      } catch { /* best effort */ }
    }
    return out;
  };

  return {
    /** Feed every normalised event of a turn. Returns file-change events to emit right after the given tool-result (usually []). */
    observe(project, ev) {
      try {
        if (!project?.path || !ev || typeof ev !== 'object') return [];
        const key = keyOf(project);
        if (ev.type === 'result' || ev.type === 'error') { turns.delete(key); return []; }
        let turn = turns.get(key);
        if (ev.type === 'tool-use') {
          if (ev.kind !== 'edit' && ev.kind !== 'write') return [];
          if (project.agent === 'opencode') return []; // opencode reports finished edits with their own patch (shared/events.js opencodeFileChanges)
          if (!turn) { turn = { snaps: new Map(), bytes: 0 }; turns.set(key, turn); }
          onToolUse(project, ev, turn);
          return [];
        }
        if (ev.type === 'tool-result' && turn) return onToolResult(project, ev, turn);
      } catch { /* best effort */ }
      return [];
    },
    /** Drop all snapshots of a project (turn ended / process died). */
    endTurn(project) { turns.delete(keyOf(project)); },
  };
}
