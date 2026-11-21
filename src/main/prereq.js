// Prerequisite installer via winget. Only fixed, allow-listed package ids; user text never reaches the command line.
import { spawn as nodeSpawn } from 'node:child_process';
import { streamProcess } from './proc.js';

export const PACKAGES = Object.freeze({ git: 'Git.Git', node: 'OpenJS.NodeJS.LTS', python: 'Python.Python.3.12' });

export function wingetArgs(id) {
  const pkg = Object.hasOwn(PACKAGES, id) ? PACKAGES[id] : null;
  if (!pkg) throw new Error(`Unknown prerequisite: ${String(id).slice(0, 40)}`);
  return ['install', '--id', pkg, '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements'];
}

export function createPrereq({ spawn = nodeSpawn, push = () => {}, recheck = async () => {} } = {}) {
  let busy = null;
  return {
    async install(id) {
      const args = wingetArgs(id);
      if (busy) throw new Error(`Another installation is already running (${busy})`);
      busy = id;
      const lines = [];
      try {
        const r = await streamProcess('winget', args, {
          spawn,
          onLine: (text) => { lines.push(text); if (lines.length > 300) lines.shift(); push({ id, kind: 'log', text }); },
        });
        const ok = r.code === 0;
        if (r.error) lines.push(r.error);
        push(ok ? { id, kind: 'done' } : { id, kind: 'error', text: r.error ?? `winget exited with code ${r.code}` });
        try { await recheck(); } catch { /* best effort */ }
        return { ok, log: lines.join('\n') };
      } finally { busy = null; }
    },
  };
}
