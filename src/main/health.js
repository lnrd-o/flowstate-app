import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { runCommand } from './run.js';

export const DEFAULT_VPN_PATTERN = /vpn|anyconnect|globalprotect|fortinet|openvpn|wireguard|zscaler|nordlynx|tap-windows|wintun/i;

/** adapters: [{Name, InterfaceDescription}] (already filtered to Status Up). */
export function matchVpnAdapters(adapters, pattern = DEFAULT_VPN_PATTERN) {
  const list = Array.isArray(adapters) ? adapters : adapters ? [adapters] : [];
  return list
    .filter((a) => a && pattern.test(`${a.Name ?? ''} ${a.InterfaceDescription ?? ''}`))
    .map((a) => String(a.Name ?? a.InterfaceDescription));
}

function cmpVersion(a, b) {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

function headReachable(url, timeoutMs = 4000) {
  return new Promise((resolve) => {
    try {
      const req = https.request(url, { method: 'HEAD', timeout: timeoutMs }, (res) => { res.resume(); resolve(true); });
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.on('error', () => resolve(false));
      req.end();
    } catch { resolve(false); }
  });
}

export function createHealth({
  run = runCommand, fsx = fs, env = process.env, platform = process.platform, getSettings = () => ({}),
  vpnPattern = DEFAULT_VPN_PATTERN, reachable = () => headReachable('https://api.anthropic.com'),
} = {}) {
  const j = path.join;
  const isFile = (p) => { try { return fsx.existsSync(p); } catch { return false; } };
  const exe = platform === 'win32' ? '.exe' : '';

  async function where(name) {
    const r = await run(platform === 'win32' ? 'where' : 'which', [name], { timeout: 5000 });
    if (r.code !== 0) return [];
    return r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  }

  function claudeDataCandidates() {
    const root = env.LOCALAPPDATA && j(env.LOCALAPPDATA, 'Claude-Data');
    const found = [];
    if (!root || !isFile(root)) return found;
    const ls = (p) => { try { return fsx.readdirSync(p); } catch { return []; } };
    for (const id of ls(root)) {
      const base = j(root, id, 'claude-code');
      for (const ver of ls(base)) {
        for (const hash of ls(j(base, ver))) {
          const p = j(base, ver, hash, `claude${exe}`);
          if (isFile(p)) found.push({ version: ver, path: p });
        }
      }
    }
    return found.sort((a, b) => cmpVersion(b.version, a.version));
  }

  async function findClaude() {
    const configured = getSettings().claudePath;
    if (configured && isFile(configured)) return configured;
    for (const p of await where('claude')) if (/\.exe$/i.test(p) || platform !== 'win32') return p;
    if (env.USERPROFILE) {
      const p = j(env.USERPROFILE, '.local', 'bin', `claude${exe}`);
      if (isFile(p)) return p;
    }
    const cd = claudeDataCandidates();
    if (cd.length) return cd[0].path;
    if (env.APPDATA) {
      for (const n of ['claude.exe', 'claude.cmd', 'claude']) {
        const p = j(env.APPDATA, 'npm', n);
        if (isFile(p)) return p;
      }
    }
    return null;
  }

  async function findAgy() {
    const configured = getSettings().agyPath;
    if (configured && isFile(configured)) return configured;
    const w = await where('agy');
    if (w.length) return w[0];
    if (env.LOCALAPPDATA) {
      const p = j(env.LOCALAPPDATA, 'agy', 'bin', `agy${exe}`);
      if (isFile(p)) return p;
    }
    return null;
  }

  const firstLine = (s) => String(s).split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';

  async function version(cmd, args = ['--version']) {
    const r = await run(cmd, args, { timeout: 8000 });
    return r.code === 0 ? firstLine(r.stdout || r.stderr) : null;
  }

  async function detectVpn() {
    if (platform !== 'win32') return { active: false, adapters: [] };
    const script = "Get-NetAdapter | Where-Object { $_.Status -eq 'Up' } | Select-Object Name,InterfaceDescription | ConvertTo-Json -Compress";
    const r = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 8000 });
    let list = [];
    try { list = r.stdout.trim() ? JSON.parse(r.stdout) : []; } catch { list = []; }
    const adapters = matchVpnAdapters(list, vpnPattern);
    return { active: adapters.length > 0, adapters };
  }

  async function tools() {
    const [cPath, aPath] = await Promise.all([findClaude(), findAgy()]);
    const claude = { found: !!cPath, path: cPath, version: null, loggedIn: false };
    const agy = { found: !!aPath, path: aPath, version: null };
    const jobs = [];
    if (cPath) {
      jobs.push(version(cPath).then((v) => { claude.version = v; }));
      jobs.push(run(cPath, ['auth', 'status'], { timeout: 10000 }).then((r) => {
        try { claude.loggedIn = JSON.parse(r.stdout).loggedIn === true; } catch { claude.loggedIn = false; }
      }));
    }
    if (aPath) jobs.push(version(aPath).then((v) => { agy.version = v; }));
    const simple = {};
    const named = [['node', 'node', ['--version']], ['git', 'git', ['--version']], ['python', 'python', ['--version']]];
    for (const [key, cmd, args] of named) {
      jobs.push((async () => {
        let v = await version(cmd, args);
        if (!v && key === 'python') v = await version('py', args);
        simple[key] = { found: !!v, version: v };
      })());
    }
    await Promise.all(jobs);
    return { claude, agy, node: simple.node, git: simple.git, python: simple.python };
  }

  async function dynamic() {
    const [vpn, anthropicReachable] = await Promise.all([detectVpn(), reachable()]);
    return { vpn, anthropicReachable };
  }

  return {
    findClaude, findAgy, detectVpn, claudeDataCandidates,
    check: async () => ({ ...(await tools()), ...(await dynamic()) }),
    tools, dynamic,
  };
}

/** Polls health; full tool detection every `fullEvery` ticks, VPN/reachability each tick. Pushes only on change. */
export function createHealthPoller({ health, onChange, intervalMs = 10000, fullEvery = 6, setIntervalFn = setInterval, clearIntervalFn = clearInterval }) {
  let last = null; let lastKey = '';
  let tick = 0; let busy = false; let timer = null;

  async function poll() {
    if (busy) return last;
    busy = true;
    try {
      const doFull = !last || tick % fullEvery === 0;
      tick++;
      const next = doFull ? await health.check() : { ...last, ...(await health.dynamic()) };
      const key = JSON.stringify(next);
      if (key !== lastKey) { last = next; lastKey = key; onChange?.(next); }
      return last;
    } finally { busy = false; }
  }

  return {
    poll,
    current: () => last,
    start() { poll().catch(() => {}); timer = setIntervalFn(() => poll().catch(() => {}), intervalMs); timer.unref?.(); },
    stop() { if (timer) clearIntervalFn(timer); timer = null; },
  };
}
