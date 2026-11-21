// Builds a Methodology draft (source:'recorded', NOT saved) from a project's chat history. See 'Recorder rules' in src/shared/ipc.js.
import { validateMethodology, extractVarKeys, KEY_RE, LIMITS } from '../shared/methodology.js';
import { runCommand } from './run.js';
import { COMMIT_PREFIX } from './git.js';

/** Only the most recent MAX_TURNS user turns of the selected range are recorded. */
export const MAX_TURNS = 60;
export const NOTE_CAP = 500;
const MAX_FILES = 5;
const MIN_NAME_REPLACE = 3; // shorter project names would mangle ordinary words
const BUILTIN = new Set(['projectName', 'projectPath']);
const PATH_KEYS = ['file_path', 'filePath', 'path', 'TargetFile', 'AbsolutePath', 'target_file', 'file', 'notebook_path'];
const WRITE_TOOL_RE = /write|edit|replace|create_file|notebook|bash|command|shell|run/i;

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Replace the absolute project path and the project name (case-insensitive) with placeholders. */
export function templatize(text, project) {
  let out = String(text);
  const p = String(project.path ?? '').replace(/[\\/]+$/, '');
  if (p) {
    const alt = p.replace(/\\/g, '/');
    for (const v of new Set([p, alt, p.replace(/\//g, '\\')])) out = out.replace(new RegExp(esc(v), 'gi'), '@@FSPATH@@');
  }
  const n = String(project.name ?? '').trim();
  if (n.length >= MIN_NAME_REPLACE) out = out.replace(new RegExp(esc(n), 'gi'), '{{projectName}}');
  return out.replace(/@@FSPATH@@/g, '{{projectPath}}');
}

function relPath(p, projectPath) {
  if (typeof p !== 'string' || !p) return null;
  const norm = p.replace(/\\/g, '/');
  const root = projectPath.replace(/\\/g, '/').replace(/\/+$/, '');
  if (/^[a-zA-Z]:\//.test(norm) || norm.startsWith('/')) {
    if (norm.toLowerCase() === root.toLowerCase()) return '.';
    if (!norm.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return null; // outside the project: not recorded
    return norm.slice(root.length + 1);
  }
  return norm.replace(/^\.\//, '');
}

/** Summarise tool-use events: tool names with counts + up to 5 project-relative file paths, capped at NOTE_CAP chars. */
export function summarizeTools(events, projectPath) {
  const counts = new Map();
  const files = [];
  for (const ev of events) {
    if (ev?.type !== 'tool-use' || typeof ev.name !== 'string') continue;
    counts.set(ev.name, (counts.get(ev.name) ?? 0) + 1);
    if (!WRITE_TOOL_RE.test(ev.name) || !ev.input || typeof ev.input !== 'object') continue;
    for (const k of PATH_KEYS) {
      const rel = relPath(ev.input[k], projectPath);
      if (rel && !files.includes(rel) && files.length < MAX_FILES) files.push(rel);
      if (rel) break;
    }
  }
  if (!counts.size) return '';
  let note = `Tools: ${[...counts].map(([n, c]) => `${n} x${c}`).join(', ')}`;
  if (files.length) note += `. Files: ${files.join(', ')}`;
  return note.slice(0, NOTE_CAP);
}

/** Default git log reader: [{ts:ms, subject}] of recent commits. Resolves [] when not a repo / git missing. */
export async function readGitLog(cwd, run = runCommand) {
  const r = await run('git', ['log', '-n', '200', '--format=%ct|%s'], { cwd, timeout: 15000 });
  if (r.code !== 0) return [];
  return r.stdout.split('\n').map((l) => {
    const i = l.indexOf('|');
    return i > 0 ? { ts: Number(l.slice(0, i)) * 1000, subject: l.slice(i + 1).trim() } : null;
  }).filter((c) => c && Number.isFinite(c.ts));
}

/**
 * deps: history {get(projectId)}, getProject(id), gitLog(cwd) -> Promise<[{ts, subject}]> (optional; failures skip commit nodes),
 * now() -> ISO string.
 */
export function createRecorder({ history, getProject, gitLog = readGitLog, now = () => new Date().toISOString() }) {
  return {
    async record(projectId, { name, fromTs, toTs } = {}) {
      const project = getProject(projectId);
      if (!project) throw new Error('Unknown project');
      const recs = history.get(projectId);
      const inRange = (ts) => (fromTs === undefined || ts >= fromTs) && (toTs === undefined || ts <= toTs);
      // Group records into turns: a user record plus every record up to the next user record.
      let turns = [];
      for (let i = 0; i < recs.length; i++) {
        if (recs[i].t !== 'user' || !inRange(recs[i].ts)) continue;
        let j = i + 1;
        while (j < recs.length && recs[j].t !== 'user') j++;
        const nextTs = j < recs.length ? recs[j].ts : Infinity;
        turns.push({ user: recs[i], events: recs.slice(i + 1, j).filter((r) => r.t === 'event').map((r) => r.event), start: recs[i].ts, end: nextTs });
      }
      if (!turns.length || !turns.some((t) => String(t.user.text).trim())) throw new Error('Nothing to record: no user messages in the history');
      turns = turns.filter((t) => String(t.user.text).trim()).slice(-MAX_TURNS);

      let commits = [];
      try { commits = (await gitLog(project.path)) ?? []; } catch { commits = []; }
      commits = commits.filter((c) => typeof c.subject === 'string' && c.subject.startsWith(COMMIT_PREFIX));

      const nodes = [];
      const edges = [];
      const used = new Set();
      const add = (node) => {
        if (nodes.length) edges.push({ from: nodes[nodes.length - 1].id, to: `n${nodes.length + 1}` });
        nodes.push({ id: `n${nodes.length + 1}`, ...node });
      };
      for (const t of turns) {
        const text = templatize(t.user.text, project).slice(0, LIMITS.text);
        extractVarKeys(text).forEach((k) => { if (!BUILTIN.has(k) && KEY_RE.test(k)) used.add(k); });
        const firstLine = text.split('\n').find((l) => l.trim()) ?? text;
        const node = { type: 'prompt', title: firstLine.trim().replace(/\s+/g, ' ').slice(0, 60) || 'Prompt', text };
        const note = summarizeTools(t.events, project.path);
        if (note) node.note = note;
        add(node);
        // 1 s slack: git commit times have second resolution.
        const c = commits.find((x) => x.ts >= t.start - 1000 && x.ts < t.end);
        if (c) add({ type: 'git-commit', title: { en: 'Commit changes', es: 'Confirmar cambios' }, message: c.subject.slice(COMMIT_PREFIX.length).trim().slice(0, 300) || 'changes' });
      }

      const stamp = now();
      const nm = typeof name === 'string' && name.trim() ? name.trim().slice(0, 400) : null;
      const m = {
        id: `recorded-${Date.now().toString(36)}`,
        version: 1,
        source: 'recorded',
        name: nm ? { en: nm, es: nm } : { en: 'Recorded workflow', es: 'Flujo grabado' },
        description: { en: `Recorded from ${turns.length} chat turn(s).`, es: `Grabado de ${turns.length} turno(s) de chat.` },
        tags: ['recorded'],
        vars: [...used].slice(0, LIMITS.vars).map((key) => ({ key, label: { en: key, es: key }, type: 'text' })),
        nodes,
        edges,
        createdAt: stamp,
        updatedAt: stamp,
      };
      const errs = validateMethodology(m);
      if (errs.length) throw new Error(`Could not record: ${errs.join('; ')}`);
      return m;
    },
  };
}

