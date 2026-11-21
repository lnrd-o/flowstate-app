// Tiny observable log/state per long-running job (prereq installs, dashboard setup). No DOM.
const MAX_LINES = 400;

export function createJobs() {
  const jobs = new Map();
  const subs = new Set();
  const emit = (id) => { for (const fn of [...subs]) { try { fn(id, jobs.get(id)); } catch { /* ignore */ } } };
  const api = {
    get: (id) => jobs.get(id) || { running: false, lines: [], error: null, done: false },
    start(id) { jobs.set(id, { running: true, lines: [], error: null, done: false }); emit(id); },
    log(id, text) {
      const cur = api.get(id);
      const add = String(text ?? '').split(/\r?\n/).filter((l) => l.length);
      if (!add.length) return;
      jobs.set(id, { ...cur, lines: [...cur.lines, ...add].slice(-MAX_LINES) });
      emit(id);
    },
    finish(id, error) {
      const cur = api.get(id);
      jobs.set(id, { ...cur, running: false, done: !error, error: error ? String(error) : null });
      emit(id);
    },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
  return api;
}

export const installJobs = createJobs();
export const dashboardJobs = createJobs();

/** winget package ids shown in the install confirmation (the backend runs the real command). */
export const WINGET_IDS = { git: 'Git.Git', node: 'OpenJS.NodeJS.LTS', python: 'Python.Python.3.12' };
