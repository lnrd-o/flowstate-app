import fs from 'node:fs';
import https from 'node:https';
import { runCommand } from './run.js';
import { isAgyLoggedInOutput, isOpencodeLoggedInOutput } from './auth-check.js';
import { isSourceEnabled } from '../shared/sources.js';
import {
  pathFor, cmpVersion, homeDir, isExecutableFile, findOnPath, findNamed, safeReaddir, augmentedEnv,
} from './platform.js';

export { augmentedEnv };

export const DEFAULT_VPN_PATTERN = /vpn|anyconnect|globalprotect|fortinet|openvpn|wireguard|zscaler|nordlynx|tap-windows|wintun/i;

/** adapters: [{Name, InterfaceDescription}] (already filtered to Status Up). */
export function matchVpnAdapters(adapters, pattern = DEFAULT_VPN_PATTERN) {
  const list = Array.isArray(adapters) ? adapters : adapters ? [adapters] : [];
  return list
    .filter((a) => a && pattern.test(`${a.Name ?? ''} ${a.InterfaceDescription ?? ''}`))
    .map((a) => String(a.Name ?? a.InterfaceDescription));
}

// ---- VPN detection parsers for macOS / Linux (pure) ------------------------------------------------------------
/** Interface names that are a VPN by name alone. A bare macOS `utunN` is deliberately NOT here (the OS uses utun for itself). */
export const VPN_IFACE_RE = /^(tun|tap|wg|ppp|ipsec|nordlynx|proton|pvpn|tailscale)/i;

/** `scutil --nc list` -> names of services whose state is Connected. */
export function parseScutilNcList(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!/\(Connected\)/.test(line)) continue;
    const q = /"([^"]+)"/.exec(line);
    out.push(q ? q[1] : 'VPN');
  }
  return out;
}

/** macOS `ifconfig -a` -> VPN-named interfaces that are UP and have an IPv4 address. */
export function parseIfconfigVpn(text) {
  const out = [];
  let cur = null;
  const flush = () => { if (cur && cur.up && cur.inet && VPN_IFACE_RE.test(cur.name)) out.push(cur.name); };
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const h = /^([A-Za-z][\w.-]*):\s+flags=\d+<([^>]*)>/.exec(line);
    if (h) { flush(); cur = { name: h[1], up: h[2].split(',').includes('UP'), inet: false }; continue; }
    if (cur && /^\s+inet\s+\d+\.\d+\.\d+\.\d+/.test(line)) cur.inet = true;
  }
  flush();
  return out;
}

/** Linux `ip -o link show up` -> VPN-like interface names. */
export function parseIpLinkUp(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^\d+:\s+([^\s:@]+)(?:@\S+)?:\s/.exec(line);
    if (m && VPN_IFACE_RE.test(m[1])) out.push(m[1]);
  }
  return out;
}

const splitTerse = (line) => {
  const parts = []; let cur = '';
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\' && i + 1 < line.length) { cur += line[i + 1]; i++; }
    else if (line[i] === ':') { parts.push(cur); cur = ''; }
    else cur += line[i];
  }
  parts.push(cur);
  return parts;
};

