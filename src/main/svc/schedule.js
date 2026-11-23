// Scheduled tasks: run a prompt (or a saved recipe/methodology) in a project on a timer, e.g. "every Monday at 09:00 update the
// sales dashboard from the newest file in data/". Runs only while FlowState is open (it starts with Windows when "Start FlowState
// when I sign in" is on); a run missed while the app was closed runs once at the next start if it is less than 24 h late.
// Stored in <userData>/schedules.json. A task never runs while the project is busy: it waits for the next check (30 s).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CH } from '../../shared/ipc.js';
import { writeJsonAtomic, readJson } from '../settings.js';

export const MAX_TASKS = 50;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY = 24 * 3600 * 1000;

/** Validate and normalise a task patch. Throws TypeError. */
export function cleanTask(t) {
  if (!t || typeof t !== 'object') throw new TypeError('task required');
  const name = String(t.name ?? '').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 80);
  if (!name) throw new TypeError('name required');
  if (typeof t.projectId !== 'string' || !t.projectId) throw new TypeError('project required');
  const kind = t.kind === 'recipe' ? 'recipe' : 'prompt';
  const prompt = kind === 'prompt' ? String(t.prompt ?? '').trim().slice(0, 8000) : '';
  if (kind === 'prompt' && !prompt) throw new TypeError('prompt required');
  const recipeId = kind === 'recipe' ? String(t.recipeId ?? '') : '';
  if (kind === 'recipe' && !/^[A-Za-z0-9._-]{1,80}$/.test(recipeId)) throw new TypeError('recipe required');
  const vars = kind === 'recipe' && t.vars && typeof t.vars === 'object' ? Object.fromEntries(Object.entries(t.vars).slice(0, 30).map(([k, v]) => [String(k).slice(0, 60), String(v ?? '').slice(0, 2000)])) : {};
  const freq = ['hourly', 'daily', 'weekly'].includes(t.freq) ? t.freq : 'daily';
  const time = TIME_RE.test(t.time ?? '') ? t.time : '09:00';
  const days = freq === 'weekly' ? [...new Set((Array.isArray(t.days) ? t.days : []).map(Number).filter((d) => d >= 0 && d <= 6))].sort() : [];
  if (freq === 'weekly' && !days.length) throw new TypeError('pick at least one day');
  return { name, projectId: t.projectId, kind, prompt, recipeId, vars, freq, time, days, enabled: t.enabled !== false, catchUp: t.catchUp !== false };
}

/** Pure: next run time (ms) strictly after `from` (local time). */
export function nextRun(task, from) {
  const d = new Date(from);
  const [hh, mm] = task.time.split(':').map(Number);
  if (task.freq === 'hourly') {
    const n = new Date(d); n.setSeconds(0, 0); n.setMinutes(mm);
    if (n.getTime() <= from) n.setHours(n.getHours() + 1);
    return n.getTime();
  }
  for (let i = 0; i <= 8; i++) {
    const n = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i, hh, mm, 0, 0);
    if (n.getTime() <= from) continue;
    if (task.freq === 'weekly' && !task.days.includes(n.getDay())) continue;
    return n.getTime();
  }
  return from + 7 * DAY;
}

export function create({ dir, projects, agents, runner, push = () => {}, services, fsx = fs, now = Date.now, setIntervalFn = setInterval, clearIntervalFn = clearInterval }) {
  const file = path.join(dir, 'schedules.json');
  const raw = readJson(file, { tasks: [] }, fsx);
  let tasks = Array.isArray(raw?.tasks) ? raw.tasks.filter((t) => t && typeof t.id === 'string').slice(0, MAX_TASKS) : [];
  const save = () => { try { writeJsonAtomic(file, { version: 1, tasks }, fsx); } catch { /* ignore */ } };
  const view = () => tasks.map((t) => ({ ...t, projectName: projects.get(t.projectId)?.name ?? null }));
  const emit = () => push(CH.evSchedule, { tasks: view() });

  // First start: schedule every task from now; a task whose previous due time passed within 24 h while closed runs once (catchUp).
  const start = now();
  for (const t of tasks) {
    if (!t.nextAt || t.nextAt <= start) {
      const missed = t.nextAt && start - t.nextAt < DAY && t.catchUp && t.enabled;
      t.nextAt = missed ? start + 20000 : nextRun(t, start);
    }
  }
  save();

  const busy = (projectId) => !!agents?.status?.(projectId)?.running || (runner?.listActive?.() ?? []).some((r) => r.projectId === projectId);

  async function runTask(t, manual = false) {
    const p = projects.get(t.projectId);
    if (!p) { t.lastResult = { at: now(), ok: false, error: 'project-missing' }; save(); emit(); return t.lastResult; }
    if (busy(t.projectId)) return { ok: false, error: 'busy' };
    t.lastRun = now();
    try {
      if (t.kind === 'recipe') {
        if (!runner?.run) throw new Error('recipes are not available');
        await runner.run(t.projectId, t.recipeId, t.vars || {});
      } else {
        await agents.send({ projectId: t.projectId, text: `${t.prompt}\n\n[Scheduled task "${t.name}"${manual ? ' run manually' : ''}: run it unattended and finish with a short summary of what you did.]` });
      }
      t.lastResult = { at: now(), ok: true };
      try { services?.workflow?.notify?.(t.projectId, 'scheduled', { text: t.name }); } catch { /* ignore */ }
    } catch (e) {
      t.lastResult = { at: now(), ok: false, error: String(e?.message ?? e).slice(0, 300) };
    }
    save(); emit();
    return t.lastResult;
  }

  async function tick() {
    const n = now();
    for (const t of tasks) {
      if (!t.enabled || !t.nextAt || t.nextAt > n) continue;
      if (busy(t.projectId)) continue; // try again on the next tick
      t.nextAt = nextRun(t, n);
      await runTask(t);
    }
  }
  const timer = setIntervalFn(() => { tick().catch(() => {}); }, 30000);
  timer?.unref?.();

  return {
    list: () => view(),
    save(input) {
      const clean = cleanTask(input);
      if (!projects.get(clean.projectId)) throw new TypeError('unknown project');
      let t = typeof input.id === 'string' ? tasks.find((x) => x.id === input.id) : null;
      if (!t) {
        if (tasks.length >= MAX_TASKS) throw new Error('Too many scheduled tasks');
        t = { id: crypto.randomUUID(), createdAt: now(), lastRun: null, lastResult: null };
        tasks.push(t);
      }
      Object.assign(t, clean, { nextAt: nextRun(clean, now()) });
      save(); emit();
      return { ...t };
    },
    remove(id) { tasks = tasks.filter((t) => t.id !== id); save(); emit(); return { ok: true }; },
    async runNow(id) {
      const t = tasks.find((x) => x.id === id);
      if (!t) return { ok: false, error: 'unknown' };
      return runTask(t, true);
    },
    tick,
    dispose() { clearIntervalFn(timer); },
  };
}
