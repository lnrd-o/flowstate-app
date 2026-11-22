// Versions service: timeline / named versions / compare / restore / branch handler for a project, via src/main/versions.js.
// Joins the agent chat history onto auto-commits so the timeline can show the prompt that produced each one.
import { createVersions, attachPrompts } from '../versions.js';

export function create({ projects, history, versions = createVersions() }) {
  const cwd = (id) => {
    const p = projects.get(id);
    if (!p) throw new Error('Unknown project');
    return p.path;
  };
  return {
    async list(id, opts) {
      const r = await versions.list(cwd(id), opts);
      let recs = [];
      try { recs = history?.get(id) ?? []; } catch { recs = []; }
      return { ...r, commits: attachPrompts(r.commits, recs) };
    },
    save: (id, o) => versions.save(cwd(id), { label: o.label, note: o.note, ref: o.ref }),
    compare: (id, o) => versions.compare(cwd(id), { from: o.from, to: o.to, path: o.path }),
    restore: (id, o) => versions.restore(cwd(id), { ref: o.ref, path: o.path }),
    branch: (id, o) => versions.branch(cwd(id), { op: o.op, name: o.name, from: o.from, to: o.to, switch: o.switch }),
  };
}
