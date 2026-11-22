// Run routes. A route says WHICH backend serves a turn; resume ids are not portable between routes.
//   'anthropic' : the CLI's own login (default).   'deepseek' : Claude Code CLI pointed at DeepSeek's Anthropic-compatible endpoint.
// The DeepSeek API key is only ever put into the CHILD PROCESS ENV by deepseekEnv() (never args, logs, disk or the renderer).
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/anthropic';
export const DEEPSEEK_RE = /^deepseek[-_.]/i;
export const DEEPSEEK_BUILTIN = Object.freeze([
  { id: 'deepseek-chat', name: 'DeepSeek Chat' },
  { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
]);

export const isDeepseekModel = (id) => typeof id === 'string' && DEEPSEEK_RE.test(id);

/** 'deepseek' when a claude project has a DeepSeek model selected; 'opencode' for opencode; else 'anthropic' / 'agy'. */
export function routeOf(project = {}) {
  if (project.agent === 'claude' && isDeepseekModel(project.model)) return 'deepseek';
  return project.agent === 'agy' ? 'agy' : project.agent === 'opencode' ? 'opencode' : 'anthropic';
}

/** Env overrides for Claude Code against DeepSeek (names per api-docs.deepseek.com Claude Code guide). Every model slot = the chosen model. */
export function deepseekEnv(key, model) {
  const m = isDeepseekModel(model) ? model : 'deepseek-chat';
  return {
    ANTHROPIC_BASE_URL: DEEPSEEK_BASE_URL,
    ANTHROPIC_AUTH_TOKEN: key,
    ANTHROPIC_MODEL: m,
    ANTHROPIC_SMALL_FAST_MODEL: m,
    ANTHROPIC_DEFAULT_OPUS_MODEL: m,
    ANTHROPIC_DEFAULT_SONNET_MODEL: m,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: m,
    CLAUDE_CODE_SUBAGENT_MODEL: m,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    API_TIMEOUT_MS: '600000',
  };
}

/** Merge route env over a base env; drops ANTHROPIC_API_KEY (it would win over the auth token). */
export function mergeEnv(base, extra) {
  const out = { ...(base ?? process.env), ...extra };
  if (extra?.ANTHROPIC_AUTH_TOKEN) delete out.ANTHROPIC_API_KEY;
  return out;
}
