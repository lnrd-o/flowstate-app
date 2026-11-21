// Fake claude/agy CLI emitting canned stream-json. Usage: node fake-agent.js --style claude|agy [other flags ignored]
// Env: FAKE_DELAY (ms between lines), FAKE_FAIL=1 (stderr + exit 2, no result), FAKE_PERMISSION_MODE (agy init), FAKE_DUMP_ARGS=1.
const argv = process.argv.slice(2);
const style = argv[argv.indexOf('--style') + 1] === 'agy' ? 'agy' : 'claude';
const delay = Number(process.env.FAKE_DELAY || 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

async function readPrompt() {
  if (style === 'agy') {
    const a = argv.find((x) => x.startsWith('-p='));
    return a ? a.slice(3) : '';
  }
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      buf += c;
      if (buf.includes('\n')) {
        process.stdin.removeAllListeners('data');
        let t = '';
        try { t = JSON.parse(buf.split('\n')[0]).message.content[0].text; } catch { /* ignore */ }
        resolve(t);
      }
    });
    process.stdin.on('end', () => resolve(''));
  });
}

const prompt = await readPrompt();
if (process.env.FAKE_FAIL === '1') {
  process.stderr.write('fake failure: boom\n');
  process.exit(2);
}

const lines = style === 'claude' ? [
  { type: 'system', subtype: 'init', session_id: 'fake-session-1', model: 'fake', permissionMode: 'default', tools: ['Bash'], args: process.env.FAKE_DUMP_ARGS ? argv : undefined },
  { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'echo: ' } } },
  { type: 'assistant', message: { content: [{ type: 'text', text: `echo: ${prompt}` }] } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool1', name: 'Bash', input: { command: 'ls' } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool1', content: 'file.txt' }] } },
  { type: 'result', is_error: false, result: 'done', total_cost_usd: 0.01, duration_ms: 5, session_id: 'fake-session-1' },
] : [
  { event: 'init', conversation_id: 'fake-conv-1', init: { permission_mode: process.env.FAKE_PERMISSION_MODE || 'always-proceed', tools: [] } },
  { event: 'step_update', step_update: { conversation_id: 'fake-conv-1', step_index: 0, step_type: 'agent_response', state: 'ACTIVE', text_delta: `echo: ${prompt}` } },
  { event: 'step_update', step_update: { conversation_id: 'fake-conv-1', step_index: 1, step_type: 'tool', state: 'ACTIVE', tool_name: 'run_command', tool_info: { parameters: { command: 'ls' } } } },
  { event: 'step_update', step_update: { conversation_id: 'fake-conv-1', step_index: 1, step_type: 'tool', state: 'DONE', tool_name: 'run_command', tool_info: { output: 'file.txt' } } },
  { event: 'result', result: { status: 'SUCCESS', response: 'done', duration_seconds: 0.005 } },
];

for (const l of lines) {
  out(l);
  if (delay) await sleep(delay);
}
if (style === 'claude') {
  // like the real CLI with stream-json input: stay alive until stdin closes
  process.stdin.on('end', () => process.exit(0));
  process.stdin.resume();
} else {
  process.exit(0);
}
