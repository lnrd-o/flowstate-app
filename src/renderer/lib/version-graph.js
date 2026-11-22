// Pure lane assignment for the Versions timeline graph (commits newest-first, topological order).
// -> rows[i] = { col, through:[cols], incoming:[cols], outgoing:[cols], cols } where
//    through  = lanes that pass this row untouched (vertical line over the full row height)
//    incoming = lanes (columns) arriving from the row above into this commit (top -> middle)
//    outgoing = lanes (columns) leaving this commit towards its parents (middle -> bottom)
//    cols     = number of columns this row needs.
export function layoutGraph(commits) {
  const lanes = []; // lane col -> sha it is waiting for (or null when free)
  const rows = [];
  for (const c of commits) {
    const incoming = [];
    lanes.forEach((s, i) => { if (s === c.sha) incoming.push(i); });
    let col = incoming.length ? incoming[0] : lanes.indexOf(null);
    if (col < 0) col = lanes.length;
    if (!incoming.length) lanes[col] = c.sha;
    const through = [];
    lanes.forEach((s, i) => { if (s && s !== c.sha) through.push(i); });
    for (const i of incoming) lanes[i] = null; // merged lanes end here
    const outgoing = [];
    const parents = c.parents ?? [];
    parents.forEach((p, k) => {
      let at = lanes.indexOf(p);
      if (at < 0) {
        at = k === 0 ? col : lanes.indexOf(null);
        if (at < 0 || (k > 0 && at === col && lanes[col])) at = lanes.length;
        lanes[at] = p;
      }
      outgoing.push(at);
    });
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    const cols = Math.max(col + 1, ...through.map((x) => x + 1), ...incoming.map((x) => x + 1), ...outgoing.map((x) => x + 1));
    rows.push({ col, through, incoming: incoming.length ? incoming : [], outgoing, cols });
  }
  return rows;
}

/** Group commits by local calendar day -> [{ key:'2025-01-31', time, items:[{commit, index}] }] keeping original order. Pure. */
export function groupByDay(commits) {
  const groups = [];
  commits.forEach((commit, index) => {
    const d = new Date(commit.time);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    let g = groups[groups.length - 1];
    if (!g || g.key !== key) { g = { key, time: commit.time, items: [] }; groups.push(g); }
    g.items.push({ commit, index });
  });
  return groups;
}
