// Opens a visible console window so the user signs in themselves. We never read or store credentials.
import fs from 'node:fs';
import { spawn as nodeSpawn } from 'node:child_process';

const TITLE = 'FlowState sign-in';

/** Args for cmd.exe: `start "<title>" "<exe>" <args...>` opens a NEW console window. */
export function buildLoginCommand(agent, exe) {
  if (agent !== 'claude' && agent !== 'agy') throw new TypeError('invalid agent');
  if (typeof exe !== 'string' || !/\.exe$/i.test(exe) || /["\r\n\0]/.test(exe)) throw new Error('Executable path is not valid');
  const tail = agent === 'claude' ? ['auth', 'login'] : [];
  return { command: 'cmd.exe', args: ['/c', 'start', TITLE, exe, ...tail] };
}

export function createAuth({ health, spawn = nodeSpawn, fsx = fs } = {}) {
  return {
    async login(agent) {
      if (agent !== 'claude' && agent !== 'agy') throw new TypeError('invalid agent');
      const exe = agent === 'agy' ? await health.findAgy() : await health.findClaude();
      if (!exe) throw new Error(`${agent} executable not found`);
      if (!fsx.existsSync(exe)) throw new Error(`${agent} executable does not exist`);
      const { command, args } = buildLoginCommand(agent, exe);
      await new Promise((resolve, reject) => {
        const child = spawn(command, args, { detached: true, windowsHide: false, stdio: 'ignore', shell: false });
        child.once('error', reject);
        child.once('spawn', () => { child.unref?.(); resolve(); });
      });
      return { ok: true };
    },
  };
}
