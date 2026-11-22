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
      id: m.id, label: m.name || m.id, sub: dev ? m.id : '', description: m.description || '',
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