/** Linux `nmcli -t -f TYPE,STATE,NAME connection show --active` -> names of active vpn/wireguard/tun connections. */
export function parseNmcliActive(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [type, state, ...rest] = splitTerse(line);
    if (/^(vpn|wireguard|tun)$/i.test(type) && /^activated$/i.test(state)) out.push(rest.join(':') || type);
  }
  return out;
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
  const P = pathFor(platform);
  const j = (...a) => P.join(...a);
  const isWin = platform === 'win32';
  const exe = isWin ? '.exe' : '';
  const home = homeDir(env, platform);
  const isExe = (p) => isExecutableFile(fsx, p, platform);
  let lastAgyLoggedIn = null;

  async function where(name) {
    const r = await run('where', [name], { timeout: 5000 });
    if (r.code !== 0) return [];
    return r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  }

  async function onPath(name) {
    if (isWin) return (await where(name)).filter((p) => /\.exe$/i.test(p));
    return findOnPath(name, env, platform, fsx);
  }

  /** Copies of the claude CLI shipped inside the Claude desktop app, newest version first. */
  function claudeDataCandidates() {
    const roots = [];
    if (isWin) {
      const base = env.LOCALAPPDATA && j(env.LOCALAPPDATA, 'Claude-Data');
      if (base) for (const id of safeReaddir(fsx, base)) roots.push(j(base, id, 'claude-code'));
    } else if (platform === 'darwin') {
      if (home) roots.push(j(home, 'Library', 'Application Support', 'Claude', 'claude-code'));
    } else if (home) {
      roots.push(j(home, '.config', 'Claude', 'claude-code'));
    }
    const found = [];
    for (const root of roots) {
      for (const ver of safeReaddir(fsx, root)) {
        const p = findNamed(fsx, j(root, ver), `claude${exe}`, { maxDepth: 4, platform });
        if (p) found.push({ version: ver, path: p });
      }
    }
    found.sort((a, b) => cmpVersion(b.version, a.version));
    if (platform === 'darwin') {
      for (const app of ['/Applications/Claude.app', home && j(home, 'Applications', 'Claude.app')].filter(Boolean)) {
        const p = findNamed(fsx, j(app, 'Contents', 'Resources'), 'claude', { maxDepth: 5, platform });
        if (p) found.push({ version: '0', path: p });
      }
    }
    return found;
  }

  function claudeFixedCandidates() {
    const out = [];
    if (home) {
      out.push(j(home, '.local', 'bin', `claude${exe}`), j(home, '.claude', 'local', `claude${exe}`));
    }
    if (!isWin) {
      out.push('/usr/local/bin/claude', '/opt/homebrew/bin/claude');
      if (home) out.push(j(home, '.npm-global', 'bin', 'claude'), j(home, '.volta', 'bin', 'claude'));
    }
    return out;
  }

  async function findClaude() {
    const configured = getSettings().claudePath;
    if (configured && isExe(configured)) return configured;
    for (const p of await onPath('claude')) return p;
    for (const p of claudeFixedCandidates()) if (isExe(p)) return p;
    const cd = claudeDataCandidates();
    if (cd.length) return cd[0].path;
    if (isWin && env.APPDATA) {
      const p = j(env.APPDATA, 'npm', 'claude.exe');
      if (isExe(p)) return p;
    }
    return null;
  }

  function agyFixedCandidates() {
    const out = [];
    if (isWin) {
      if (env.LOCALAPPDATA) out.push(j(env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe'));
      if (home) out.push(j(home, '.local', 'bin', 'agy.exe'));
    } else {
      if (home) out.push(j(home, '.local', 'bin', 'agy'), j(home, '.agy', 'bin', 'agy'));
      out.push('/usr/local/bin/agy', '/opt/homebrew/bin/agy');
    }
    return out;
  }

  async function findAgy() {
    const configured = getSettings().agyPath;
    if (configured && isExe(configured)) return configured;
    for (const p of await onPath('agy')) return p;
    for (const p of agyFixedCandidates()) if (isExe(p)) return p;
    return null;
  }

  function opencodeFixedCandidates() {
    const out = [];
    if (isWin) {
      if (home) out.push(j(home, '.opencode', 'bin', 'opencode.exe'), j(home, '.local', 'bin', 'opencode.exe'), j(home, 'scoop', 'shims', 'opencode.exe'));
      if (env.APPDATA) {
        const pkg = j(env.APPDATA, 'npm', 'node_modules', 'opencode-ai');
        out.push(j(env.APPDATA, 'npm', 'opencode.exe'));
        const hit = findNamed(fsx, pkg, 'opencode.exe', { maxDepth: 4, platform });
        if (hit) out.push(hit);
      }
      // OpenCode desktop app: the CLI ships inside it as resources\opencode-cli.exe (never the *.update-* staging copies).
      if (env.LOCALAPPDATA) out.push(j(env.LOCALAPPDATA, 'Programs', 'ai.opencode.desktop', 'resources', 'opencode-cli.exe'));
    } else {
      if (home) out.push(j(home, '.opencode', 'bin', 'opencode'), j(home, '.local', 'bin', 'opencode'), j(home, '.npm-global', 'bin', 'opencode'));
      out.push('/usr/local/bin/opencode', '/opt/homebrew/bin/opencode');
      // Desktop app bundles (macOS .app / Linux install folders)
      if (platform === 'darwin') {
        out.push('/Applications/OpenCode.app/Contents/Resources/opencode-cli');
        if (home) out.push(j(home, 'Applications', 'OpenCode.app', 'Contents', 'Resources', 'opencode-cli'));
      } else {
        out.push('/opt/OpenCode/resources/opencode-cli', '/usr/lib/opencode/resources/opencode-cli');
      }
    }
    return out;
  }

  /** opencode (optional third agent). Hidden in the UI unless found. Settings.opencodePath overrides. */
  async function findOpencode() {
    const configured = getSettings().opencodePath;
    if (configured && isExe(configured)) return configured;
    for (const p of await onPath('opencode')) return p;
    for (const p of opencodeFixedCandidates()) if (isExe(p)) return p;
    return null;
  }

  const firstLine = (s) => String(s).split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';

  async function version(cmd, args = ['--version']) {
    const r = await run(cmd, args, { timeout: 8000 });
    return r.code === 0 ? firstLine(r.stdout || r.stderr) : null;
  }

  async function detectVpn() {
    let adapters = [];
    if (isWin) {
      const script = "Get-NetAdapter | Where-Object { $_.Status -eq 'Up' } | Select-Object Name,InterfaceDescription | ConvertTo-Json -Compress";
      const r = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 8000 });
      let list = [];
      try { list = r.stdout.trim() ? JSON.parse(r.stdout) : []; } catch { list = []; }
      adapters = matchVpnAdapters(list, vpnPattern);
    } else if (platform === 'darwin') {
      const [nc, ifc] = await Promise.all([
        run('scutil', ['--nc', 'list'], { timeout: 5000 }),
        run('ifconfig', ['-a'], { timeout: 5000 }),
      ]);
      adapters = [...new Set([...(nc.code === 0 ? parseScutilNcList(nc.stdout) : []), ...(ifc.code === 0 ? parseIfconfigVpn(ifc.stdout) : [])])];
    } else if (platform === 'linux') {
      const [ip, nm] = await Promise.all([
        run('ip', ['-o', 'link', 'show', 'up'], { timeout: 5000 }),
        run('nmcli', ['-t', '-f', 'TYPE,STATE,NAME', 'connection', 'show', '--active'], { timeout: 5000 }),
      ]);
      adapters = [...new Set([...(ip.code === 0 ? parseIpLinkUp(ip.stdout) : []), ...(nm.code === 0 ? parseNmcliActive(nm.stdout) : [])])];
    }
    return { active: adapters.length > 0, adapters };
  }

  async function tools() {
    const [cPath, aPath, oPath] = await Promise.all([findClaude(), findAgy(), findOpencode()]);
    const opencode = { found: !!oPath, path: oPath, version: null, loggedIn: null };
    const claude = { found: !!cPath, path: cPath, version: null, loggedIn: false };
    const agy = { found: !!aPath, path: aPath, version: null, loggedIn: null };
    const jobs = [];
    // Disabled sources are not probed (no version / sign-in commands): their state stays unknown (loggedIn null).
    const on = (id) => isSourceEnabled(getSettings() || {}, id);
    if (!on('claude')) claude.loggedIn = null;
    if (cPath && on('claude')) {
      jobs.push(version(cPath).then((v) => { claude.version = v; }));
      jobs.push(run(cPath, ['auth', 'status'], { timeout: 10000 }).then((r) => {
        try { claude.loggedIn = JSON.parse(r.stdout).loggedIn === true; } catch { claude.loggedIn = false; }
      }));
    }
    if (aPath && !on('agy')) { /* not probed */ } else if (aPath) {
      jobs.push(version(aPath).then((v) => { agy.version = v; }));
      jobs.push(run(aPath, ['models'], { timeout: 15000 }).then((r) => {
        const state = isAgyLoggedInOutput(`${r.stdout}\n${r.stderr}`);
        if (state !== null) lastAgyLoggedIn = state;
        agy.loggedIn = lastAgyLoggedIn;
      }));
    } else lastAgyLoggedIn = null;
    if (oPath && on('opencode')) {
      jobs.push(version(oPath).then((v) => { opencode.version = v; }));
      jobs.push(run(oPath, ['auth', 'list'], { timeout: 10000 }).then((r) => { opencode.loggedIn = isOpencodeLoggedInOutput(`${r.stdout}
${r.stderr}`); }));
    }
    const simple = {};
    const named = [['node', 'node', ['--version']], ['git', 'git', ['--version']], ['python', isWin ? 'python' : 'python3', ['--version']]];
    for (const [key, cmd, args] of named) {
      jobs.push((async () => {
        let v = await version(cmd, args);
        if (!v && key === 'python') v = await version(isWin ? 'py' : 'python', args);
        simple[key] = { found: !!v, version: v };
      })());
    }
    await Promise.all(jobs);
    return { claude, agy, opencode, node: simple.node, git: simple.git, python: simple.python };
  }

  async function dynamic() {
    const [vpn, anthropicReachable] = await Promise.all([detectVpn(), reachable()]);
    return { vpn, anthropicReachable };
  }

  return {
    findClaude, findAgy, findOpencode, detectVpn, claudeDataCandidates,
    check: async () => ({ ...(await tools()), ...(await dynamic()) }),
    tools, dynamic,
  };
}

/** Polls health; full tool detection every `fullEvery` ticks, VPN/reachability each tick. Pushes only on change. */
export function createHealthPoller({ health, onChange, intervalMs = 10000, fullEvery = 6, setIntervalFn = setInterval, clearIntervalFn = clearInterval }) {
  let last = null; let lastKey = '';
  let tick = 0; let inflight = null; let timer = null;

  async function run(force) {
    const doFull = force || !last || tick % fullEvery === 0;
    tick++;
    const next = doFull ? await health.check() : { ...last, ...(await health.dynamic()) };
    const key = JSON.stringify(next);
    if (key !== lastKey) { last = next; lastKey = key; onChange?.(next); }
    return last;
  }

  // Concurrent callers share the in-flight check (previously a caller arriving during the first poll got null).
  function poll(force = false) {
    if (inflight) return inflight;
    inflight = run(force).finally(() => { inflight = null; });
    return inflight;
  }

  return {
    poll,
    current: () => last,
    start() { poll().catch(() => {}); timer = setIntervalFn(() => poll().catch(() => {}), intervalMs); timer.unref?.(); },
    stop() { if (timer) clearIntervalFn(timer); timer = null; },
  };
}
