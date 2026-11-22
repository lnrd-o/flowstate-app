// Mock for window.flowstate.versions (plain-browser preview): a small fake project history with a side branch.
export function mockVersions() {
  const H = 3600 * 1000;
  const t0 = Date.now();
  const c = (sha, parents, ago, subject, extra = {}) => ({ sha: sha.padEnd(40, '0'), short: sha, parents: parents.map((p) => p.padEnd(40, '0')), time: t0 - ago * H, subject, files: 2, added: 14, removed: 3, branches: [], tags: [], head: false, auto: subject.startsWith('flowstate:'), merge: parents.length > 1, ...extra });
  const commits = [
    c('a7e1c02', ['9f3b8d1'], 0.4, 'flowstate: add a chart to the dashboard', { head: true, branches: ['claude/auto'], agent: 'claude', prompt: 'Add a chart to the dashboard that shows sales per month' }),
    c('9f3b8d1', ['6d20e4b', '41c9a77'], 5, 'flowstate: merged idea into claude/auto', { merge: true, files: 3, added: 40, removed: 2 }),
    c('41c9a77', ['6d20e4b'], 7, 'flowstate: try a darker theme', { branches: ['idea'], agent: 'agy', methodology: 'design-review' }),
    c('6d20e4b', ['2b8a110'], 27, 'flowstate: fix the totals', { agent: 'claude', prompt: 'The totals are wrong, please fix them', tags: ['checkpoint/first-draft'] }),
    c('2b8a110', [], 51, 'flowstate: initial snapshot', { files: 0, added: 0, removed: 0, branches: ['main'] }),
  ];
  const ok = async () => ({ ok: true });
  return {
    list: async () => ({
      isRepo: true, current: 'claude/auto', autoBranch: 'claude/auto', dirty: 2, commits,
      branches: [
        { name: 'claude/auto', sha: 'a7e1c02', short: 'a7e1c02', time: commits[0].time, subject: commits[0].subject, current: true, ahead: 0, behind: 0, merged: false, auto: true },
        { name: 'idea', sha: '41c9a77', short: '41c9a77', time: commits[2].time, subject: commits[2].subject, current: false, ahead: 0, behind: 2, merged: true, auto: false },
        { name: 'main', sha: '2b8a110', short: '2b8a110', time: commits[4].time, subject: commits[4].subject, current: false, ahead: 0, behind: 4, merged: true, auto: false },
      ],
      tags: [{ name: 'checkpoint/first-draft', sha: '6d20e4b'.padEnd(40, '0'), time: commits[3].time, label: 'First draft', note: 'Before the dark theme', auto: false }],
    }),
    save: async (_id, o) => ({ ok: true, tag: 'checkpoint/' + String(o.label).toLowerCase().replace(/\W+/g, '-') }),
    compare: async (_id, o) => (o.path
      ? { ok: true, diff: '--- a/' + o.path + '\n+++ b/' + o.path + '\n@@ -1,2 +1,2 @@\n line\n-old\n+new\n' }
      : { ok: true, files: [{ path: 'src/app.js', status: 'M', added: 12, removed: 3 }, { path: 'notes.md', status: 'A', added: 4, removed: 0 }], added: 16, removed: 3 }),
    restore: async () => ({ ok: true, safety: 'checkpoint/auto-20250101-120000z' }),
    branch: async (_id, o) => (o.op === 'previewMerge'
      ? { ok: true, upToDate: false, fastForward: false, predicted: true, conflicts: [], files: [{ path: 'src/app.js', status: 'M', added: 12, removed: 3 }], added: 12, removed: 3, into: 'claude/auto', from: o.name }
      : ok()),
  };
}
