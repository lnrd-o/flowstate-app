// Shared helpers for the Phase 7 real-Electron tests: launch an isolated profile, drive the preload API over CDP.
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';

export const root = resolve(new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function makeChecker() {
  const results = [];
  const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? '  -> ' + detail : ''}`); };
  const done = () => {
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
    return failed ? 1 : 0;
  };
  return { check, done };
}

const isIndex = (t) => t.type === 'page' && t.url.split('?')[0].endsWith('index.html');
export const targets = async (port) => (await (await fetch(`http://127.0.0.1:${port}/json`)).json());

/** Launch the app (E2E_EXE = packaged exe) with an isolated profile. -> {child, exited:Promise, ev, call, send, targets, shutdown(), quitGracefully()} */
export async function launch({ profile, port, extraArgs = [], waitForIndex = true } = {}) {
  const packaged = process.env.E2E_EXE;
  const exe = packaged || join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
  const child = spawn(exe, [...(packaged ? [] : [root]), `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, ...extraArgs], { stdio: process.env.E2E_LOG ? 'inherit' : 'ignore' });
  let exitedCode = null;
  const exited = new Promise((r) => child.on('exit', (c) => { exitedCode = c; r(c); }));
  const seen = { splash: false };
  let ws = null; let id = 0; const pending = new Map(); const problems = [];

  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: `(async()=>{ ${expr} })()`, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  };
  const call = async (expr) => JSON.parse(await ev(`return JSON.stringify(await (${expr}))`));

  if (waitForIndex) {
    let t = null;
    for (let i = 0; i < 160 && !t; i++) {
      try {
        const all = await targets(port);
        if (all.some((x) => x.url.includes('splash.html'))) seen.splash = true;
        t = all.find(isIndex);
      } catch { /* not up yet */ }
      if (!t) await sleep(250);
    }
    if (!t) throw new Error('Electron did not expose the index.html target');
    ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id && pending.has(d.id)) { pending.get(d.id)(d.result ?? d.error); pending.delete(d.id); }
      else if (d.method === 'Runtime.exceptionThrown') problems.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
      else if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') problems.push(d.params.args.map((a) => a.value ?? a.description).join(' '));
    };
    await send('Runtime.enable');
  }

  return {
    child, exited, ev, call, send, problems, seen, targets: () => targets(port),
    isRunning: () => exitedCode === null,
    /** Graceful quit through the real quit flow (menu action file.quit): the app saves state and exits. */
    async quitGracefully(timeoutMs = 15000) {
      try { ev(`return await window.flowstate.menu.invoke('file.quit')`).catch(() => {}); } catch { /* ignore */ }
      const r = await Promise.race([exited, sleep(timeoutMs).then(() => 'timeout')]);
      try { ws?.close(); } catch { /* ignore */ }
      if (r === 'timeout') { try { child.kill(); } catch { /* ignore */ } return false; }
      return true;
    },
    async shutdown() {
      try { ws?.close(); } catch { /* ignore */ }
      if (exitedCode === null) { try { child.kill(); } catch { /* ignore */ } await Promise.race([exited, sleep(3000)]); }
    },
  };
}
