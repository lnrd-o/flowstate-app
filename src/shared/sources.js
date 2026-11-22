// Sources = the places a turn can come from: three CLI agents (claude, agy, opencode) and DeepSeek (models served through the
// Claude Code CLI with an API key). Each has an enable switch (settings.agentsEnabled). Pure helpers shared by main and renderer.
export const SOURCES = Object.freeze(['claude', 'agy', 'opencode', 'deepseek']);
export const CLI_AGENTS = Object.freeze(['claude', 'agy', 'opencode']);

export const defaultAgentsEnabled = () => ({ claude: true, agy: true, opencode: true, deepseek: false });

/** Valid when it is an object whose present keys are booleans of known sources. */
export function isAgentsEnabled(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every((k) => SOURCES.includes(k) && typeof v[k] === 'boolean');
}

/** Complete { claude, agy, opencode, deepseek } map from a partial/legacy value. `legacyDeepseek` = old settings.deepseekEnabled. */
export function normalizeAgentsEnabled(v, legacyDeepseek) {
  const out = defaultAgentsEnabled();
  if (typeof legacyDeepseek === 'boolean') out.deepseek = legacyDeepseek;
  if (isAgentsEnabled(v)) Object.assign(out, v);
  return out;
}

/** At least one source must stay on. */
export const hasEnabledSource = (map) => SOURCES.some((s) => map && map[s] === true);

/** Is a source on? Works with a settings object (missing map -> defaults, honouring legacy deepseekEnabled). */
export function isSourceEnabled(settings, id) {
  const m = normalizeAgentsEnabled(settings && settings.agentsEnabled, settings && !settings.agentsEnabled ? settings.deepseekEnabled : undefined);
  return m[id] === true;
}

/** Enabled sources, in SOURCES order. */
export const enabledSources = (settings) => SOURCES.filter((s) => isSourceEnabled(settings, s));

/** Can this source be switched off? (never the last enabled one). */
export function canDisableSource(settings, id) {
  return !isSourceEnabled(settings, id) || enabledSources(settings).some((s) => s !== id);
}

/** CLI agents selectable in the UI. DeepSeek is served by the claude CLI, so it keeps `claude` selectable. */
export function enabledAgents(settings) {
  return CLI_AGENTS.filter((a) => (a === 'claude' ? isSourceEnabled(settings, 'claude') || isSourceEnabled(settings, 'deepseek') : isSourceEnabled(settings, a)));
}

const DEEPSEEK_RE = /^deepseek[-_.]/i;

/** Which source a project depends on: deepseek for a claude project on a DeepSeek model, else its agent. */
export function sourceOfProject(project) {
  if (!project) return null;
  if (project.agent === 'claude' && typeof project.model === 'string' && DEEPSEEK_RE.test(project.model)) return 'deepseek';
  return CLI_AGENTS.includes(project.agent) ? project.agent : null;
}

/** The disabled source a project needs (or null when it can run). */
export function disabledSourceOf(settings, project) {
  const s = sourceOfProject(project);
  return s && !isSourceEnabled(settings, s) ? s : null;
}

/** Agent to suggest instead of a disabled one: first enabled agent other than `exclude`. */
export const fallbackAgent = (settings, exclude) => enabledAgents(settings).find((a) => a !== exclude) || null;

/** Drop model options of a disabled provider: group 'claude' needs claude, 'deepseek' needs deepseek. */
export function filterModelsBySource(models, settings) {
  const list = Array.isArray(models) ? models : [];
  return list.filter((m) => {
    if (m && m.group === 'deepseek') return isSourceEnabled(settings, 'deepseek');
    if (m && m.group === 'claude') return isSourceEnabled(settings, 'claude');
    return true;
  });
}
