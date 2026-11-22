// Platform helpers shared by health/prereq/dashboards/agents. Everything takes platform/env/fs as parameters so
// macOS and Linux behaviour can be unit-tested from any host.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** path module matching the target platform (win32 -> path.win32, everything else -> path.posix). */
export const pathFor = (platform) => (platform === 'win32' ? path.win32 : path.posix);

export function cmpVersion(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** Home directory for the target platform from env (USERPROFILE on win32, HOME elsewhere); null when unknown. */
export function homeDir(env = process.env, platform = process.platform) {
  const v = platform === 'win32' ? (env.USERPROFILE || env.HOME) : (env.HOME || env.USERPROFILE);
  if (v) return v;
  return env === process.env ? os.homedir() : null;
}

/**
 * True when `p` can be launched directly (shell:false).
 * win32: an existing .exe (never .cmd/.bat shims, which cannot be spawned without a shell).
 * posix: a regular file with at least one executable bit.
 */
export function isExecutableFile(fsx, p, platform = process.platform) {
  try {
    if (typeof p !== 'string' || !p) return false;
    if (platform === 'win32') return /\.exe$/i.test(p) && fsx.existsSync(p);
    const st = fsx.statSync(p);
    if (st.isDirectory?.()) return false;
    return (st.mode & 0o111) !== 0;
  } catch { return false; }
}

const ls = (fsx, p) => { try { return fsx.readdirSync(p).map(String); } catch { return []; } };

/** `node` bin dir of the nvm default alias (or the newest installed version). [] when nvm is not used. */
export function nvmBinDirs(env, platform, fsx = fs) {
  if (platform === 'win32') return [];
  const out = [];
  if (env.NVM_BIN) out.push(env.NVM_BIN);
  const home = homeDir(env, platform);
  const nvmDir = env.NVM_DIR || (home && path.posix.join(home, '.nvm'));
  if (!nvmDir) return out;
  const vdir = path.posix.join(nvmDir, 'versions', 'node');
  const versions = ls(fsx, vdir).filter((v) => /^v?\d/.test(v)).sort((a, b) => cmpVersion(b, a));
  if (!versions.length) return out;
  let chosen = versions[0];
  try {
    const alias = String(fsx.readFileSync(path.posix.join(nvmDir, 'alias', 'default'), 'utf8')).trim().replace(/^v/, '');
    if (/^\d+(\.\d+){0,2}$/.test(alias)) {
      const hit = versions.find((v) => v.replace(/^v/, '') === alias || v.replace(/^v/, '').startsWith(`${alias}.`));
      if (hit) chosen = hit;
    }
  } catch { /* no alias file: newest */ }
  out.push(path.posix.join(vdir, chosen, 'bin'));
  return out;
}

/** Extra directories a GUI-launched app should search on macOS/Linux (Finder/desktop launches get a minimal PATH). */
export function commonBinDirs(env, platform, fsx = fs) {
  if (platform === 'win32') return [];
  const home = homeDir(env, platform);
  const h = (...s) => (home ? [path.posix.join(home, ...s)] : []);
  return [
    '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin',
    ...h('.local', 'bin'), ...h('.npm-global', 'bin'), ...h('.volta', 'bin'), ...h('.cargo', 'bin'),
    ...nvmBinDirs(env, platform, fsx),
  ];
}

/** Ordered, de-duplicated search directories: the inherited PATH first, then the common extras. */
export function searchPathDirs(env = process.env, platform = process.platform, fsx = fs) {
  const sep = platform === 'win32' ? ';' : ':';
  const own = String(env.PATH ?? env.Path ?? '').split(sep).filter(Boolean);
  if (platform === 'win32') return own;
  return [...new Set([...own, ...commonBinDirs(env, platform, fsx)])];
}

/** Copy of env whose PATH includes the common dirs on darwin/linux; on win32 a plain copy. */
export function augmentedEnv(env = process.env, platform = process.platform, fsx = fs) {
  const out = { ...env };
  if (platform !== 'win32') out.PATH = searchPathDirs(env, platform, fsx).join(':');
  return out;
}

let cache = null;
/**
 * Env to hand to child processes. undefined on win32 (inherit as before). On posix the augmented env,
 * Only the augmented PATH is memoised (per inherited PATH/HOME) so hot paths (runCommand) do not hit the disk each time; every
 * other variable is read live, so variables set after the first spawn (per-run settings, tests) still reach the child.
 */
export function spawnEnv(platform = process.platform) {
  if (platform === 'win32') return undefined;
  const key = `${platform}|${process.env.PATH ?? ''}|${process.env.HOME ?? ''}`;
  if (!cache || cache.key !== key) cache = { key, path: augmentedEnv(process.env, platform).PATH };
  return { ...process.env, PATH: cache.path };
}

/** First executable named `name` in the search path (posix only; win32 uses `where`). */
export function findOnPath(name, env = process.env, platform = process.platform, fsx = fs) {
  const hits = [];
  for (const dir of searchPathDirs(env, platform, fsx)) {
    const p = path.posix.join(dir, name);
    if (isExecutableFile(fsx, p, platform)) hits.push(p);
  }
  return hits;
}

/** Breadth-first search for a file called `name` below `root` (readdir only, bounded). */
export function findNamed(fsx, root, name, { maxDepth = 3, budget = 800, platform = process.platform } = {}) {
  const P = pathFor(platform);
  let queue = [root];
  for (let depth = 0; depth <= maxDepth && queue.length; depth++) {
    const next = [];
    for (const dir of queue) {
      for (const e of ls(fsx, dir)) {
        if (--budget < 0) return null;
        const p = P.join(dir, e);
        if (e === name && isExecutableFile(fsx, p, platform)) return p;
        if (depth < maxDepth) next.push(p); // files simply fail readdir on the next level
      }
    }
    queue = next;
  }
  return null;
}

export { ls as safeReaddir };
