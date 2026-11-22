// Opens a visible terminal window so the user signs in themselves. We never read or store credentials.
import fs from 'node:fs';
import { spawn as nodeSpawn } from 'node:child_process';
import { terminalAttempts, openTerminal } from './terminal.js';

const TITLE = 'FlowState sign-in';

/** First terminal attempt for the platform: win32 `cmd.exe /c start "<title>" "<exe>" <args...>` opens a NEW console window. */
export function buildLoginCommand(agent, exe, platform = process.platform) {
  if (agent !== 'claude' && agent !== 'agy' && agent !== 'opencode') throw new TypeError('invalid agent');
  const tail = agent === 'agy' ? [] : ['auth', 'login'];
  return terminalAttempts({ platform, exe, args: tail, title: TITLE })[0];
}

export function createAuth({ health, spawn = nodeSpawn, fsx = fs, platform = process.platform } = {}) {
  return {
    async login(agent) {
      if (agent !== 'claude' && agent !== 'agy' && agent !== 'opencode') throw new TypeError('invalid agent');
      const exe = agent === 'agy' ? await health.findAgy() : agent === 'opencode' ? await health.findOpencode() : await health.findClaude();
      if (!exe) throw new Error(`${agent} executable not found`);
      if (!fsx.existsSync(exe)) throw new Error(`${agent} executable does not exist`);
      await openTerminal({ platform, exe, args: agent === 'agy' ? [] : ['auth', 'login'], title: TITLE, spawn });
      return { ok: true };
    },
  };
}
