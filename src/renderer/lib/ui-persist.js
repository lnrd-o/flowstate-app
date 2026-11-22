// Persists UI state through ui.get/set (global, userData) and ui.projectGet/projectSet (inside <project>/.flowstate/state.json).
// Writes are debounced (400 ms) and flushed immediately on quit. Everything is feature-detected so the mock / a plain browser still works.
import { debounce, fitUi, globalSlice, restorePlan } from './ui-state.js';

export const UI_DEBOUNCE_MS = 400;

export function createUiPersist({ api, store }) {
  const has = !!(api.ui && api.ui.get && api.ui.set);
  const inflight = new Set();
  const track = (p) => { const q = Promise.resolve(p).catch(() => {}).finally(() => inflight.delete(q)); inflight.add(q); return q; };
  const pending = new Map(); // projectId -> accumulated patch

  const writeGlobal = debounce(() => { if (has) track(api.ui.set(fitUi(globalSlice(store.get())))); }, UI_DEBOUNCE_MS);
  const writeProjects = debounce(() => {
    for (const [pid, patch] of pending) if (has && api.ui.projectSet) track(api.ui.projectSet(pid, patch));
    pending.clear();
  }, UI_DEBOUNCE_MS);

  function setProject(pid, patch) {
    if (!has || !pid) return;
    pending.set(pid, { ...(pending.get(pid) || {}), ...patch });
    writeProjects();
  }

  let off = null;
  function watch() {
    if (off) return;
    off = store.subscribe((s, prev) => {
      if (s.sidebarCollapsed !== prev.sidebarCollapsed || s.artifactsCollapsed !== prev.artifactsCollapsed || s.view !== prev.view
        || s.artifactsWidth !== prev.artifactsWidth || s.sidebarWidth !== prev.sidebarWidth) writeGlobal();
      if (s.artifactsTab !== prev.artifactsTab) setProject(s.activeProjectId, { artifactsTab: s.artifactsTab });
      if (s.openFile !== prev.openFile && s.activeProjectId === prev.activeProjectId) setProject(s.activeProjectId, { openFile: s.openFile || '' });
    });
  }

  return {
    available: has,
    async readGlobal() { try { return has ? (await api.ui.get()) || {} : {}; } catch { return {}; } },
    async readProject(pid) { try { return has && api.ui.projectGet && pid ? (await api.ui.projectGet(pid)) || {} : {}; } catch { return {}; } },
    plan: restorePlan,
    watch,
    setDraft: (pid, text) => setProject(pid, { draft: text || '' }),
    setScroll: (pid, top) => setProject(pid, { scroll: Math.max(0, Math.round(top || 0)) }),
    setProject,
    /** Write everything now and wait for the calls to finish. */
    async flush() {
      if (has) track(api.ui.set(fitUi(globalSlice(store.get()))));
      writeGlobal.cancel();
      writeProjects.flush();
      await Promise.all([...inflight]);
    },
  };
}
