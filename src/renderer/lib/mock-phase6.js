// Phase 6 browser mock: a claude turn whose tool calls are BLOCKED by permissions (to exercise the approval card),
// and the retry that succeeds once the user pressed "Allow this once" (agent.send gets allow rules).
// Hash flags: #blocked (one blocked command), #blocked2 (a blocked command + a blocked file write: grouped card),
//             #simple / #dev (preset developerMode), plus the existing #rich / #richclaude.
const HELLO = 'def greet(name):\n    return f"Hello, {name}!"\n\n\nprint(greet("FlowState"))\n';
const NOTES = 'Notes\n- run hello.py\n- read the output\n';

export function wantsBlocked(hash) {
  if (/#blocked2/.test(hash)) return 2;
  if (/#blocked/.test(hash)) return 1;
  return 0;
}

/** developerMode preset from the hash: #simple -> false, #dev -> true, else null (default). */
export function devPreset(hash) {
  if (/#simple/.test(hash)) return false;
  if (/#dev\b/.test(hash)) return true;
  return null;
}

/** Do the per-turn allow rules cover every tool call the blocked script needs? */
export function allowCovers(allow, needs) {
  const rules = Array.isArray(allow) ? allow : [];
  return needs.every((n) => rules.some((r) => r && r.tool === n.tool && r.pattern === n.pattern));
}

/** What a blocked turn needs allowed (tool + exact pattern), for variant 1 or 2. */
export function blockedNeeds(root, variant) {
  const needs = [{ tool: 'PowerShell', pattern: 'python hello.py' }];
  if (variant === 2) needs.push({ tool: 'Write', pattern: root + '\\notes.txt' });
  return needs;
}

/** Returns [[delayMs, event], ...]. stage 'blocked' | 'allowed'. */
export function blockedScript(root, variant, stage, n = 0) {
  const abs = (p) => root + '\\' + p;
  const ev = [];
  let t = 150;
  const at = (d, e) => { t += d; ev.push([t, e]); };
  const chunks = (text) => { for (let i = 0; i < text.length; i += 12) at(14, { type: 'text-delta', text: text.slice(i, i + 12) }); };
  at(0, { type: 'session', sessionId: 'blocked-1' });
  if (stage === 'blocked') {
    chunks('I will create hello.py and run it' + (variant === 2 ? ', and write a notes file.' : '.') + '\n\n');
    at(100, { type: 'tool-use', id: 'bw', name: 'Write', input: { file_path: abs('hello.py'), content: HELLO } });
    at(400, { type: 'tool-result', id: 'bw', output: 'File created successfully at: ' + abs('hello.py') });
    at(150, { type: 'tool-use', id: 'b1', name: 'PowerShell', input: { command: 'python hello.py', description: 'Run the program' } });
    at(300, { type: 'permission-denied', id: 'b1', tool: 'PowerShell', reason: 'approval', message: 'This PowerShell command requires approval' });
    at(40, { type: 'tool-result', id: 'b1', output: 'This PowerShell command requires approval', isError: true });
    if (variant === 2) {
      at(150, { type: 'tool-use', id: 'b2', name: 'Write', input: { file_path: abs('notes.txt'), content: NOTES } });
      at(300, { type: 'permission-denied', id: 'b2', tool: 'Write', reason: 'workingDir', message: 'Claude requested permissions to write to ' + abs('notes.txt') + ", but you haven't granted it yet." });
      at(40, { type: 'tool-result', id: 'b2', output: 'Claude requested permissions to write to ' + abs('notes.txt') + ", but you haven't granted it yet.", isError: true });
    }
    chunks('\nI created hello.py, but I could not run it' + (variant === 2 ? ' or write the notes file' : '') + ' without your approval. Allow it and I will continue.');
  } else {
    chunks('Thanks, continuing.\n\n');
    at(100, { type: 'tool-use', id: 'a1', name: 'PowerShell', input: { command: 'python hello.py', description: 'Run the program' } });
    at(700, { type: 'tool-result', id: 'a1', output: 'Hello, FlowState!' });
    if (variant === 2) {
      at(150, { type: 'tool-use', id: 'a2', name: 'Write', input: { file_path: abs('notes.txt'), content: NOTES } });
      at(300, { type: 'tool-result', id: 'a2', output: 'File created successfully at: ' + abs('notes.txt') });
    }
    chunks('\nDone. Running `python hello.py` printed **Hello, FlowState!**' + (variant === 2 ? ' and I saved notes.txt.' : '.'));
  }
  at(100, { type: 'result', ok: true, costUsd: 0.01 });
  for (const [, e] of ev) if (e.id) e.id = e.id + '-' + n; // tool ids are unique per call in real streams
  return ev;
}
