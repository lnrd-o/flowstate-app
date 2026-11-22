// Phase 5 browser mock: a realistic AGY-style rich turn (thinking, write_file + file-change, run_command output,
// edit_file + file-change, a failing command) and a claude-style one (tool inputs only, no file-change events).
// Hash flags: #rich (AGY events), #richclaude (claude events). Triggered on the first send after the page loads.
import { makeUnifiedDiff, newFileDiff } from './diff.js';

const HELLO_V1 = 'def greet(name):\n    return "Hello, " + name\n\n\nitems = ["a", "b", "c"]\nprint(greet("FlowState"))\nprint(len(items), "items")\n';
const HELLO_V2 = HELLO_V1.replace('return "Hello, " + name', 'return f"Hello, {name}!"');
const ESC = String.fromCharCode(27);

function longOutput(n) {
  const lines = [];
  for (let i = 1; i <= n; i++) lines.push((i % 37 === 0 ? ESC + '[31mFAILED' + ESC + '[0m ' : ESC + '[32mPASSED' + ESC + '[0m ') + 'tests/test_module_' + String(i).padStart(3, '0') + '.py::test_case');
  lines.push('', '=== ' + n + ' collected, ' + Math.floor(n / 37) + ' failed ===');
  return lines.join('\n');
}

const ANSWER = [
  '## Done\n\n',
  'I created `hello.py`, ran it, then fixed the greeting format.\n\n',
  '| Step | Result |\n|------|--------|\n| `python hello.py` | ok |\n| `python hello.py --strict` | failed: unknown flag |\n\n',
  'The strict flag is not implemented yet, so that last command exits with code 1. Want me to add it?',
];

