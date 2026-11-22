// Shared validation + CLI args for the per-project model / effort selection (Phase 7).
export const EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;

export const isModel = (v) => v === null || (typeof v === 'string' && MODEL_RE.test(v));
export const isEffort = (v) => v === null || EFFORTS.includes(v);

/** ['--model', id] unless unset / 'default'; ['--effort', e] when set. Invalid values are dropped (never reach the CLI). */
export function modelArgs(project = {}) {
  const out = [];
  const m = project.model;
  if (typeof m === 'string' && m !== 'default' && MODEL_RE.test(m)) out.push('--model', m);
  if (typeof project.effort === 'string' && EFFORTS.includes(project.effort)) out.push('--effort', project.effort);
  return out;
}
