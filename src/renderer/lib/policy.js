// Approval policy shown in the composer: what each agent / mode asks about, and which models need an explicit OK (pay as you go).
// Pure (no DOM): unit-tested.

/**
 * What the combination agent + mode means for approvals.
 * -> { key: 'ask'|'edits'|'none'|'plan'|'all', tone: 'amber'|'green'|'red'|'muted' }
 *   ask    asks before file changes and commands (claude default)
 *   edits  file edits go through, commands / web still ask (claude acceptEdits; agy accept-edits)
 *   none   the agent never asks: tools just run (opencode run)
 *   plan   read-only: nothing is changed
 *   all    everything is accepted (still guarded by the "always ask" protections for Claude)
 */
export function policyOf(agent, mode) {
  const m = mode === 'acceptEdits' || mode === 'plan' || mode === 'auto' ? mode : 'default';
  if (m === 'plan') return { key: 'plan', tone: 'green' };
  if (m === 'auto') return { key: 'all', tone: 'red' };
  if (agent === 'opencode') return { key: 'none', tone: 'amber' };
  if (agent === 'agy') return { key: 'edits', tone: 'amber' };
  return m === 'acceptEdits' ? { key: 'edits', tone: 'amber' } : { key: 'ask', tone: 'green' };
}

/** Which models need an explicit OK before first use: OpenCode Zen (billed to credits) and DeepSeek (billed to the API balance). */
export function paygKind(model) {
  const id = String(model || '');
  if (/^opencode\//.test(id)) return 'zen';
  if (/^deepseek/i.test(id)) return 'deepseek';
  return null;
}

/** 'zen' | 'deepseek' when this model still needs the user's OK (not accepted one by one and not "accept all"), else null. */
export function modelNeedsAccept(model, settings) {
  const kind = paygKind(model);
  if (!kind) return null;
  const s = settings || {};
  if (s.acceptAllPayg === true) return null;
  if (Array.isArray(s.acceptedModels) && s.acceptedModels.includes(model)) return null;
  return kind;
}

/** Settings patch that records an acceptance: one model, or every pay-as-you-go model. */
export function acceptPatch(settings, model, all) {
  if (all) return { acceptAllPayg: true };
  const list = Array.isArray(settings && settings.acceptedModels) ? settings.acceptedModels : [];
  return { acceptedModels: [...new Set([...list, String(model)])].slice(-200) };
}
