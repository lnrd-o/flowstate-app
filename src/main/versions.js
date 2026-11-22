// Versions: timeline of commits/checkpoints, named versions (tags), compare, restore and a safe branch handler.
// Every git call goes through execFile with an argument array (no shell); names are validated with `git check-ref-format`
// rules plus a no-leading-dash rule so a value can never be read as an option. Nothing here forces, rewrites history or pushes.
import { runCommand } from './run.js';
import { AUTO_BRANCH, COMMIT_PREFIX, isSecretPath, parsePorcelainZ } from './git.js';
import { unifiedDiff } from './diff.js';
import fs from 'node:fs';
import path from 'node:path';

export const WORKING = 'WORKING';
export const DIFF_CAP = 200 * 1024;
export const DEFAULT_LIMIT = 200;
export const MAX_LIMIT = 500;
const US = '\x1f';
const RS = '\x1e';
const SHA_RE = /^[0-9a-f]{7,40}$/i;

const fail = (reason, message, extra = {}) => ({ ok: false, reason, message, ...extra });

/** "My first idea!" -> "my-first-idea" (ref-safe, never empty). */
export function slugify(label) {
  const s = String(label ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '');
  return s || 'version';
}

/** Parse `%D` decoration text ("HEAD -> main, tag: v1, origin/x") into {head, branches, tags}. */
export function parseDecorations(d) {
  const out = { head: false, branches: [], tags: [] };
  for (let part of String(d ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
    if (part.startsWith('HEAD -> ')) { out.head = true; part = part.slice(8); }
    else if (part === 'HEAD') { out.head = true; continue; }
    if (part.startsWith('tag: ')) out.tags.push(part.slice(5));
    else if (!part.includes('/HEAD')) out.branches.push(part);
  }
  return out;
}

export function parseTrailers(body) {
  const t = {};
  for (const line of String(body ?? '').split(/\r?\n/)) {
    const m = /^Flowstate-(Agent|Methodology):\s*(.+)$/.exec(line.trim());
    if (m) t[m[1].toLowerCase()] = m[2].trim();
  }
  return t;
}

/** Parse the `git log` output produced by TIMELINE_FORMAT (+ --numstat). */
export function parseLog(out) {
  const commits = [];
  for (const chunk of String(out).split(RS)) {
    if (!chunk.trim()) continue;
    const f = chunk.replace(/^\r?\n/, '').split(US);
    if (f.length < 7) continue;
    const [sha, parents, at, deco, subject, body] = f;
    const rest = f.slice(6).join(US);
    let files = 0; let added = 0; let removed = 0;
    for (const l of rest.split(/\r?\n/)) {
      const m = /^(\d+|-)\t(\d+|-)\t/.exec(l);
      if (!m) continue;
      files++; added += m[1] === '-' ? 0 : Number(m[1]); removed += m[2] === '-' ? 0 : Number(m[2]);
    }
    const d = parseDecorations(deco);
    const tr = parseTrailers(body);
    const parentList = parents.trim() ? parents.trim().split(' ') : [];
    commits.push({
      sha, short: sha.slice(0, 7), parents: parentList, time: Number(at) * 1000, subject,
      files, added, removed, branches: d.branches, tags: d.tags, head: d.head,
      auto: subject.startsWith(COMMIT_PREFIX), merge: parentList.length > 1,
      ...(tr.agent ? { agent: tr.agent } : {}), ...(tr.methodology ? { methodology: tr.methodology } : {}),
    });
  }
  return commits;
}

/** Add `prompt` to auto-commits whose subject matches the start of a user message recorded before the commit. Pure. */
export function attachPrompts(commits, userRecords) {
  const users = (userRecords ?? []).filter((r) => r && r.t === 'user' && typeof r.text === 'string')
    .map((r) => ({ ts: r.ts, text: r.text, key: r.text.replace(/\s+/g, ' ').trim().slice(0, 60) }));
  return commits.map((c) => {
    if (!c.auto) return c;
    const want = c.subject.slice(COMMIT_PREFIX.length).trim();
    if (!want) return c;
    let hit = null;
    for (const u of users) if (u.key === want && u.ts <= c.time + 60000 && (!hit || u.ts > hit.ts)) hit = u;
    return hit ? { ...c, prompt: hit.text.slice(0, 500) } : c;
  });
}

export function createVersions({ run = runCommand, gitCmd = 'git', now = Date.now, fsx = fs } = {}) {
  const g = (cwd, args, timeout = 30000) => run(gitCmd, args, { cwd, timeout });
  const out = async (cwd, args) => { const r = await g(cwd, args); return r.code === 0 ? r.stdout.trim() : null; };

  const isRepo = async (cwd) => (await out(cwd, ['rev-parse', '--is-inside-work-tree'])) === 'true';
  const hasCommits = async (cwd) => (await g(cwd, ['rev-parse', '--verify', '-q', 'HEAD'])).code === 0;
  const currentBranch = async (cwd) => (await out(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']));
  async function identity(cwd) {
    const [n, e] = await Promise.all([out(cwd, ['config', 'user.name']), out(cwd, ['config', 'user.email'])]);
    const a = [];
    if (!n) a.push('-c', 'user.name=FlowState');
    if (!e) a.push('-c', 'user.email=flowstate@localhost');
    return a;
  }
  async function dirtyFiles(cwd) {
    const s = await g(cwd, ['status', '--porcelain', '-z', '-uall']);
    return parsePorcelainZ(s.stdout);
  }

  async function validName(cwd, kind, name) {
    if (typeof name !== 'string' || !name.trim() || name.length > 100 || name !== name.trim() || name.startsWith('-') || /[\0\r\n]/.test(name)) return false;
    if (kind === 'branch') return (await g(cwd, ['check-ref-format', `refs/heads/${name}`])).code === 0 && name !== 'HEAD';
    return (await g(cwd, ['check-ref-format', `refs/tags/${name}`])).code === 0;
  }
  /** Resolve a user-supplied ref (sha, branch or tag) to a full commit sha, or null. */
  async function resolveRef(cwd, ref) {
    if (typeof ref !== 'string' || !ref || ref.length > 200 || ref.startsWith('-') || /[\0\r\n]/.test(ref)) return null;
    for (const cand of SHA_RE.test(ref) ? [ref] : [`refs/heads/${ref}`, `refs/tags/${ref}`]) {
      const r = await out(cwd, ['rev-parse', '--verify', '--quiet', `${cand}^{commit}`]);
      if (r) return r;
    }
    return null;
  }
  const validRelPath = (p) => typeof p === 'string' && p.length > 0 && p.length < 1024 && !path.isAbsolute(p) && !/[\0\r\n]/.test(p)
    && !p.replace(/\\/g, '/').split('/').some((s) => s === '..') && !p.startsWith('-');

  /** Commit the current (dirty) state on the CURRENT branch so nothing is ever lost. -> {ok, committed, sha} */
  async function checkpointCommit(cwd, message) {
    const id = await identity(cwd);
    if (!(await hasCommits(cwd))) {
      const r = await g(cwd, [...id, 'commit', '--allow-empty', '-m', `${COMMIT_PREFIX} initial snapshot`]);
      if (r.code !== 0) return fail('commit-failed', r.stderr.trim());
    }
    const files = (await dirtyFiles(cwd)).filter((f) => !isSecretPath(f.path));
    if (!files.length) return { ok: true, committed: false, sha: await out(cwd, ['rev-parse', 'HEAD']) };
    const add = await g(cwd, ['add', '-A', '--', ...files.map((f) => f.path)]);
    if (add.code !== 0) return fail('add-failed', add.stderr.trim());
    if ((await g(cwd, ['diff', '--cached', '--quiet'])).code === 0) return { ok: true, committed: false, sha: await out(cwd, ['rev-parse', 'HEAD']) };
    const c = await g(cwd, [...id, 'commit', '-m', message]);
    if (c.code !== 0) return fail('commit-failed', c.stderr.trim());
    return { ok: true, committed: true, sha: await out(cwd, ['rev-parse', 'HEAD']) };
  }

  /** A tag name nobody uses yet: base, base-2, base-3 ... */
  async function freeTag(cwd, base) {
    for (let i = 1; i < 200; i++) {
      const name = i === 1 ? base : `${base}-${i}`;
      if (!(await out(cwd, ['rev-parse', '--verify', '--quiet', `refs/tags/${name}`]))) return name;
    }
    return `${base}-${now()}`;
  }
  const stamp = () => new Date(now()).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'z').toLowerCase().replace('t', '-');

  async function tagHead(cwd, name, message, target = 'HEAD') {
    const id = await identity(cwd);
    const r = await g(cwd, [...id, 'tag', '-a', '-m', message, name, target]);
    return r.code === 0 ? { ok: true } : fail('tag-failed', r.stderr.trim());
  }

  /** Safety checkpoint before a risky operation: commits the dirty tree (current branch) and tags it. */
  async function safety(cwd, why) {
    const cp = await checkpointCommit(cwd, `${COMMIT_PREFIX} checkpoint before ${why}`);
    if (!cp.ok) return cp;
    const tag = await freeTag(cwd, `checkpoint/auto-${stamp()}`);
    const t = await tagHead(cwd, tag, `Automatic checkpoint before ${why}`);
    return t.ok ? { ok: true, tag, sha: cp.sha, committed: cp.committed } : t;
  }

  async function listTags(cwd) {
    const r = await out(cwd, ['for-each-ref', 'refs/tags', `--format=%(refname:short)${US}%(objectname)${US}%(*objectname)${US}%(creatordate:unix)${US}%(contents:subject)${US}%(contents:body)${RS}`]);
    if (!r) return [];
    const tags = [];
    for (const rec of r.split(RS)) {
      const f = rec.replace(/^\s+/, '').split(US);
      if (f.length < 6 || !f[0]) continue;
      const auto = f[0].startsWith('checkpoint/auto-');
      tags.push({ name: f[0], sha: f[2] || f[1], time: Number(f[3]) * 1000, label: f[4] || f[0], note: f[5].trim(), auto });
    }
    return tags.sort((a, b) => b.time - a.time);
  }

  async function listBranches(cwd, cur) {
    const r = await out(cwd, ['for-each-ref', 'refs/heads', `--format=%(refname:short)${US}%(objectname)${US}%(committerdate:unix)${US}%(contents:subject)${RS}`]);
    if (!r) return [];
    const merged = new Set(((await out(cwd, ['branch', '--merged', 'HEAD', '--format=%(refname:short)'])) ?? '').split(/\r?\n/).filter(Boolean));
    const res = [];
    for (const rec of r.split(RS)) {
      const f = rec.replace(/^\s+/, '').split(US);
      if (f.length < 4 || !f[0]) continue;
      let ahead = 0; let behind = 0;
      if (cur && f[0] !== cur) {
        const lr = await out(cwd, ['rev-list', '--left-right', '--count', `refs/heads/${cur}...refs/heads/${f[0]}`]);
        if (lr) { const [b, a] = lr.split(/\s+/).map(Number); behind = b || 0; ahead = a || 0; }
      }
      res.push({ name: f[0], sha: f[1], short: f[1].slice(0, 7), time: Number(f[2]) * 1000, subject: f[3], current: f[0] === cur, ahead, behind,
        merged: f[0] !== cur && merged.has(f[0]), auto: f[0] === AUTO_BRANCH });
    }
    return res.sort((a, b) => Number(b.current) - Number(a.current) || b.time - a.time);
  }

  async function mergeBase(cwd, a, b) { return out(cwd, ['merge-base', a, b]); }

  return {
    slugify,

    /** Timeline + branches + tags in one call. */
    async list(cwd, { limit = DEFAULT_LIMIT } = {}) {
      if (!(await isRepo(cwd))) return { isRepo: false, current: null, autoBranch: AUTO_BRANCH, dirty: 0, commits: [], branches: [], tags: [] };
      const n = Math.min(Math.max(Number.isInteger(limit) ? limit : DEFAULT_LIMIT, 1), MAX_LIMIT);
      const cur = await currentBranch(cwd);
      const dirty = (await dirtyFiles(cwd)).length;
      let commits = [];
      if (await hasCommits(cwd)) {
        const log = await g(cwd, ['log', '--branches', '--tags', 'HEAD', '--topo-order', `-n${n}`, '--numstat', `--format=${RS}%H${US}%P${US}%at${US}%D${US}%s${US}%b${US}`], 60000);
        if (log.code === 0) commits = parseLog(log.stdout);
      }
      return { isRepo: true, current: cur, autoBranch: AUTO_BRANCH, dirty, commits, branches: await listBranches(cwd, cur), tags: await listTags(cwd) };
    },

    /** Named version: checkpoint dirty work, then tag HEAD with label + note. */
    async save(cwd, { label, note = '', ref } = {}) {
      if (typeof label !== 'string' || !label.trim() || label.length > 80 || /[\0\r\n]/.test(label)) return fail('invalid-label', 'A short label is required');
      if (typeof note !== 'string' || note.length > 2000 || note.includes('\0')) return fail('invalid-note', 'Note too long');
      if (!(await isRepo(cwd))) return fail('not-repo', 'Not a git repository');
      let cp;
      if (ref) { // name an older point of the timeline: tag that commit, leave the working files alone
        const sha = await resolveRef(cwd, ref);
        if (!sha) return fail('bad-ref', 'Unknown version');
        cp = { ok: true, committed: false, sha };
      } else {
        cp = await checkpointCommit(cwd, `${COMMIT_PREFIX} version: ${label.trim()}`);
        if (!cp.ok) return cp;
      }
      const name = await freeTag(cwd, `checkpoint/${slugify(label)}`);
      if (!(await validName(cwd, 'tag', name))) return fail('invalid-name', 'Could not build a valid name');
      const t = await tagHead(cwd, name, note.trim() ? `${label.trim()}\n\n${note.trim()}` : label.trim(), cp.sha);
      return t.ok ? { ok: true, tag: name, sha: cp.sha, committed: cp.committed } : t;
    },

    /** Compare two refs (or WORKING). -> {files:[{path,status,added,removed}]}; with `path` -> {diff}. */
    async compare(cwd, { from, to = WORKING, path: file } = {}) {
      if (!(await isRepo(cwd))) return fail('not-repo', 'Not a git repository');
      const a = await resolveRef(cwd, from);
      if (!a) return fail('bad-ref', 'Unknown version');
      const working = to === WORKING;
      const b = working ? null : await resolveRef(cwd, to);
      if (!working && !b) return fail('bad-ref', 'Unknown version');
      const range = working ? [a] : [a, b];
      if (file !== undefined) {
        if (!validRelPath(file)) return fail('bad-path', 'Invalid file');
        const d = await g(cwd, ['diff', '--no-color', '--no-ext-diff', '-M', ...range, '--', file], 60000);
        let diff = d.stdout;
        if (working && !diff) { // untracked file: show it as added
          const tracked = await out(cwd, ['ls-files', '--', file]);
          if (!tracked) { try { diff = unifiedDiff('', fsx.readFileSync(path.join(cwd, file), 'utf8')).diff; } catch { /* binary/missing */ } }
        }
        const truncated = diff.length > DIFF_CAP;
        return { ok: true, diff: truncated ? `${diff.slice(0, DIFF_CAP)}\n[truncated]` : diff, truncated };
      }
      const ns = await g(cwd, ['diff', '--name-status', '-M', '-z', ...range], 60000);
      const nu = await g(cwd, ['diff', '--numstat', '-M', '-z', ...range], 60000);
      const files = new Map();
      const toks = ns.stdout.split('\0').filter((x, i, arr) => x !== '' || i < arr.length - 1);
      for (let i = 0; i < toks.length;) {
        const st = toks[i++]; if (!st) continue;
        if (st[0] === 'R' || st[0] === 'C') { const from2 = toks[i++]; const to2 = toks[i++]; files.set(to2, { path: to2, from: from2, status: st[0], added: 0, removed: 0 }); }
        else { const p = toks[i++]; files.set(p, { path: p, status: st[0], added: 0, removed: 0 }); }
      }
      const nt = nu.stdout.split('\0');
      for (let i = 0; i < nt.length; i++) {
        const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(nt[i]);
        if (!m) continue;
        let p = m[3];
        if (p === '') { i += 2; p = nt[i]; } // rename: next two tokens are old and new
        const f = files.get(p); if (f) { f.added = m[1] === '-' ? 0 : Number(m[1]); f.removed = m[2] === '-' ? 0 : Number(m[2]); }
      }
      if (working) {
        const u = await g(cwd, ['ls-files', '--others', '--exclude-standard', '-z']);
        for (const p of u.stdout.split('\0').filter(Boolean)) {
          if (isSecretPath(p) || files.has(p)) continue;
          let added = 0;
          try { const txt = fsx.readFileSync(path.join(cwd, p), 'utf8'); added = txt ? txt.split('\n').length - (txt.endsWith('\n') ? 1 : 0) : 0; } catch { /* binary */ }
          files.set(p, { path: p, status: 'A', added, removed: 0 });
        }
      }
      const list = [...files.values()].sort((x, y) => x.path.localeCompare(y.path));
      return { ok: true, files: list, added: list.reduce((s, f) => s + f.added, 0), removed: list.reduce((s, f) => s + f.removed, 0) };
    },

    /** Restore one file or the whole project to `ref`. Always checkpoints first; the result carries the safety tag for undo. */
    async restore(cwd, { ref, path: file } = {}) {
      if (!(await isRepo(cwd))) return fail('not-repo', 'Not a git repository');
      const sha = await resolveRef(cwd, ref);
      if (!sha) return fail('bad-ref', 'Unknown version');
      if (file !== undefined && !validRelPath(file)) return fail('bad-path', 'Invalid file');
      const sf = await safety(cwd, file ? `restoring ${file}` : 'restoring a version');
      if (!sf.ok) return sf;
      if (file !== undefined) {
        const exists = (await g(cwd, ['cat-file', '-e', `${sha}:${file}`])).code === 0;
        if (exists) {
          const r = await g(cwd, ['restore', `--source=${sha}`, '--worktree', '--staged', '--', file]);
          if (r.code !== 0) return fail('restore-failed', r.stderr.trim(), { safety: sf.tag });
        } else {
          const r = await g(cwd, ['rm', '-r', '-f', '--ignore-unmatch', '--', file]);
          if (r.code !== 0) return fail('restore-failed', r.stderr.trim(), { safety: sf.tag });
        }
      } else {
        const r = await g(cwd, ['restore', `--source=${sha}`, '--worktree', '--staged', '--', '.'], 60000);
        if (r.code !== 0) return fail('restore-failed', r.stderr.trim(), { safety: sf.tag });
        // files added after that version are no longer tracked in it: remove them (they stay recoverable through the safety tag)
        const added = (await g(cwd, ['diff', '--name-only', '--diff-filter=A', '-z', sha, sf.sha])).stdout.split('\0').filter(Boolean);
        for (let i = 0; i < added.length; i += 50) await g(cwd, ['rm', '-f', '--ignore-unmatch', '--', ...added.slice(i, i + 50)]);
      }
      const id = await identity(cwd);
      const short = sha.slice(0, 7);
      const c = await g(cwd, [...id, 'commit', '-m', `${COMMIT_PREFIX} restored ${file ? `${file} from` : 'project to'} ${short}`]);
      const committed = c.code === 0;
      return { ok: true, safety: sf.tag, committed, scope: file ? 'file' : 'project', ref: short };
    },

    /** Branch handler. op: create | switch | rename | delete | previewMerge | merge. */
    async branch(cwd, req = {}) {
      if (!(await isRepo(cwd))) return fail('not-repo', 'Not a git repository');
      const cur = await currentBranch(cwd);
      const op = req.op;
      if (op === 'create') {
        if (!(await validName(cwd, 'branch', req.name))) return fail('invalid-name', 'That name cannot be used for a branch');
        if (await out(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${req.name}`])) return fail('exists', 'A branch with that name already exists');
        const sha = req.from ? await resolveRef(cwd, req.from) : await out(cwd, ['rev-parse', '--verify', '-q', 'HEAD']);
        if (!sha) return fail('bad-ref', 'Unknown version');
        let sw = { ok: true };
        if (req.switch !== false) sw = await this.branchSwitchTo(cwd, req.name, sha, true);
        else { const r = await g(cwd, ['branch', req.name, sha]); if (r.code !== 0) return fail('failed', r.stderr.trim()); }
        return sw.ok ? { ok: true, name: req.name, ...(sw.safety ? { safety: sw.safety } : {}) } : sw;
      }
      if (op === 'switch') return this.branchSwitchTo(cwd, req.name, null, false);
      if (op === 'rename') {
        if (!(await validName(cwd, 'branch', req.name)) || !(await validName(cwd, 'branch', req.to))) return fail('invalid-name', 'That name cannot be used for a branch');
        if (req.name === AUTO_BRANCH) return fail('protected', 'The automatic-saves branch keeps its name');
        if (!(await out(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${req.name}`]))) return fail('bad-ref', 'Unknown branch');
        if (await out(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${req.to}`])) return fail('exists', 'A branch with that name already exists');
        const r = await g(cwd, ['branch', '-m', req.name, req.to]);
        return r.code === 0 ? { ok: true, name: req.to } : fail('failed', r.stderr.trim());
      }
      if (op === 'delete') {
        if (!(await validName(cwd, 'branch', req.name))) return fail('invalid-name', 'Unknown branch');
        if (req.name === cur) return fail('current', 'You are on this branch; switch away first');
        if (!(await out(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${req.name}`]))) return fail('bad-ref', 'Unknown branch');
        const merged = ((await out(cwd, ['branch', '--merged', 'HEAD', '--format=%(refname:short)'])) ?? '').split(/\r?\n/);
        if (!merged.includes(req.name)) return fail('not-merged', 'This branch has work that is not in your current branch yet');
        const r = await g(cwd, ['branch', '-d', req.name]); // -d (never -D): git itself refuses unmerged branches
        return r.code === 0 ? { ok: true } : fail('failed', r.stderr.trim());
      }
      if (op === 'previewMerge') return this.mergePreview(cwd, req.name, cur);
      if (op === 'merge') return this.mergeInto(cwd, req.name, cur);
      return fail('bad-op', 'Unknown operation');
    },

    async branchSwitchTo(cwd, name, startPoint, create) {
      const cur = await currentBranch(cwd);
      if (!create && !(await validName(cwd, 'branch', name))) return fail('invalid-name', 'Unknown branch');
      if (!create && !(await out(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]))) return fail('bad-ref', 'Unknown branch');
      if (name === cur) return { ok: true, name, unchanged: true };
      let sf = null;
      const dirty = (await dirtyFiles(cwd)).filter((f) => !isSecretPath(f.path));
      if (dirty.length) {
        sf = await safety(cwd, `switching to ${name}`);
        if (!sf.ok) return sf;
      }
      const args = create ? ['checkout', '-b', name, startPoint] : ['checkout', name];
      const r = await g(cwd, args, 60000);
      if (r.code !== 0) return fail('switch-failed', r.stderr.trim(), sf ? { safety: sf.tag } : {});
      return { ok: true, name, ...(sf ? { safety: sf.tag } : {}) };
    },

    /** Plain-language merge preview without touching the working tree (git merge-tree). */
    async mergePreview(cwd, name, cur) {
      if (!cur) return fail('detached', 'Switch to a branch first');
      if (!(await validName(cwd, 'branch', name)) || !(await out(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]))) return fail('bad-ref', 'Unknown branch');
      if (name === cur) return fail('same', 'Pick a different branch');
      const head = `refs/heads/${cur}`; const other = `refs/heads/${name}`;
      const upToDate = (await g(cwd, ['merge-base', '--is-ancestor', other, head])).code === 0;
      if (upToDate) return { ok: true, upToDate: true, fastForward: false, conflicts: [], files: [], added: 0, removed: 0 };
      const fastForward = (await g(cwd, ['merge-base', '--is-ancestor', head, other])).code === 0;
      const base = await mergeBase(cwd, head, other);
      const cmp = base ? await this.compare(cwd, { from: base, to: name }) : { files: [], added: 0, removed: 0 };
      const mt = await g(cwd, ['merge-tree', '--write-tree', '--name-only', '--no-messages', head, other], 60000);
      let conflicts = [];
      let predicted = true;
      if (mt.code === 1) conflicts = mt.stdout.split(/\r?\n/).slice(1).map((x) => x.trim()).filter(Boolean);
      else if (mt.code !== 0) predicted = false; // old git: no prediction available
      return { ok: true, upToDate: false, fastForward, predicted, conflicts, files: cmp.files ?? [], added: cmp.added ?? 0, removed: cmp.removed ?? 0, into: cur, from: name };
    },

    /** Merge `name` into the current branch. Dirty work is checkpointed first; conflicts abort the merge cleanly. Never forces. */
    async mergeInto(cwd, name, cur) {
      const prev = await this.mergePreview(cwd, name, cur);
      if (!prev.ok) return prev;
      if (prev.upToDate) return { ok: true, upToDate: true };
      let sf = null;
      if ((await dirtyFiles(cwd)).filter((f) => !isSecretPath(f.path)).length) {
        sf = await safety(cwd, `merging ${name}`);
        if (!sf.ok) return sf;
      }
      const id = await identity(cwd);
      const r = await g(cwd, [...id, 'merge', '--no-edit', '-m', `${COMMIT_PREFIX} merged ${name} into ${cur}`, `refs/heads/${name}`], 60000);
      if (r.code === 0) return { ok: true, merged: true, fastForward: prev.fastForward, files: prev.files.length, ...(sf ? { safety: sf.tag } : {}) };
      const conflicts = ((await out(cwd, ['diff', '--name-only', '--diff-filter=U'])) ?? '').split(/\r?\n/).filter(Boolean);
      const merging = (await g(cwd, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).code === 0;
      if (merging) await g(cwd, ['merge', '--abort']);
      return fail('conflict', conflicts.length ? 'The two lines of work changed the same parts of some files' : r.stderr.trim(),
        { conflicts: conflicts.length ? conflicts : prev.conflicts, raw: (r.stdout + r.stderr).trim().slice(0, 4000), ...(sf ? { safety: sf.tag } : {}) });
    },
  };
}
