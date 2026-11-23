// Fake claude/agy CLI emitting canned stream-json. Usage: node fake-agent.js --style claude|agy [other flags ignored]
// Env: FAKE_DELAY (ms between lines), FAKE_FAIL=1 (stderr + exit 2, no result), FAKE_PERMISSION_MODE (agy init), FAKE_DUMP_ARGS=1,
// FAKE_EDIT=1 (really writes/modifies <cwd>/fake-edit.txt between an Edit/Write tool-use and its tool-result; FAKE_EDIT_PATH overrides the path).
const argv = process.argv.slice(2);
const styleArg = argv[argv.indexOf('--style') + 1];
const style = styleArg === 'agy' ? 'agy' : styleArg === 'opencode' ? 'opencode' : 'claude';
const delay = Number(process.env.FAKE_DELAY || 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

async function readPrompt() {
  if (style === 'opencode') { const i = argv.indexOf('--'); return i >= 0 ? argv[i + 1] : ''; } // `opencode run ... -- <text>`
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

const fs = await import('node:fs');
const pathMod = await import('node:path');
const editFile = process.env.FAKE_EDIT_PATH || pathMod.join(process.cwd(), 'fake-edit.txt');
const existed = process.env.FAKE_EDIT === '1' && fs.existsSync(editFile);
const doEdit = () => fs.writeFileSync(editFile, existed ? 'one\nTWO\nthree\n' : 'one\ntwo\nthree\n');
const editLines = process.env.FAKE_EDIT !== '1' ? [] : style === 'opencode' ? [
  { type: 'tool_use', sessionID: 'ses_fake1', part: { type: 'tool', callID: 'oe1', tool: existed ? 'edit' : 'write', state: { status: 'running', input: { filePath: editFile } } } },
  { __do: doEdit },
  { type: 'tool_use', sessionID: 'ses_fake1', part: { type: 'tool', callID: 'oe1', tool: existed ? 'edit' : 'write', state: { status: 'completed', input: { filePath: editFile }, output: 'ok' } } },
] : style === 'claude' ? [
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'edit1', name: existed ? 'Edit' : 'Write', input: { file_path: editFile } }] } },
  { __do: doEdit },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'edit1', content: 'ok' }] } },
] : [
  { event: 'step_update', step_update: { conversation_id: 'fake-conv-1', step_index: 5, step_type: 'tool', state: 'ACTIVE', tool_name: existed ? 'edit_file' : 'write_file', tool_info: { parameters: { Path: editFile } } } },
  { __do: doEdit },
  { event: 'step_update', step_update: { conversation_id: 'fake-conv-1', step_index: 5, step_type: 'tool', state: 'DONE', tool_name: existed ? 'edit_file' : 'write_file', tool_info: { output: 'ok' } } },
];

const base = style === 'opencode' ? [
  { type: 'step_start', sessionID: 'ses_fake1', part: { type: 'step-start' } },
  { type: 'text', sessionID: 'ses_fake1', part: { type: 'text', text: `echo: ${prompt}` } },
  { type: 'tool_use', sessionID: 'ses_fake1', part: { type: 'tool', callID: 'ot1', tool: 'bash', state: { status: 'completed', input: { command: 'ls' }, output: 'file.txt', metadata: { exit: 0 }, time: { start: 1, end: 6 } } } },
  { type: 'step_finish', sessionID: 'ses_fake1', part: { type: 'step-finish', reason: 'stop', cost: 0, tokens: { input: 12, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } } },
] : style === 'claude' ? [
  { type: 'system', subtype: 'init', session_id: 'fake-session-1', model: 'fake', permissionMode: 'default', tools: ['Bash'], args: process.env.FAKE_DUMP_ARGS ? argv : undefined,
    // route env check (never prints the secret): FAKE_DUMP_ARGS=1 reports base URL / model and whether a token is present
    envSeen: process.env.FAKE_DUMP_ARGS ? { baseUrl: process.env.ANTHROPIC_BASE_URL, model: process.env.ANTHROPIC_MODEL, tokenSet: !!process.env.ANTHROPIC_AUTH_TOKEN, apiKeySet: !!process.env.ANTHROPIC_API_KEY } : undefined },
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

const lines = process.env.FAKE_NO_RESULT === '1' ? [...base.slice(0, -1)] : [...base.slice(0, -1), ...editLines, base[base.length - 1]]; // FAKE_NO_RESULT=1: exits 0 without any result
for (const l of lines) {
  if (l.__do) { await sleep(150); l.__do(); await sleep(150); continue; }
  out(l);
  if (delay) await sleep(delay);
}
if (process.env.FAKE_LINGER === '1') {
  // answered, but never exits (ignores stdin closing): the manager / adapter must end it
  process.stdin.resume();
  setInterval(() => {}, 1000);
} else if (style === 'claude') {
  // like the real CLI with stream-json input: stay alive until stdin closes
  process.stdin.on('end', () => process.exit(0));
  process.stdin.resume();
} else {
  process.exit(0);
}
