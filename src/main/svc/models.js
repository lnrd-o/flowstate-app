// Model lists. claude: static aliases (+ the exact model id seen in the latest session init); agy: LIVE from `agy models`.
import { runCommand } from '../run.js';
import { EFFORTS } from '../agents/model-spec.js';
import { DEEPSEEK_BUILTIN, isDeepseekModel } from '../agents/routes.js';

export const CLAUDE_ALIASES = Object.freeze([
  { id: 'default', name: 'Default (recommended)' },
  { id: 'opus', name: 'Opus' },
  { id: 'sonnet', name: 'Sonnet' },
  { id: 'haiku', name: 'Haiku' },
  { id: 'fable', name: 'Fable' },
]);
const LINE_RE = /^([A-Za-z0-9][\w.-]*)\t(.+)$/;
const SIGN_IN_RE = /please sign in|not signed in|log ?in required|sign in to continue/i;
export const CACHE_MS = 60 * 1000;

/** Parse `agy models` output: stderr carries 'Fetching available models...', stdout 'id<TAB>name' lines. -> {models, error?} */
export function parseAgyModels(stdout, stderr = '') {
  const models = [];
  const seen = new Set();
  for (const raw of String(stdout ?? '').split(/\r?\n/)) {
    const m = LINE_RE.exec(raw.replace(/\s+$/, ''));
    if (m && !seen.has(m[1])) { seen.add(m[1]); models.push({ id: m[1], name: m[2].trim() }); }
  }
  if (!models.length && SIGN_IN_RE.test(`${stdout ?? ''}\n${stderr ?? ''}`)) return { models: [], error: 'not-signed-in' };
  if (!models.length) return { models: [], error: 'no-models' };
  return { models };
}

/** Static claude list; `seen` = exact model id from the latest session event (appended + marked current when it is not an alias). */
export function claudeList(seen = null, extra = []) {
  const models = CLAUDE_ALIASES.map((m) => ({ ...m, group: 'claude' }));
  if (typeof seen === 'string' && seen) {
    const alias = models.find((m) => m.id === seen);
    if (alias) alias.current = true;
    else if (!isDeepseekModel(seen)) models.push({ id: seen, name: seen, current: true, group: 'claude' });
  }
  models.push(...extra);
  return { agent: 'claude', source: 'static', models, efforts: [...EFFORTS], defaultModel: 'default' };
}

/** Parse `opencode models` stdout: one "provider/model" per line (optionally "provider/model<TAB>name"). -> {models:[{id,name,group:'opencode:<provider>'}]} */
export function parseOpencodeModels(stdout, stderr = '') {
  const models = [];
  const seen = new Set();
  for (const raw of String(stdout ?? '').split(/\r?\n/)) {
    const m = /^([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9][\w.:/@-]*)(?:\s+(.+))?$/.exec(raw.trim());
    if (!m) continue;
    const id = `${m[1]}/${m[2]}`;
    if (seen.has(id) || id.length > 120) continue;
    seen.add(id);
    models.push({ id, name: m[3]?.trim() || m[2], group: `opencode:${m[1]}` });
  }
  if (!models.length && SIGN_IN_RE.test(`${stdout ?? ''}\n${stderr ?? ''}`)) return { models: [], error: 'not-signed-in' };
  if (!models.length) return { models: [], error: 'no-models' };
  return { models };
}

/** DeepSeek entries for the claude picker: builtin ids + whatever /models returned. Disabled (needs a key) when none is stored. */
export function deepseekModels(hasKey, fetched = []) {
  const ids = new Map(DEEPSEEK_BUILTIN.map((m) => [m.id, m.name]));
  for (const m of fetched) if (m && isDeepseekModel(m.id) && !ids.has(m.id)) ids.set(m.id, m.id);
  return [...ids].map(([id, name]) => ({ id, name, group: 'deepseek', ...(hasKey ? {} : { disabled: true, needsKey: true }) }));
}

export function createModels({ health, run = runCommand, now = Date.now, getProject = () => null, services = {} } = {}) {
  let claudeSeen = null;
  const cache = new Map(); // agent -> {at, value}

  async function agyList() {
    const exe = await health?.findAgy?.();
    if (!exe) return { agent: 'agy', source: 'live', models: [], efforts: [...EFFORTS], error: 'not-found' };
    const r = await run(exe, ['models'], { timeout: 15000 });
    const parsed = parseAgyModels(r.stdout, r.stderr);
    if (parsed.error === 'no-models' && r.code !== 0) parsed.error = 'failed';
    return { agent: 'agy', source: 'live', efforts: [...EFFORTS], ...parsed, models: (parsed.models ?? []).map((x) => ({ ...x, group: 'gemini' })) };
  }

  async function opencodeList() {
    const exe = await health?.findOpencode?.();
    if (!exe) return { agent: 'opencode', source: 'live', models: [], efforts: [], error: 'not-found' };
    const r = await run(exe, ['models'], { timeout: 20000 });
    const parsed = parseOpencodeModels(r.stdout, r.stderr);
    if (parsed.error === 'no-models' && r.code !== 0) parsed.error = 'failed';
    return { agent: 'opencode', source: 'live', efforts: [], ...parsed };
  }

  async function deepseekExtra() {
    const ds = services.deepseek;
    const hasKey = !!ds?.hasKey?.();
    let fetched = [];
    if (hasKey) { try { fetched = (await ds.status?.(false))?.models ?? []; } catch { fetched = []; } }
    return deepseekModels(hasKey, fetched);
  }

  return {
    async list(agent) {
      if (agent === 'claude') return claudeList(claudeSeen, await deepseekExtra());
      if (agent === 'opencode') {
        const oh = cache.get('opencode');
        if (oh && now() - oh.at < CACHE_MS) return oh.value;
        const ov = await opencodeList();
        if (!ov.error) cache.set('opencode', { at: now(), value: ov });
        return ov;
      }
      if (agent !== 'agy') throw new TypeError('invalid agent');
      const hit = cache.get('agy');
      if (hit && now() - hit.at < CACHE_MS) return hit.value;
      const value = await agyList();
      if (!value.error) cache.set('agy', { at: now(), value }); // errors are not cached: the user may sign in a moment later
      return value;
    },
    onAgentEvent(projectId, ev, meta) {
      if (ev?.type !== 'session' || typeof ev.model !== 'string' || !ev.model) return;
      const agent = meta?.agent ?? getProject(projectId)?.agent;
      if (agent === 'claude' && !isDeepseekModel(ev.model)) claudeSeen = ev.model;
    },
  };
}

export function create(deps) {
  return createModels({ health: deps.health, getProject: deps.getProject, services: deps.services });
}
