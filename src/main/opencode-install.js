// One-click OpenCode CLI install (user-initiated). Downloads the official zip from opencode.ai and puts opencode.exe where FlowState's
// discovery (health.js) and the official installer look: ~/.opencode/bin. Only the fixed URL below and HTTPS redirects that stay on
// opencode.ai are followed; the file is size-capped, extracted into a private temp folder, and only `opencode(.exe)` is copied out.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { execFile } from 'node:child_process';

export const OPENCODE_URLS = Object.freeze({
  'win32-x64': 'https://opencode.ai/update/api/latest/cli/opencode/opencode-windows-x64.zip',
});
export const MAX_DOWNLOAD = 400 * 1024 * 1024;
const ALLOWED_HOST = /(^|\.)opencode\.ai$/i;

/** Where the CLI is installed for this user (also a discovery candidate in health.js). */
export function opencodeInstallPath(platform = process.platform, home = os.homedir()) {
  return path.join(home, '.opencode', 'bin', platform === 'win32' ? 'opencode.exe' : 'opencode');
}

/** True when a URL may be downloaded from (https + opencode.ai or a subdomain). */
export function allowedDownloadUrl(u) {
  try { const x = new URL(u); return x.protocol === 'https:' && ALLOWED_HOST.test(x.hostname); } catch { return false; }
}

function download(url, dest, { onProgress, redirects = 5, get = https.get } = {}) {
  return new Promise((resolve, reject) => {
    if (!allowedDownloadUrl(url)) { reject(new Error('Download location not allowed')); return; }
    const req = get(url, { headers: { 'User-Agent': 'FlowState' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects <= 0) { reject(new Error('Too many redirects')); return; }
        const next = new URL(res.headers.location, url).toString();
        download(next, dest, { onProgress, redirects: redirects - 1, get }).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`Download failed (HTTP ${res.statusCode})`)); return; }
      const total = Number(res.headers['content-length']) || 0;
      if (total > MAX_DOWNLOAD) { res.resume(); reject(new Error('Download too large')); return; }
      let got = 0;
      const out = fs.createWriteStream(dest);
      res.on('data', (c) => {
        got += c.length;
        if (got > MAX_DOWNLOAD) { req.destroy(new Error('Download too large')); return; }
        onProgress?.({ received: got, total });
      });
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve({ bytes: got })));
      out.on('error', reject);
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('Download timed out')));
  });
}

function expandZip(zip, dir, platform) {
  return new Promise((resolve, reject) => {
    const [cmd, args] = platform === 'win32'
      ? ['powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:FS_ZIP -DestinationPath $env:FS_DIR -Force']]
      : ['unzip', ['-o', '-q', zip, '-d', dir]];
    execFile(cmd, args, { windowsHide: true, timeout: 180000, env: { ...process.env, FS_ZIP: zip, FS_DIR: dir } }, (err) => (err ? reject(new Error('Could not extract the download')) : resolve()));
  });
}

function findFile(dir, name, depth = 4) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name.toLowerCase() === name) return p;
    if (e.isDirectory() && !e.isSymbolicLink() && depth > 0) { const hit = findFile(p, name, depth - 1); if (hit) return hit; }
  }
  return null;
}

export function createOpencodeInstaller({ platform = process.platform, arch = process.arch, home = os.homedir(), tmp = os.tmpdir(), emit = () => {} } = {}) {
  let busy = null;
  return {
    supported: () => !!OPENCODE_URLS[`${platform}-${arch}`],
    target: () => opencodeInstallPath(platform, home),
    /** -> {ok, path, bytes} | {ok:false, error} */
    install() {
      if (busy) return busy;
      busy = (async () => {
        const url = OPENCODE_URLS[`${platform}-${arch}`];
        if (!url) return { ok: false, error: 'unsupported', manual: 'https://opencode.ai/download' };
        const work = fs.mkdtempSync(path.join(tmp, 'flowstate-opencode-'));
        try {
          const zip = path.join(work, 'opencode.zip');
          let lastPct = -1;
          const r = await download(url, zip, { onProgress: ({ received, total }) => {
            const pct = total ? Math.floor((received / total) * 100) : -1;
            if (pct !== lastPct) { lastPct = pct; emit({ kind: 'progress', received, total, pct }); }
          } });
          emit({ kind: 'extracting' });
          const out = path.join(work, 'x');
          fs.mkdirSync(out);
          await expandZip(zip, out, platform);
          const exeName = platform === 'win32' ? 'opencode.exe' : 'opencode';
          const exe = findFile(out, exeName);
          if (!exe) return { ok: false, error: 'opencode.exe was not found in the download' };
          const dest = opencodeInstallPath(platform, home);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          const tmpDest = `${dest}.new`;
          fs.copyFileSync(exe, tmpDest);
          if (platform !== 'win32') fs.chmodSync(tmpDest, 0o755);
          try { fs.rmSync(dest, { force: true }); } catch { /* in use: rename below fails and is reported */ }
          fs.renameSync(tmpDest, dest);
          emit({ kind: 'done', path: dest });
          return { ok: true, path: dest, bytes: r.bytes };
        } catch (e) {
          const error = String(e?.message ?? e);
          emit({ kind: 'error', error });
          return { ok: false, error };
        } finally {
          try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
        }
      })().finally(() => { busy = null; });
      return busy;
    },
  };
}
