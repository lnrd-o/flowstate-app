// Shared helper: run a child with args array (shell:false) and stream its output line by line.
import { spawn as nodeSpawn } from 'node:child_process';
import { spawnEnv } from './platform.js';

/**
 * Resolves {code, error?} (never rejects). onLine(text, stream) is called for each non-empty output line.
 * The child handle is exposed through opts.onChild so callers can kill it.
 */
export function streamProcess(cmd, args, { spawn = nodeSpawn, cwd, env, onLine, onChild } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, env: env ?? spawnEnv(), shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: -1, error: String(e?.message ?? e) });
      return;
    }
    onChild?.(child);
    const bufs = { stdout: '', stderr: '' };
    const feed = (stream) => (d) => {
      bufs[stream] += String(d);
      let i;
      while ((i = bufs[stream].indexOf('\n')) >= 0) {
        const l = bufs[stream].slice(0, i).replace(/\r$/, '');
        bufs[stream] = bufs[stream].slice(i + 1);
        if (l.trim()) onLine?.(l, stream);
      }
    };
    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout?.on('data', feed('stdout'));
    child.stderr?.on('data', feed('stderr'));
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      for (const s of ['stdout', 'stderr']) if (bufs[s].trim()) onLine?.(bufs[s].replace(/\r$/, ''), s);
      resolve(r);
    };
    child.on('error', (e) => finish({ code: -1, error: String(e?.message ?? e) }));
    child.on('close', (code) => finish({ code: code ?? -1 }));
  });
}
