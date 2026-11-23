// Pure helpers for the model + effort selectors. No DOM.
export const EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
export const SIMPLE_EFFORTS = Object.freeze(['low', 'medium', 'high']);

/** Effort values offered in a mode. Developer: all five. Simple: Fast (low) / Balanced (medium) / Thorough (high). */
export function effortValues(dev) { return dev ? EFFORTS : SIMPLE_EFFORTS; }

/** Simple mode folds xhigh/max (set elsewhere) into "Thorough"; unset shows Balanced. */
export function displayEffort(effort, dev) {
  if (dev) return EFFORTS.includes(effort) ? effort : 'medium';
  if (effort === 'xhigh' || effort === 'max') return 'high';
  return SIMPLE_EFFORTS.includes(effort) ? effort : 'medium';
}

/** Value to persist for a model choice: the default entry is stored as null (adapters then pass no --model). */
export function modelToStore(id, list) {
  if (!id || id === 'default' || (list && list.defaultModel && id === list.defaultModel)) return null;
  return id;
}

/** Id currently in effect: the project's model, else the list default. */
export function effectiveModelId(project, list) {
  return (project && project.model) || (list && list.defaultModel) || 'default';
}

/**
 * Options for the dropdown. Developer shows ids under the name; Simple only friendly names.
 * -> [{ id, label, sub, description, current, isDefault }]
 */
export function modelOptions(list, project, dev) {
  const models = list && Array.isArray(list.models) ? list.models : [];
  const eff = effectiveModelId(project, list);
  const usingDefault = !(project && project.model);
  return models.map((m) => {
    const isDefault = m.id === 'default' || (!!list.defaultModel && m.id === list.defaultModel);
    return {
      id: m.id, label: m.name || m.id, sub: dev ? m.id : '', description: m.description || '', group: m.group || '', disabled: !!m.disabled, needsKey: !!m.needsKey,
      current: m.id === eff || (usingDefault && isDefault), isDefault,
    };
  });
}

/** Label for the closed dropdown button. */
export function currentModelLabel(list, project, dev, fallback) {
  const opt = modelOptions(list, project || {}, dev).find((o) => o.current);
  if (opt) return opt.label;
  const id = project && project.model;
  if (id) return dev ? id : fallback;
  return fallback;
}

/** 'not-signed-in' style errors: the picker offers a Sign in button next to the text. */
export function modelsNeedSignIn(list) {
  return !!(list && typeof list.error === 'string' && /not[- ]signed[- ]in|sign in|login|log in/i.test(list.error));
}

/** Group key -> display group: 'opencode:<provider>' keeps the provider. Order: claude, gemini, deepseek, opencode. */
const GROUP_ORDER = ['claude', 'gemini', 'deepseek', 'opencode'];
export function groupModelOptions(opts) {
  const out = [];
  const idx = new Map();
  for (const o of opts) {
    const g = o.group || '';
    if (!idx.has(g)) { const e = { group: g, kind: g.split(':')[0], provider: g.includes(':') ? g.slice(g.indexOf(':') + 1) : '', options: [] }; idx.set(g, e); out.push(e); }
    idx.get(g).options.push(o);
  }
  const rank = (g) => (g.provider === 'opencode-go' ? 0 : g.provider === 'opencode' ? 2 : 1); // OpenCode Go (plan) first, Zen (pay-as-you-go) last
  return out.sort((a, b) => (GROUP_ORDER.indexOf(a.kind) + 1 || 99) - (GROUP_ORDER.indexOf(b.kind) + 1 || 99) || rank(a) - rank(b) || a.group.localeCompare(b.group));
}
