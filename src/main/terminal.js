// "Open a visible terminal window running a CLI" for every platform. Argument builders are pure; nothing here ever
// builds a shell string from untrusted text without strict validation/quoting.
import { spawn as nodeSpawn } from 'node:child_process';
import { spawnEnv } from './platform.js';

/** Linux terminal emulators in preference order. `lead` goes between the terminal name and the program. */
export const LINUX_TERMINALS = Object.freeze([
  { name: 'x-terminal-emulator', lead: ['-e'] },
  { name: 'gnome-terminal', lead: ['--'] },
  { name: 'konsole', lead: ['-e'] },
  { name: 'xfce4-terminal', lead: ['-x'] },
  { name: 'kitty', lead: [] },
  { name: 'alacritty', lead: ['-e'] },
]);

/**
 * Platform-aware executable validation (no I/O). win32: an absolute .exe path; posix: an absolute path.
 * Quotes, backslashes (posix), control chars and shell/cmd metacharacters are rejected so the path can be embedded
 * in a command line safely.
 */
export function validateExecutablePath(exe, platform = process.platform) {
  if (typeof exe !== 'string' || !exe || exe.length > 1024) throw new Error('Executable path is not valid');
  if (/[\0-\x1f\x7f]/.test(exe)) throw new Error('Executable path is not valid');
  if (platform === 'win32') {
    if (!/\.exe$/i.test(exe) || /["&|<>^%]/.test(exe)) throw new Error('Executable path is not valid');
  } else {
    if (!exe.startsWith('/') || /["'\\`$]/.test(exe)) throw new Error('Executable path is not valid');
  }
  return exe;
}

const cleanArg = (a, platform) => {
  const s = String(a).replace(/[\0-\x1f\x7f]/g, ' ');
  return platform === 'win32' ? s.replace(/["&|<>^%]/g, '_') : s;
};

/** POSIX single-quote quoting. */
export const shQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
/** Escape for use inside an AppleScript double-quoted string. */
export const appleScriptEscape = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/** Shell command line (for display / AppleScript) running exe with args. */
export function shellCommandLine(exe, args = []) {
  return [exe, ...args].map(shQuote).join(' ');
}

/**
 * Ordered list of {command, args} attempts that open a visible terminal running `exe ...args`.
 * win32 and darwin yield exactly one attempt; linux yields one per supported terminal emulator.
 */
export function terminalAttempts({ platform = process.platform, exe, args = [], title = 'FlowState' }) {
  validateExecutablePath(exe, platform);
  const a = args.map((x) => cleanArg(x, platform));
  if (platform === 'win32') {
    return [{ command: 'cmd.exe', args: ['/c', 'start', cleanArg(title, platform), exe, ...a] }];
  }
  if (platform === 'darwin') {
    const line = appleScriptEscape(shellCommandLine(exe, a));
    return [{ command: 'osascript', args: ['-e', 'tell application "Terminal"', '-e', 'activate', '-e', `do script "${line}"`, '-e', 'end tell'] }];
  }
  if (platform === 'linux') {
    return LINUX_TERMINALS.map((t) => ({ command: t.name, args: [...t.lead, exe, ...a] }));
  }
  throw new Error(`Opening a terminal is not supported on ${String(platform)}`);
}

function spawnDetached(spawn, command, args) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { detached: true, windowsHide: false, stdio: 'ignore', shell: false, env: spawnEnv() });
    } catch (e) { reject(e); return; }
    child.once('error', reject);
    child.once('spawn', () => { child.unref?.(); resolve(); });
  });
}

/** Tries each attempt in order until one starts. Resolves {command}; rejects with the exact manual command if none worked. */
export async function openTerminal({ platform = process.platform, exe, args = [], title, spawn = nodeSpawn }) {
  const attempts = terminalAttempts({ platform, exe, args, title });
  let last = null;
  for (const at of attempts) {
    try {
      await spawnDetached(spawn, at.command, at.args);
      return { command: at.command };
    } catch (e) { last = e; }
  }
  const manual = shellCommandLine(exe, args);
  throw new Error(`Could not open a terminal window (${last?.message ?? 'unknown error'}). Run this in a terminal: ${manual}`);
}
