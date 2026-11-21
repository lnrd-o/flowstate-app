// Small promise wrapper over execFile (no shell). Never rejects: resolves {code, stdout, stderr}.
import { execFile } from 'node:child_process';

export function runCommand(cmd, args = [], opts = {}) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, {
        cwd: opts.cwd, timeout: opts.timeout ?? 15000, windowsHide: true, maxBuffer: 8 * 1024 * 1024, shell: false, encoding: 'utf8',
      }, (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr || err?.message || '') });
      });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: String(e?.message ?? e) });
    }
  });
}
