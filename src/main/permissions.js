// Narrow, per-turn permission rules for claude (`--allowedTools "Tool(pattern)"`), built from renderer requests.
// The renderer asks for [{tool, pattern}]; we validate strictly and turn them into rule strings. Rules are NEVER persisted:
// they apply to the single turn that is being (re)sent after the user pressed "Allow this once".
//
// Safety rules (deliberately conservative):
//  - only known tools; a pattern is ALWAYS required, except for WebSearch (it has no pattern, so a tool-wide allow is the only form)
//  - patterns are exact: no '*' wildcards (they would widen the rule), no parentheses (they would break the rule syntax),
//    no control characters / newlines, max 300 chars
//  - WebFetch is allowed narrowly by DOMAIN only: `WebFetch(domain:example.com)` with a strictly validated hostname
//  - at most 5 rules per turn
//
// Verified against claude 2.1.330 (-p): `Write(path)` / `MultiEdit(path)` / `NotebookEdit(path)` rules do NOT match
// (the action stays blocked); `Edit(path)` is the rule that covers every file-editing tool, with backslash or slash paths.

import { protectionPlan } from '../shared/protections.js';

export const ALLOWED_TOOLS = Object.freeze(['Bash', 'PowerShell', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Read', 'WebFetch', 'WebSearch']);
export const MAX_RULES = 5;
export const MAX_PATTERN = 300;

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/** Strict hostname check for WebFetch(domain:...): lowercase DNS name with a dot, or an IPv4 literal. No ports, paths, wildcards. */
export function validDomain(d) {
  if (typeof d !== 'string') return false;
  const s = d.trim().toLowerCase();
  if (HOST_RE.test(s)) return true;
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(s) && s.split('.').every((n) => Number(n) <= 255);
}

/** Rule tool name: every file-editing tool is expressed as `Edit(...)`, the only form claude matches for them. */
export function ruleTool(tool) {
  return EDIT_TOOLS.has(tool) ? 'Edit' : tool;
}

/**
 * @param {unknown} list array of {tool, pattern}
 * @returns {string[]} rule strings like "PowerShell(python hello.py)", "Edit(C:\\p\\a.txt)", "WebFetch(domain:example.com)", "WebSearch"
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
    let rule;
    if (r.tool === 'WebSearch') {
      rule = 'WebSearch'; // no pattern exists for it: tool-wide allow, only here
    } else {
      const p = r.pattern;
      if (typeof p !== 'string' || !p.trim()) throw new TypeError('allow: pattern is required');
      if (p.length > MAX_PATTERN) throw new TypeError('allow: pattern too long');
      // eslint-disable-next-line no-control-regex
      if (/[\u0000-\u001f\u007f]/.test(p)) throw new TypeError('allow: pattern has control characters');
      if (r.tool === 'WebFetch') {
        const d = p.trim().replace(/^domain:/i, '').toLowerCase();
        if (!validDomain(d)) throw new TypeError('allow: invalid domain');
        rule = `WebFetch(domain:${d})`;
      } else {
        if (/[*()]/.test(p)) throw new TypeError('allow: wildcards and parentheses are not permitted in a pattern');
        rule = `${ruleTool(r.tool)}(${p.trim()})`;
      }
    }
    if (!rules.includes(rule)) rules.push(rule);
  }
  return rules;
}

/** CLI args for the rules: one `--allowedTools <rule>` pair per rule (the flag is variadic, so repeat it). */
export function allowArgs(rules) {
  return (rules ?? []).flatMap((rule) => ['--allowedTools', rule]);
}

// ---- "Always ask" protections (see src/shared/protections.js) ----
export const MAX_UNPROTECT = 10;
const UNPROTECT_TOOLS = ['Bash', 'PowerShell', 'Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit'];

/**
 * Per-turn "Allow this once" for a PROTECTED action: [{tool, value}] (value = the exact command or file path). It never reaches the
 * CLI as an allow rule; it only removes the deny rules that action matches for this one turn. Strict: known tools, bounded strings.
 * @returns {{tool:string, value:string}[]}
 */
export function sanitizeUnprotect(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new TypeError('unprotect must be an array');
  if (list.length > MAX_UNPROTECT) throw new TypeError(`unprotect: at most ${MAX_UNPROTECT} items`);
  const out = [];
  for (const r of list) {
    if (!r || typeof r !== 'object') throw new TypeError('unprotect: each item must be an object');
    if (!UNPROTECT_TOOLS.includes(r.tool)) throw new TypeError('unprotect: tool not permitted');
    if (typeof r.value !== 'string' || !r.value.trim() || r.value.length > 4000) throw new TypeError('unprotect: invalid value');
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(r.value)) throw new TypeError("unprotect: value has control characters");
    out.push({ tool: r.tool, value: r.value });
  }
  return out;
}

/** CLI args for Auto-accept with protections: { permissionMode, args } or null when no protection applies. */
export function protectionArgs(project) {
  const plan = protectionPlan(project.protections, project.unprotect, project.path);
  if (!plan) return null;
  return {
    permissionMode: plan.permissionMode,
    args: [...plan.allow.flatMap((r) => ['--allowedTools', r]), ...plan.deny.flatMap((r) => ['--disallowedTools', r])],
  };
}
