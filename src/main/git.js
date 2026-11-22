import { runCommand } from './run.js';

export const AUTO_BRANCH = 'claude/auto';
export const COMMIT_PREFIX = 'flowstate:';
const SECRET_RE = [/^\.env/i, /\.pem$/i, /\.pfx$/i, /\.key$/i, /^id_rsa/i];

export function isSecretPath(p) {
  const base = String(p).replace(/\\/g, '/').split('/').pop();
  return SECRET_RE.some((r) => r.test(base));
}

/** Trailer paragraph recording who made an auto-commit (read back by the Versions timeline). */
export function commitTrailers(meta) {
  const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const lines = [];
  if (meta?.agent && clean(meta.agent)) lines.push(`Flowstate-Agent: ${clean(meta.agent)}`);
  if (meta?.methodology && clean(meta.methodology)) lines.push(`Flowstate-Methodology: ${clean(meta.methodology)}`);
  return lines.join('\n');
}

export function commitMessage(prompt) {
  return `${COMMIT_PREFIX} ${String(prompt ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)}`.trim();
}

/** Parse `git status --porcelain -z` into [{status, path}] (handles renames). */
export function parsePorcelainZ(out) {
  const parts = out.split('\0');
  const res = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    const status = e.slice(0, 2);
    res.push({ status, path: e.slice(3) });
    if (status[0] === 'R' || status[0] === 'C') i++; // next token is the original path
  }
  return res;
}

export function createGit({ run = runCommand, gitCmd = 'git' } = {}) {
  const g = (cwd, args, timeout = 30000) => run(gitCmd, args, { cwd, timeout });

  async function isRepo(cwd) {
    const r = await g(cwd, ['rev-parse', '--is-inside-work-tree']);
    return r.code === 0 && r.stdout.trim() === 'true';
  }
  async function hasCommits(cwd) { return (await g(cwd, ['rev-parse', '--verify', '-q', 'HEAD'])).code === 0; }
  async function identityArgs(cwd) {
    const [n, e] = await Promise.all([g(cwd, ['config', 'user.name']), g(cwd, ['config', 'user.email'])]);
    const a = [];
    if (!n.stdout.trim()) a.push('-c', 'user.name=FlowState');
    if (!e.stdout.trim()) a.push('-c', 'user.email=flowstate@localhost');
    return a;
  }
  async function currentBranch(cwd) {
    const r = await g(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']);
    return r.code === 0 ? r.stdout.trim() : null;
  }

  return {
    isRepo,
    async status(cwd) {
      if (!(await isRepo(cwd))) return { isRepo: false, branch: null, dirty: 0 };
      const branch = await currentBranch(cwd);
      const s = await g(cwd, ['status', '--porcelain', '-z', '-uall']);
      return { isRepo: true, branch, dirty: parsePorcelainZ(s.stdout).length };
    },
    async init(cwd) {
      if (await isRepo(cwd)) return { ok: true, created: false };
      const r = await g(cwd, ['init']);
      return { ok: r.code === 0, created: r.code === 0, message: r.stderr };
    },
    async autoCommit(cwd, prompt, meta = null) {
      if (!(await isRepo(cwd))) return { committed: false, reason: 'not-repo' };
      const id = await identityArgs(cwd);
      if (!(await hasCommits(cwd))) {
        const r = await g(cwd, [...id, 'commit', '--allow-empty', '-m', `${COMMIT_PREFIX} initial snapshot`]);
        if (r.code !== 0) return { committed: false, reason: 'initial-commit-failed', message: r.stderr };
      }
      if ((await currentBranch(cwd)) !== AUTO_BRANCH) {
        let r = await g(cwd, ['checkout', AUTO_BRANCH]);
        if (r.code !== 0) r = await g(cwd, ['checkout', '-b', AUTO_BRANCH]);
        if (r.code !== 0) return { committed: false, reason: 'branch-failed', message: r.stderr };
      }
      const st = await g(cwd, ['status', '--porcelain', '-z', '-uall']);
      const files = parsePorcelainZ(st.stdout).filter((f) => !isSecretPath(f.path));
      if (!files.length) return { committed: false, reason: 'clean' };
      const add = await g(cwd, ['add', '-A', '--', ...files.map((f) => f.path)]);
      if (add.code !== 0) return { committed: false, reason: 'add-failed', message: add.stderr };
      if ((await g(cwd, ['diff', '--cached', '--quiet'])).code === 0) return { committed: false, reason: 'clean' };
      const tr = commitTrailers(meta);
      const c = await g(cwd, [...id, 'commit', '-m', commitMessage(prompt), ...(tr ? ['-m', tr] : [])]);
      return c.code === 0 ? { committed: true, branch: AUTO_BRANCH } : { committed: false, reason: 'commit-failed', message: c.stderr };
    },
    async undoTurn(cwd) {
      if (!(await isRepo(cwd))) return { ok: false, message: 'Not a git repository' };
      const log = await g(cwd, ['log', '-1', '--format=%s']);
      if (log.code !== 0 || !log.stdout.trim().startsWith(COMMIT_PREFIX)) {
        return { ok: false, message: 'Last commit was not made by FlowState; nothing to undo' };
      }
      if ((await g(cwd, ['rev-parse', '--verify', '-q', 'HEAD~1'])).code !== 0) {
        return { ok: false, message: 'No earlier commit to return to' };
      }
      const r = await g(cwd, ['reset', '--hard', 'HEAD~1']);
      return r.code === 0 ? { ok: true, message: 'Last turn undone' } : { ok: false, message: r.stderr.trim() };
    },
  };
}
