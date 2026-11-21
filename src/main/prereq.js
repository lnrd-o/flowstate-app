// Prerequisite installer. Only fixed, allow-listed package ids per platform; user text never reaches a command line.
//  win32  : winget install --id <id>
//  darwin : brew install <formula>   (Homebrew must already exist; we never pipe a download into a shell)
//  linux  : pkexec <apt-get|dnf|pacman|zypper> ... (graphical privilege prompt); without pkexec/display the exact
//           command is returned so the user can run it in a terminal.
import fs from 'node:fs';
import { spawn as nodeSpawn } from 'node:child_process';
import { streamProcess } from './proc.js';
import { findOnPath } from './platform.js';

export const PACKAGES = Object.freeze({ git: 'Git.Git', node: 'OpenJS.NodeJS.LTS', python: 'Python.Python.3.12' });
export const BREW_PACKAGES = Object.freeze({ git: 'git', node: 'node', python: 'python@3.12' });
export const LINUX_PACKAGES = Object.freeze({
  apt: Object.freeze({ git: ['git'], node: ['nodejs'], python: ['python3', 'python3-venv'] }),
  dnf: Object.freeze({ git: ['git'], node: ['nodejs'], python: ['python3'] }),
  pacman: Object.freeze({ git: ['git'], node: ['nodejs', 'npm'], python: ['python'] }),
  zypper: Object.freeze({ git: ['git'], node: ['nodejs'], python: ['python3'] }),
});
/** Package manager binary and the fixed arguments that come before the package names. */
export const LINUX_PM = Object.freeze({
  apt: Object.freeze({ bin: 'apt-get', pre: ['install', '-y'] }),
  dnf: Object.freeze({ bin: 'dnf', pre: ['install', '-y'] }),
  pacman: Object.freeze({ bin: 'pacman', pre: ['-S', '--noconfirm', '--needed'] }),
  zypper: Object.freeze({ bin: 'zypper', pre: ['--non-interactive', 'install'] }),
});
const PM_ORDER = ['apt', 'dnf', 'pacman', 'zypper'];

const known = (id) => (Object.hasOwn(PACKAGES, id) ? id : null);
function need(id) {
  if (!known(id)) throw new Error(`Unknown prerequisite: ${String(id).slice(0, 40)}`);
  return id;
}

export function wingetArgs(id) {
  return ['install', '--id', PACKAGES[need(id)], '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements'];
}

/**
 * Pure: decide what to run. `tools` = { brew, pkexec, display, pm } (absolute path / name or null / boolean).
 * -> { command, args, display } to run, or { error, manual? } when it cannot be run automatically.
 */
export function buildInstall(id, platform, tools = {}) {
  need(id);
  if (platform === 'win32') return { command: 'winget', args: wingetArgs(id), display: `winget ${wingetArgs(id).join(' ')}` };
  if (platform === 'darwin') {
    const args = ['install', BREW_PACKAGES[id]];
    if (!tools.brew) {
      return { error: `Homebrew is not installed. Install it from the official page https://brew.sh, then run: brew ${args.join(' ')}`, manual: `brew ${args.join(' ')}` };
    }
    return { command: tools.brew, args, display: `brew ${args.join(' ')}` };
  }
  if (platform === 'linux') {
    const pm = tools.pm && Object.hasOwn(LINUX_PM, tools.pm) ? tools.pm : null;
    if (!pm) return { error: 'No supported package manager found (apt-get, dnf, pacman or zypper). Install the package with your distribution tools.' };
    const { bin, pre } = LINUX_PM[pm];
    const pkgs = LINUX_PACKAGES[pm][id];
    const manual = `sudo ${bin} ${[...pre, ...pkgs].join(' ')}`;
    if (!tools.pkexec || !tools.display) {
      return { error: `Cannot show a graphical administrator prompt here. Run this command in a terminal: ${manual}`, manual };
    }
    return { command: tools.pkexec, args: [bin, ...pre, ...pkgs], display: manual };
  }
  return { error: `Automatic installation is not supported on ${String(platform)}` };
}

/** Looks for the tools buildInstall needs (posix). Injectable for tests. */
export function probeTools({ env = process.env, platform = process.platform, fsx = fs } = {}) {
  const first = (name) => findOnPath(name, env, platform, fsx)[0] ?? null;
  if (platform === 'darwin') return { brew: first('brew') };
  if (platform === 'linux') {
    const pm = PM_ORDER.find((k) => first(LINUX_PM[k].bin)) ?? null;
    return { pm, pkexec: first('pkexec'), display: !!(env.DISPLAY || env.WAYLAND_DISPLAY) };
  }
  return {};
}

export function createPrereq({
  spawn = nodeSpawn, push = () => {}, recheck = async () => {}, platform = process.platform, probe = () => probeTools({ platform }),
} = {}) {
  let busy = null;
  return {
    async install(id) {
      need(id);
      if (busy) throw new Error(`Another installation is already running (${busy})`);
      busy = id;
      const lines = [];
      try {
        const plan = buildInstall(id, platform, platform === 'win32' ? {} : await probe());
        if (plan.error) {
          push({ id, kind: 'error', text: plan.error });
          return { ok: false, log: plan.error, ...(plan.manual ? { manualCommand: plan.manual } : {}) };
        }
        const r = await streamProcess(plan.command, plan.args, {
          spawn,
          onLine: (text) => { lines.push(text); if (lines.length > 300) lines.shift(); push({ id, kind: 'log', text }); },
        });
        const ok = r.code === 0;
        if (r.error) lines.push(r.error);
        push(ok ? { id, kind: 'done' } : { id, kind: 'error', text: r.error ?? `${plan.command} exited with code ${r.code}` });
        try { await recheck(); } catch { /* best effort */ }
        return { ok, log: lines.join('\n') };
      } finally { busy = null; }
    },
  };
}
