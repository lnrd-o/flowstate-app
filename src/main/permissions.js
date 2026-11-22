// Narrow, per-turn permission rules for claude (`--allowedTools "Tool(pattern)"`), built from renderer requests.
// The renderer asks for [{tool, pattern}]; we validate strictly and turn them into rule strings. Rules are NEVER persisted:
// they apply to the single turn that is being (re)sent after the user pressed "Allow this once".
//
// Safety rules (deliberately conservative):
//  - only known tools; a pattern is ALWAYS required (no tool-wide allow such as plain "Bash")
//  - patterns are exact: no '*' wildcards (they would widen the rule), no parentheses (they would break the rule syntax),
//    no control characters / newlines, max 300 chars
//  - at most 5 rules per turn

export const ALLOWED_TOOLS = Object.freeze(['Bash', 'PowerShell', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
export const MAX_RULES = 5;
export const MAX_PATTERN = 300;

/**
 * @param {unknown} list array of {tool, pattern}
 * @returns {string[]} rule strings like "PowerShell(python hello.py)"
 * @throws {TypeError} on anything invalid
 */
export function sanitizeAllow(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new TypeError('allow must be an array');
  if (list.length > MAX_RULES) throw new TypeError(`allow: at most ${MAX_RULES} rules`);
  const rules = [];
  for (const r of list) {
    if (!r || typeof r !== 'object') throw new TypeError('allow: each rule must be an object');
    if (!ALLOWED_TOOLS.includes(r.tool)) throw new TypeError(`allow: tool not permitted: ${String(r.tool).slice(0, 40)}`);
    const p = r.pattern;
    if (typeof p !== 'string' || !p.trim()) throw new TypeError('allow: pattern is required');
    if (p.length > MAX_PATTERN) throw new TypeError('allow: pattern too long');
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(p)) throw new TypeError('allow: pattern has control characters');
    if (/[*()]/.test(p)) throw new TypeError('allow: wildcards and parentheses are not permitted in a pattern');
    const rule = `${r.tool}(${p.trim()})`;
    if (!rules.includes(rule)) rules.push(rule);
  }
  return rules;
}

/** CLI args for the rules: one `--allowedTools <rule>` pair per rule (the flag is variadic, so repeat it). */
export function allowArgs(rules) {
  return (rules ?? []).flatMap((rule) => ['--allowedTools', rule]);
}
