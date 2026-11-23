// Run e2e suites in parallel (each has its own port and profile). Usage:
//   node tests/e2e/run-all.mjs [suite ...]          default: smoke features work versions phase7 opencode
//   E2E_EXE=<packaged exe> node tests/e2e/run-all.mjs   same suites against the built app
//   E2E_JOBS=3 limits how many run at once (default 4).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const FILES = { accept: 'accept-real.mjs', smoke: 'smoke.mjs', features: 'features.mjs', work: 'work.mjs', versions: 'versions.mjs', phase7: 'phase7.mjs', opencode: 'opencode.mjs' };
const suites = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(FILES);
const jobs = Math.max(1, Number(process.env.E2E_JOBS) || 4);
const t0 = Date.now();
const results = [];

function run(name) {
  return new Promise((resolve) => {
    const started = Date.now();
    const c = spawn(process.execPath, [join(here, FILES[name] || name)], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { out += d; });
    c.on('close', (code) => {
      const summary = (out.match(/\d+\/\d+ passed/g) || []).pop() || 'no summary';
      const fails = out.split(/\r?\n/).filter((l) => /^FAIL/.test(l));
      results.push({ name, code, summary, fails, secs: Math.round((Date.now() - started) / 1000) });
      console.log(`${code === 0 ? 'ok  ' : 'FAIL'} ${name.padEnd(9)} ${summary.padEnd(14)} ${Math.round((Date.now() - started) / 1000)}s`);
      for (const f of fails) console.log('       ' + f);
      resolve();
    });
  });
}

const queue = [...suites];
await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => { while (queue.length) await run(queue.shift()); }));
const bad = results.filter((r) => r.code !== 0);
console.log(`\n${results.length - bad.length}/${results.length} suites passed in ${Math.round((Date.now() - t0) / 1000)}s${process.env.E2E_EXE ? ' (packaged app)' : ''}`);
process.exit(bad.length ? 1 : 0);
