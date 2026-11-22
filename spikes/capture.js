// Phase 0 spike: run a CLI agent headless in a scratch dir and record its stream-json output.
// Usage: node spikes/capture.js <claude|agy> [scenario]   (env CLAUDE_EXE / AGY_EXE override paths)
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, createWriteStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const [agent = 'claude', scenario = 'basic'] = process.argv.slice(2);

const EXES = {
  claude: process.env.CLAUDE_EXE || 'claude',
  agy: process.env.AGY_EXE || 'agy',
};

const PROMPTS = {
  basic: 'Reply with exactly: hello from the spike. Do not use any tools.',
  tool: 'Create a file named hello.txt containing the word hi, then read it back.',
  rich: 'Create hello.py that prints the numbers 1 to 3 and run it. Then edit hello.py so it prints their squares instead, run it again, and briefly explain what you changed and why.',
};

// agy's -p consumes the next token as the prompt, so the prompt must be attached: -p=<prompt>.
// claude takes the prompt over stdin (stream-json). Both are one-shot print-mode captures.
const ARGS = {
  claude: ['-p', '--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json'],
  agy: ['--output-format', 'stream-json', `-p=${PROMPTS[scenario]}`],
};

const work = join(tmpdir(), `flowstate-spike-${agent}-${Date.now()}`);
mkdirSync(work, { recursive: true });
const outDir = resolve('spikes/captures');
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, `${agent}-${scenario}.ndjson`);
const out = createWriteStream(outFile);

console.log(`[spike] ${agent} (${scenario}) cwd=${work}`);
const child = spawn(EXES[agent], ARGS[agent], { cwd: work, shell: false });

if (agent === 'claude') {
  const msg = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: PROMPTS[scenario] }] } };
  child.stdin.write(JSON.stringify(msg) + '\n');
} else {
  child.stdin.end();
}

let buf = '';
const types = new Map();
child.stdout.on('data', (d) => {
  out.write(d);
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const j = JSON.parse(line);
      // claude: {type, subtype}; agy: {event, step_update.step_type/state}
      const key = j.event
        ? `${j.event}${j.step_update ? '/' + j.step_update.step_type + ':' + j.step_update.state : ''}`
        : `${j.type}${j.subtype ? '/' + j.subtype : ''}`;
      types.set(key, (types.get(key) || 0) + 1);
      // Close stdin after the turn's result so the process exits.
      if (j.type === 'result' || j.event === 'result') child.stdin.end();
    } catch {
      types.set('NON-JSON', (types.get('NON-JSON') || 0) + 1);
    }
  }
});
child.stderr.on('data', (d) => process.stderr.write(`[stderr] ${d}`));
child.on('error', (e) => console.error('[spike] spawn error:', e.message));
const timer = setTimeout(() => { console.error('[spike] timeout, killing'); child.kill(); }, 120000);
child.on('close', (code) => {
  clearTimeout(timer);
  out.end();
  writeFileSync(join(outDir, `${agent}-${scenario}.summary.json`), JSON.stringify({ code, types: Object.fromEntries(types) }, null, 2));
  console.log(`[spike] exit=${code} event types:`, Object.fromEntries(types));
  console.log(`[spike] raw capture: ${outFile}`);
});