export function wantsRich(hash) {
  if (/#richclaude/.test(hash)) return 'claude';
  if (/#rich/.test(hash)) return 'agy';
  return null;
}

/** Returns an array of [delayMs, event] pairs for one rich turn. */
export function richScript(style, root) {
  const abs = (p) => root + '\\' + p;
  const ev = [];
  let t = 150;
  const at = (d, e) => { t += d; ev.push([t, e]); };
  const chunks = (text, size = 12, gap = 14) => { for (let i = 0; i < text.length; i += size) at(gap, { type: 'text-delta', text: text.slice(i, i + size) }); };

  at(0, { type: 'session', sessionId: 'rich-1', warning: style === 'agy' ? 'always-proceed' : undefined });
  if (style === 'agy') {
    at(500, { type: 'thinking', id: 'c:1', durationMs: 4200, tokens: 640, outputTokens: 38 });
    chunks('I will create hello.py, run it and fix anything that looks off.\n\n');
    at(100, { type: 'tool-use', id: 'c:2', name: 'write_file', kind: 'write', input: { TargetFile: abs('hello.py') } });
    at(700, { type: 'file-change', id: 'c:2', path: 'hello.py', op: 'create', added: 7, removed: 0, diff: newFileDiff(HELLO_V1), truncated: false });
    at(30, { type: 'tool-result', id: 'c:2', name: 'write_file', kind: 'write', output: 'Created file ' + abs('hello.py'), durationMs: 740 });
    at(300, { type: 'thinking', id: 'c:3', durationMs: 1800, tokens: 210, outputTokens: 12 });
    at(100, { type: 'tool-use', id: 'c:4', name: 'run_command', kind: 'command', input: { CommandLine: 'python hello.py', Cwd: root } });
    at(1100, { type: 'tool-result', id: 'c:4', name: 'run_command', kind: 'command', output: 'Command exited with code 0.\n\nCommand output:\nHello, FlowState\n3 items', exitCode: 0, commandOutput: ESC + '[32mHello, FlowState' + ESC + '[0m\n3 items', durationMs: 1080 });
    at(250, { type: 'thinking', id: 'c:5', durationMs: 2600, tokens: 330, outputTokens: 20 });
    at(100, { type: 'tool-use', id: 'c:6', name: 'edit_file', kind: 'edit', input: { TargetFile: abs('hello.py') } });
    at(500, { type: 'file-change', id: 'c:6', path: 'hello.py', op: 'modify', added: 1, removed: 1, diff: makeUnifiedDiff(HELLO_V1, HELLO_V2), truncated: false });
    at(30, { type: 'tool-result', id: 'c:6', name: 'edit_file', kind: 'edit', output: 'Edited file', durationMs: 530 });
    at(200, { type: 'tool-use', id: 'c:7', name: 'view_file', kind: 'read', input: { AbsolutePath: abs('hello.py') } });
    at(300, { type: 'tool-result', id: 'c:7', name: 'view_file', kind: 'read', output: HELLO_V2, durationMs: 120 });
    at(150, { type: 'tool-use', id: 'c:8', name: 'run_command', kind: 'command', input: { CommandLine: 'python hello.py --strict', Cwd: root } });
    at(900, { type: 'tool-result', id: 'c:8', name: 'run_command', kind: 'command', output: 'x', exitCode: 1, commandOutput: 'Traceback (most recent call last):\n  File "hello.py", line 7, in <module>\n    parse(sys.argv)\nSystemExit: usage: hello.py [-h]\nhello.py: error: unrecognized arguments: --strict', durationMs: 880 });
    at(200, { type: 'tool-use', id: 'c:9', name: 'run_command', kind: 'command', input: { CommandLine: 'python -m pytest -q' } });
    at(800, { type: 'tool-result', id: 'c:9', name: 'run_command', kind: 'command', output: 'x', exitCode: 1, commandOutput: longOutput(240), durationMs: 5300 });
    at(200, { type: 'tool-use', id: 'c:10', name: 'write_file', kind: 'write', input: { TargetFile: abs('data/big.txt') } });
    const bigLines = Array.from({ length: 160 }, (_, i) => 'row ' + (i + 1) + ': lorem ipsum dolor sit amet');
    at(300, { type: 'file-change', id: 'c:10', path: 'data/big.txt', op: 'create', added: 160, removed: 0, diff: newFileDiff(bigLines.join('\n')), truncated: true });
    at(30, { type: 'tool-result', id: 'c:10', name: 'write_file', kind: 'write', output: 'Created file', durationMs: 300 });
    at(200, { type: 'thinking', id: 'c:11', durationMs: 1200, tokens: 90, outputTokens: 90 });
  } else {
    at(300, { type: 'thinking', text: 'The user wants hello.py. I will write it, then tighten the greeting with an edit and run it.' });
    chunks('I will create hello.py, then adjust the greeting.\n\n');
    at(100, { type: 'tool-use', id: 'k1', name: 'Write', input: { file_path: abs('hello.py'), content: HELLO_V1 } });
    at(500, { type: 'tool-result', id: 'k1', output: 'File created successfully at: ' + abs('hello.py') });
    at(150, { type: 'tool-use', id: 'k2', name: 'Edit', input: { file_path: abs('hello.py'), old_string: '    return "Hello, " + name', new_string: '    return f"Hello, {name}!"' } });
    at(500, { type: 'tool-result', id: 'k2', output: 'The file has been updated.' });
    at(150, { type: 'tool-use', id: 'k3', name: 'Read', input: { file_path: abs('hello.py') } });
    at(300, { type: 'tool-result', id: 'k3', output: '     1\tdef greet(name):\n     2\t    return f"Hello, {name}!"' });
    at(150, { type: 'tool-use', id: 'k4', name: 'Bash', input: { command: 'python hello.py --strict', description: 'Run strict mode' } });
    at(700, { type: 'tool-result', id: 'k4', output: 'usage: hello.py [-h]\nhello.py: error: unrecognized arguments: --strict\nExit code 2', isError: true });
  }
  chunks(ANSWER.join(''), 14, 10);
  at(100, { type: 'result', ok: true, costUsd: 0.0212 });
  return ev;
}
