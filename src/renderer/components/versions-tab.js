// Artifacts "Versions" tab: timeline of auto-commits and named versions with a lane graph, compare, restore and a branch handler.
// Simple mode speaks plain language ("ideas", "saved versions"); Developer mode adds branch names, shas and raw git output.
// All git work happens in the main process (src/main/versions.js); this file only renders and calls api.versions.*.
import { h, icon } from '../lib/dom.js';
import { t, getLanguage } from '../lib/i18n.js';
import { activeProject, isDev } from '../lib/store.js';
import { layoutGraph, groupByDay } from '../lib/version-graph.js';
import { openDialog, confirmDialog, toast } from './modal.js';
import { createDiffView } from './diff-view.js';

const ROW_H = 52;
const COL_W = 14;
const SVG_NS = 'http://www.w3.org/2000/svg';
const WORKING = 'WORKING';

const svg = (tag, attrs) => { const n = document.createElementNS(SVG_NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v)); return n; };

/** Subject without the "flowstate:" prefix; empty subjects fall back to the short sha. Pure. */
export function cleanSubject(c) {
  const s = String(c.subject || '').replace(/^flowstate:\s*/i, '').trim();
  return s || c.short;
}

/** Local day heading: Today / Yesterday / long date. Pure (now is injectable). */
export function dayLabel(time, now = Date.now(), lang = 'en') {
  const day = (x) => { const d = new Date(x); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
  const diff = Math.round((day(now) - day(time)) / 86400000);
  if (diff === 0) return t('versions.today');
  if (diff === 1) return t('versions.yesterday');
  try { return new Date(time).toLocaleDateString(lang, { weekday: 'long', day: 'numeric', month: 'long', year: diff > 300 ? 'numeric' : undefined }); } catch { return new Date(time).toDateString(); }
}

const timeOf = (ms, lang) => { try { return new Date(ms).toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };
const filesText = (n) => (n === 0 ? t('versions.filesNone') : n === 1 ? t('versions.file1') : t('versions.files', { count: n }));

export function mountVersionsTab(el, { store, api, actions }) {
  const S = new Map(); // projectId -> view state
  const st = (pid) => {
    if (!S.has(pid)) S.set(pid, { data: null, loading: false, error: null, view: 'timeline', open: null, showAuto: false, cmp: null, notice: null, key: '' });
    return S.get(pid);
  };
  const root = h('div', { class: 'ver' });
  el.append(root);
  const lang = () => getLanguage();

  const proj = () => activeProject(store.get());
  const dev = () => isDev(store.get());

  async function load(pid, force) {
    const s = st(pid);
    if (s.loading) return;
    const gs = store.get().git[pid];
    const key = JSON.stringify([gs && gs.branch, gs && gs.dirty]);
    if (!force && s.data && key === s.key) return;
    s.loading = true; s.key = key;
    paint();
    try { s.data = await api.versions.list(pid, {}); s.error = null; } catch (e) { s.error = (e && e.message) || String(e); }
    s.loading = false;
    paint();
  }
  const reload = (pid) => { actions.refreshGit(); return load(pid, true); };
  const errText = (r) => (r && r.reason === 'invalid-name' ? t('versions.invalidName') : r && r.reason === 'exists' ? t('versions.exists') : r && r.reason === 'not-merged' ? t('versions.notMerged') : (r && r.message) || t('errors.generic'));
  async function run(pid, fn, failKey = 'versions.branchFailed') {
    try {
      const r = await fn();
      if (r && r.ok === false) { toast(t(failKey, { message: errText(r) }), 'error'); return r; }
      return r;
    } catch (e) { toast(t(failKey, { message: (e && e.message) || String(e) }), 'error'); return { ok: false }; }
  }

  // ---------- small builders ----------
  const btn = (label, onClick, { cls = 'btn btn--sm', ic = null, title = null, disabled = false } = {}) =>
    h('button', { class: cls, type: 'button', title: title || undefined, disabled, on: { click: onClick } }, ic ? icon(ic) : null, h('span', { text: label }));
  const badge = (text, cls = 'badge--muted', title) => h('span', { class: 'badge ' + cls, text, title: title || undefined });

  function graphCell(row, c, isHead, withFill) {
    const w = Math.max(row.cols, 1) * COL_W + 8;
    const x = (col) => 10 + col * COL_W;
    const mid = ROW_H / 2;
    const s = svg('svg', { width: w, height: ROW_H, viewBox: `0 0 ${w} ${ROW_H}`, class: 'ver__graph', 'aria-hidden': 'true', focusable: 'false' });
    const line = (d, col) => s.appendChild(svg('path', { d, class: 'ver__lane ver__lane--' + (col % 6), fill: 'none' }));
    for (const col of row.through) line(`M${x(col)} 0V${ROW_H}`, col);
    for (const col of row.incoming) line(col === row.col ? `M${x(col)} 0V${mid}` : `M${x(col)} 0C${x(col)} ${mid * 0.8} ${x(row.col)} ${mid * 0.4} ${x(row.col)} ${mid}`, col);
    for (const col of row.outgoing) line(col === row.col ? `M${x(col)} ${mid}V${ROW_H}` : `M${x(row.col)} ${mid}C${x(row.col)} ${mid + mid * 0.6} ${x(col)} ${mid + mid * 0.2} ${x(col)} ${ROW_H}`, col);
    s.appendChild(svg('circle', { cx: x(row.col), cy: mid, r: c.merge ? 5 : 4.5, class: 'ver__dot ver__lane--' + (row.col % 6) + (c.merge ? ' is-merge' : '') + (isHead ? ' is-head' : '') }));
    const cell = h('div', { class: 'ver__gcell', style: `width:${w}px` }, s);
    if (withFill) {
      const fill = h('div', { class: 'ver__gfill' });
      for (const col of new Set([...row.through, ...row.outgoing])) fill.append(h('span', { class: 'ver__gline ver__lane--bg' + (col % 6), style: `left:${x(col) - 1}px` }));
      cell.append(fill);
    }
    return cell;
  }

  // ---------- timeline ----------
  function commitRow(c, row, d, s) {
    const open = s.open === c.sha;
    const bits = [];
    bits.push(h('span', { class: 'ver__time', text: timeOf(c.time, lang()) }));
    bits.push(h('span', { text: filesText(c.files) + (c.files ? ` (+${c.added} -${c.removed})` : '') }));
    if (c.agent) bits.push(h('span', { text: t('versions.by', { agent: c.agent }) }));
    if (c.methodology) bits.push(badge(t('versions.method', { name: c.methodology }), 'badge--blue'));
    const named = d.tags.filter((x) => c.tags.includes(x.name) && !x.auto);
    const tagBadges = named.map((x) => badge(x.label, 'badge--green', x.name));
    const branchBadges = (dev() ? c.branches : c.branches.filter((b) => b === d.current)).map((b) => badge(b === d.autoBranch && !dev() ? t('versions.autoBadge') : b, 'badge--accent'));
    const isHead = c.head;
    const main = h('button', { class: 'ver__main', type: 'button', attrs: { 'aria-expanded': String(open) }, on: { click: () => { s.open = open ? null : c.sha; paint(); } } },
      h('span', { class: 'ver__subject', text: cleanSubject(c) }),
      h('span', { class: 'ver__badges' }, isHead ? badge(t('versions.here'), 'badge--amber') : null, c.merge ? badge(t('versions.mergeBadge')) : null, ...tagBadges, ...branchBadges),
      h('span', { class: 'ver__meta' }, ...bits));
    const detail = open ? commitDetail(c, d, s) : null;
    return h('li', { class: 'ver__item' + (open ? ' is-open' : '') + (isHead ? ' is-head' : '') },
      graphCell(row, c, isHead, open), h('div', { class: 'ver__body' }, main, detail));
  }

  function commitDetail(c, d) {
    const pid = proj().id;
    const refLabel = cleanSubject(c);
    const box = h('div', { class: 'ver__detail' });
    if (c.prompt) box.append(h('div', { class: 'ver__prompt' }, h('span', { class: 'muted', text: t('versions.prompt') }), h('p', { text: c.prompt })));
    if (dev()) {
      box.append(h('dl', { class: 'ver__kv' },
        h('dt', { text: t('versions.commit') }), h('dd', { class: 'mono', text: c.sha }),
        h('dt', { text: t('versions.msg') }), h('dd', { class: 'mono', text: c.subject }),
        c.parents.length ? h('dt', { text: t('versions.parents') }) : null, c.parents.length ? h('dd', { class: 'mono', text: c.parents.map((p) => p.slice(0, 7)).join(' ') }) : null,
        c.branches.length ? h('dt', { text: t('versions.branchesLabel') }) : null, c.branches.length ? h('dd', { class: 'mono', text: c.branches.join(', ') }) : null,
        c.tags.length ? h('dt', { text: t('versions.tagsLabel') }) : null, c.tags.length ? h('dd', { class: 'mono', text: c.tags.join(', ') }) : null));
    }
    box.append(h('div', { class: 'ver__actions' },
      btn(t('versions.compareNow'), () => openCompare(pid, c.sha, WORKING), { ic: 'code' }),
      btn(t('versions.compareWith'), () => openCompare(pid, c.sha, d.commits.find((x) => x.head)?.sha ?? WORKING), { ic: 'layers' }),
      btn(t('versions.newBranchHere'), () => newBranchDialog(pid, c.sha, refLabel), { ic: 'branch' }),
      btn(t('versions.saveAsVersion'), () => saveDialog(pid, c), { ic: 'flag' }),
      btn(t('versions.restoreAll'), () => restore(pid, c.sha, null, refLabel), { cls: 'btn btn--sm btn--danger', ic: 'undo' })));
    return box;
  }

  function timelineView(d, s) {
    const wrap = h('div', { class: 'ver__timeline' });
    if (d.dirty) {
      wrap.append(h('div', { class: 'ver__now' }, h('span', { class: 'ver__nowdot' }), h('span', { class: 'ver__subject', text: t('versions.now') }),
        btn(t('versions.compareNow'), () => openCompare(proj().id, d.commits.find((x) => x.head)?.sha ?? 'HEAD', WORKING), { ic: 'code' })));
    }
    if (!d.commits.length) return h('div', { class: 'empty-state' }, h('div', { class: 'empty-state__title', text: t('versions.empty') }), h('div', { class: 'empty-state__text', text: t('versions.emptyText') }));
    const rows = layoutGraph(d.commits);
    for (const g of groupByDay(d.commits)) {
      wrap.append(h('h3', { class: 'ver__day', text: dayLabel(g.time, Date.now(), lang()) }));
      wrap.append(h('ol', { class: 'ver__list' }, ...g.items.map(({ commit, index }) => commitRow(commit, rows[index], d, s))));
    }
    return wrap;
  }

  // ---------- named versions ----------
  function versionsView(d, s) {
    const tags = d.tags.filter((x) => s.showAuto || !x.auto);
    const wrap = h('div', { class: 'ver__named' });
    const chk = h('input', { type: 'checkbox', checked: s.showAuto, on: { change: (e) => { s.showAuto = e.target.checked; paint(); } } });
    wrap.append(h('label', { class: 'ver__check' }, chk, h('span', { text: t('versions.autoCheckpoints') })));
    if (!tags.length) { wrap.append(h('div', { class: 'empty-state' }, h('div', { class: 'empty-state__title', text: t('versions.noNamed') }), h('div', { class: 'empty-state__text', text: t('versions.noNamedText') }))); return wrap; }
    const pid = proj().id;
    wrap.append(h('ul', { class: 'ver__tags' }, ...tags.map((x) => h('li', { class: 'ver__tag card' },
      h('div', { class: 'row between' }, h('strong', { class: 'truncate', text: x.auto ? x.label : x.label }), x.auto ? badge(t('versions.safetyBadge')) : badge(t('versions.namedBadge'), 'badge--green')),
      h('div', { class: 'muted ver__meta' }, h('span', { text: `${dayLabel(x.time, Date.now(), lang())} ${timeOf(x.time, lang())}` }), dev() ? h('span', { class: 'mono', text: x.name }) : null),
      x.note ? h('p', { class: 'ver__note', text: x.note }) : null,
      h('div', { class: 'ver__actions' },
        btn(t('versions.compareNow'), () => openCompare(pid, x.name, WORKING), { ic: 'code' }),
        btn(t('versions.compareWith'), () => openCompare(pid, x.name, d.current ?? WORKING), { ic: 'layers' }),
        btn(t('versions.newBranchHere'), () => newBranchDialog(pid, x.name, x.label), { ic: 'branch' }),
        btn(t('versions.restoreAll'), () => restore(pid, x.name, null, x.label), { cls: 'btn btn--sm btn--danger', ic: 'undo' }))))));
    return wrap;
  }

  // ---------- branches ----------
  function branchesView(d) {
    const pid = proj().id;
    const wrap = h('div', { class: 'ver__branches' });
    wrap.append(h('p', { class: 'muted', text: t('versions.ideaHint') }),
      btn(t(dev() ? 'versions.tryIdeaDev' : 'versions.tryIdea'), () => newBranchDialog(pid, null, t('versions.nowLabel')), { cls: 'btn btn--primary btn--sm', ic: 'plus' }));
    wrap.append(h('ul', { class: 'ver__blist' }, ...d.branches.map((b) => {
      const label = b.auto && !dev() ? t('versions.autoBadge') : b.name;
      const sync = b.current ? null : [b.ahead ? t(dev() ? 'versions.aheadDev' : 'versions.ahead', { count: b.ahead }) : null, b.behind ? t('versions.behind', { count: b.behind }) : null].filter(Boolean).join(', ') || t('versions.upToDate');
      return h('li', { class: 'ver__branch card' + (b.current ? ' is-current' : '') },
        h('div', { class: 'row between' },
          h('strong', { class: 'truncate' + (dev() ? ' mono' : ''), text: label }),
          h('span', { class: 'row' }, b.current ? badge(t('versions.current'), 'badge--amber') : null, b.merged ? badge(t('versions.mergedBadge'), 'badge--green') : null)),
        h('div', { class: 'muted ver__meta' }, sync ? h('span', { text: sync }) : null,
          h('span', { text: `${t('versions.last')}: ${cleanSubject({ subject: b.subject, short: b.short })} - ${dayLabel(b.time, Date.now(), lang())}` })),
        h('div', { class: 'ver__actions' },
          b.current ? null : btn(t('versions.switch'), () => switchBranch(pid, b), { ic: 'branch' }),
          b.current ? null : btn(t('versions.merge'), () => mergeDialog(pid, b, d), { ic: 'layers' }),
          b.auto ? null : btn(t('versions.rename'), () => renameDialog(pid, b), { ic: 'edit' }),
          b.current ? null : btn(t('versions.del'), () => deleteBranch(pid, b), { cls: 'btn btn--sm btn--danger', ic: 'trash', disabled: !b.merged, title: b.merged ? undefined : t('versions.notMerged') })));
    })));
    return wrap;
  }

  // ---------- operations ----------
  function field(labelText, input) { const id = 'ver-f-' + Math.random().toString(36).slice(2, 8); input.id = id; return h('div', { class: 'field' }, h('label', { for: id, text: labelText }), input); }

  function saveDialog(pid, commit) {
    const label = h('input', { class: 'input', type: 'text', maxLength: 80, placeholder: t('versions.labelPh') });
    const note = h('textarea', { class: 'textarea', rows: 3, maxLength: 2000, placeholder: t('versions.notePh') });
    const ok = h('button', { class: 'btn btn--primary', type: 'button', text: t('versions.save') });
    const cancel = h('button', { class: 'btn', type: 'button', text: t('common.cancel') });
    const dlg = openDialog({ title: t('versions.saveTitle'), body: [h('p', { class: 'muted', text: t('versions.saveHint') }), field(t('versions.label'), label), field(t('versions.note'), note)], footer: [cancel, ok] });
    cancel.addEventListener('click', () => dlg.close('cancel'));
    const go = async () => {
      if (!label.value.trim()) { label.focus(); return; }
      ok.disabled = true;
      const r = await run(pid, () => api.versions.save(pid, { label: label.value.trim(), note: note.value, ...(commit ? { ref: commit.sha } : {}) }), 'versions.saveFailed');
      if (r && r.ok) { dlg.close('ok'); toast(t('versions.saved', { label: label.value.trim() }), 'success'); reload(pid); } else ok.disabled = false;
    };
    ok.addEventListener('click', go);
    label.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  }

  async function restore(pid, ref, file, refLabel) {
    const yes = await confirmDialog({
      title: t('versions.restoreTitle'), danger: true, confirmLabel: t('versions.restoreBtn'),
      message: file ? t('versions.restoreFileConfirm', { path: file, ref: refLabel }) : t('versions.restoreConfirm', { ref: refLabel }),
    });
    if (!yes) return;
    const r = await run(pid, () => api.versions.restore(pid, file ? { ref, path: file } : { ref }), 'versions.restoreFailed');
    if (r && r.ok) {
      const s = st(pid);
      s.notice = { kind: 'undo', text: t('versions.restored'), safety: r.safety };
      s.cmp = null; if (s.view === 'compare') s.view = 'timeline';
      reload(pid);
    }
  }
  async function undoRestore(pid, safety) {
    const r = await run(pid, () => api.versions.restore(pid, { ref: safety }), 'versions.restoreFailed');
    if (r && r.ok) { st(pid).notice = { kind: 'info', text: t('versions.undone') }; reload(pid); }
  }

  function newBranchDialog(pid, from, fromLabel) {
    const name = h('input', { class: 'input mono', type: 'text', maxLength: 100, placeholder: t('versions.ideaNamePh') });
    const err = h('div', { class: 'ver__err', attrs: { role: 'alert' } });
    const ok = h('button', { class: 'btn btn--primary', type: 'button', text: t('versions.tryIdeaDev') });
    const cancel = h('button', { class: 'btn', type: 'button', text: t('common.cancel') });
    const dlg = openDialog({ title: t(dev() ? 'versions.tryIdeaDev' : 'versions.tryIdea'), body: [h('p', { class: 'muted', text: t('versions.ideaHint') }), field(t('versions.ideaName'), name), h('p', { class: 'muted', text: `${t('versions.ideaFrom')}: ${fromLabel}` }), err], footer: [cancel, ok] });
    cancel.addEventListener('click', () => dlg.close('cancel'));
    const go = async () => {
      err.textContent = '';
      const nm = name.value.trim();
      if (!nm) { name.focus(); return; }
      ok.disabled = true;
      let r;
      try { r = await api.versions.branch(pid, { op: 'create', name: nm, ...(from ? { from } : {}) }); } catch (e) { r = { ok: false, message: (e && e.message) || '' }; }
      if (r && r.ok) { dlg.close('ok'); toast(t('versions.ideaCreated', { name: nm }), 'success'); st(pid).view = 'branches'; reload(pid); }
      else { err.textContent = errText(r); ok.disabled = false; name.focus(); }
    };
    ok.addEventListener('click', go);
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  }

  async function switchBranch(pid, b) {
    const r = await run(pid, () => api.versions.branch(pid, { op: 'switch', name: b.name }));
    if (r && r.ok) { toast(t(r.safety ? 'versions.switchedSaved' : 'versions.switched', { name: b.name }), 'success'); reload(pid); }
  }
  function renameDialog(pid, b) {
    const name = h('input', { class: 'input mono', type: 'text', maxLength: 100, value: b.name });
    const err = h('div', { class: 'ver__err', attrs: { role: 'alert' } });
    const ok = h('button', { class: 'btn btn--primary', type: 'button', text: t('versions.rename') });
    const cancel = h('button', { class: 'btn', type: 'button', text: t('common.cancel') });
    const dlg = openDialog({ title: t('versions.renameTitle'), body: [field(t('versions.ideaName'), name), err], footer: [cancel, ok] });
    cancel.addEventListener('click', () => dlg.close('cancel'));
    const go = async () => {
      const nm = name.value.trim();
      if (!nm || nm === b.name) { dlg.close('cancel'); return; }
      let r;
      try { r = await api.versions.branch(pid, { op: 'rename', name: b.name, to: nm }); } catch (e) { r = { ok: false, message: (e && e.message) || '' }; }
      if (r && r.ok) { dlg.close('ok'); toast(t('versions.renamed', { name: nm }), 'success'); reload(pid); } else err.textContent = errText(r);
    };
    ok.addEventListener('click', go);
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  }
  async function deleteBranch(pid, b) {
    const yes = await confirmDialog({ title: t('versions.del'), message: t('versions.deleteConfirm', { name: b.name }), confirmLabel: t('versions.deleteBtn'), danger: true });
    if (!yes) return;
    const r = await run(pid, () => api.versions.branch(pid, { op: 'delete', name: b.name }));
    if (r && r.ok) { toast(t('versions.deleted', { name: b.name }), 'success'); reload(pid); }
  }

  function mergeDialog(pid, b, d) {
    const into = d.current;
    const body = h('div', { class: 'ver__merge' }, h('div', { class: 'row muted' }, h('span', { class: 'spinner' }), t('versions.mergePreviewing')));
    const go = h('button', { class: 'btn btn--primary', type: 'button', text: t('versions.mergeBtn'), disabled: true });
    const cancel = h('button', { class: 'btn', type: 'button', text: t('common.cancel') });
    const dlg = openDialog({ title: t('versions.mergeTitle', { from: b.name, into }), body, footer: [cancel, go] });
    cancel.addEventListener('click', () => dlg.close('cancel'));
    api.versions.branch(pid, { op: 'previewMerge', name: b.name }).then((p) => {
      body.replaceChildren();
      if (!p || p.ok === false) { body.append(h('p', { class: 'ver__err', text: errText(p) })); return; }
      if (p.upToDate) { body.append(h('p', { text: t('versions.mergeUpToDate', { from: b.name, into }) })); return; }
      body.append(h('p', { text: t('versions.mergeSummary', { count: p.files.length, added: p.added, removed: p.removed, from: b.name, into }) }));
      if (p.fastForward) body.append(h('p', { class: 'muted', text: t('versions.mergeFast') }));
      body.append(h('ul', { class: 'ver__files' }, ...p.files.slice(0, 40).map((f) => h('li', {}, h('span', { class: 'ver__st ver__st--' + f.status, text: t('versions.status' + (['M', 'A', 'D', 'R'].includes(f.status) ? f.status : 'M')) }), h('span', { class: 'truncate mono', text: f.path })))));
      if (p.conflicts.length) {
        body.append(h('p', { class: 'ver__err', text: t('versions.mergeConflicts', { count: p.conflicts.length }) }));
        if (dev()) body.append(h('div', {}, h('strong', { text: t('versions.conflictList') }), h('ul', { class: 'ver__files' }, ...p.conflicts.map((f) => h('li', { class: 'mono', text: f })))));
      } else body.append(h('p', { class: 'ver__ok', text: p.predicted === false ? t('versions.mergeNoPredict') : t('versions.mergeClean') }));
      go.disabled = p.conflicts.length > 0 && !dev();
    }).catch((e) => body.append(h('p', { class: 'ver__err', text: (e && e.message) || '' })));
    go.addEventListener('click', async () => {
      go.disabled = true;
      let r;
      try { r = await api.versions.branch(pid, { op: 'merge', name: b.name }); } catch (e) { r = { ok: false, message: (e && e.message) || '' }; }
      dlg.close('done');
      const s = st(pid);
      if (r && r.ok) { toast(t('versions.merged', { from: b.name, into }), 'success'); s.view = 'timeline'; }
      else if (r && r.reason === 'conflict') s.notice = { kind: 'error', text: t('versions.mergeAborted', { files: (r.conflicts || []).join(', ') || '-' }), files: r.conflicts || [], raw: r.raw };
      else toast(t('versions.branchFailed', { message: errText(r) }), 'error');
      reload(pid);
    });
  }

  // ---------- compare ----------
  function refOptions(d) {
    const opts = [{ v: WORKING, l: t('versions.nowLabel') }];
    for (const x of d.tags.filter((y) => !y.auto)) opts.push({ v: x.name, l: x.label });
    for (const b of d.branches) opts.push({ v: b.name, l: (b.auto && !dev() ? t('versions.autoBadge') : b.name) });
    for (const c of d.commits.slice(0, 60)) opts.push({ v: c.sha, l: `${c.short} ${cleanSubject(c)}`.slice(0, 70) });
    return opts;
  }
  async function openCompare(pid, from, to) {
    const s = st(pid);
    s.view = 'compare';
    s.cmp = { from, to, files: null, sel: null, diff: null, error: null };
    paint();
    await loadCompare(pid);
  }
  async function loadCompare(pid) {
    const s = st(pid); const c = s.cmp; if (!c) return;
    c.files = null; c.sel = null; c.diff = null; c.error = null; paint();
    // compare(from, to): when "to" is the working state the API takes WORKING; when "from" is WORKING swap so the older side stays "from"
    const [a, b] = c.from === WORKING ? [c.to, c.from] : [c.from, c.to];
    try {
      const r = await api.versions.compare(pid, { from: a, to: b });
      if (!r || r.ok === false) c.error = errText(r); else c.files = r.files;
    } catch (e) { c.error = (e && e.message) || String(e); }
    paint();
  }
  async function pickFile(pid, f) {
    const c = st(pid).cmp; if (!c) return;
    c.sel = f.path; c.diff = null; paint();
    const [a, b] = c.from === WORKING ? [c.to, c.from] : [c.from, c.to];
    try { const r = await api.versions.compare(pid, { from: a, to: b, path: f.path }); c.diff = r && r.ok !== false ? r.diff || '' : null; if (c.diff === null) c.error = errText(r); } catch (e) { c.error = (e && e.message) || ''; }
    paint();
  }
  function compareView(d, s) {
    const pid = proj().id; const c = s.cmp;
    const opts = refOptions(d);
    const sel = (value, onChange, label) => {
      const known = opts.some((o) => o.v === value);
      const sl = h('select', { class: 'select select--sm', on: { change: (e) => onChange(e.target.value) } },
        ...(known ? [] : [h('option', { value, text: value.slice(0, 7) })]), ...opts.map((o) => h('option', { value: o.v, text: o.l, selected: o.v === value })));
      return h('label', { class: 'ver__sel' }, h('span', { class: 'muted', text: label }), sl);
    };
    const wrap = h('div', { class: 'ver__compare' });
    wrap.append(h('div', { class: 'row ver__cmphead' },
      btn(t('versions.back'), () => { s.view = 'timeline'; s.cmp = null; paint(); }, { cls: 'btn btn--ghost btn--sm', ic: 'undo' }),
      sel(c.from, (v) => { c.from = v; loadCompare(pid); }, t('versions.from')),
      btn(t('versions.swap'), () => { [c.from, c.to] = [c.to, c.from]; loadCompare(pid); }, { cls: 'btn btn--ghost btn--sm', ic: 'refresh' }),
      sel(c.to, (v) => { c.to = v; loadCompare(pid); }, t('versions.to'))));
    if (c.error) wrap.append(h('p', { class: 'ver__err', text: c.error }));
    if (!c.files && !c.error) { wrap.append(h('div', { class: 'muted row' }, h('span', { class: 'spinner' }), t('versions.loading'))); return wrap; }
    if (c.files) {
      const older = c.from === WORKING ? c.to : c.from;
      const olderLabel = (opts.find((o) => o.v === older) || { l: String(older).slice(0, 7) }).l;
      wrap.append(h('div', { class: 'row between' },
        h('strong', { text: c.files.length ? (c.files.length === 1 ? t('versions.changedOne') : t('versions.changedFiles', { count: c.files.length })) : t('versions.noChanges') }),
        older !== WORKING ? btn(t('versions.restoreAll'), () => restore(pid, older, null, olderLabel), { cls: 'btn btn--sm btn--danger', ic: 'undo' }) : null));
      wrap.append(h('ul', { class: 'ver__files ver__files--pick' }, ...c.files.map((f) => h('li', {},
        h('button', { class: 'ver__file' + (c.sel === f.path ? ' is-selected' : ''), type: 'button', on: { click: () => pickFile(pid, f) } },
          h('span', { class: 'ver__st ver__st--' + f.status, text: t('versions.status' + (['M', 'A', 'D', 'R'].includes(f.status) ? f.status : 'M')) }),
          h('span', { class: 'truncate mono ver__fpath', text: f.path }),
          h('span', { class: 'ver__pm' }, h('span', { class: 'ver__add', text: '+' + f.added }), ' ', h('span', { class: 'ver__del', text: '-' + f.removed })))))));
      if (c.sel) {
        const box = h('div', { class: 'ver__diff' });
        if (c.diff === null) box.append(h('div', { class: 'muted row' }, h('span', { class: 'spinner' }), t('versions.loading')));
        else {
          if (older !== WORKING) box.append(h('div', { class: 'ver__actions' }, btn(t('versions.restoreFile'), () => restore(pid, older, c.sel, olderLabel), { cls: 'btn btn--sm btn--danger', ic: 'undo' })));
          box.append(createDiffView({ diff: c.diff, path: c.sel }).el);
        }
        wrap.append(box);
      } else if (c.files.length) wrap.append(h('p', { class: 'muted', text: t('versions.pickFile') }));
    }
    return wrap;
  }

  // ---------- shell ----------
  const VIEWS = ['timeline', 'versions', 'branches'];
  function paint() {
    const p = proj();
    root.replaceChildren();
    if (!p) { root.append(h('div', { class: 'empty-state' }, h('div', { class: 'empty-state__title', text: t('files.noProject') }))); return; }
    const s = st(p.id); const d = s.data;
    const refreshBtn = h('button', { class: 'btn btn--ghost btn--sm', type: 'button', on: { click: () => reload(p.id) } }, icon('refresh'), t('versions.refresh'));
    const saveBtn = btn(t('versions.save'), () => saveDialog(p.id, null), { cls: 'btn btn--primary btn--sm', ic: 'flag', disabled: !(d && d.isRepo) });
    root.append(h('div', { class: 'ver__head row between' }, h('strong', { text: t('versions.title') }), h('span', { class: 'row' }, saveBtn, refreshBtn)));
    if (s.notice) {
      const n = s.notice;
      root.append(h('div', { class: 'ver__notice ver__notice--' + n.kind, attrs: { role: n.kind === 'error' ? 'alert' : 'status' } },
        h('span', { text: n.text }),
        n.kind === 'undo' ? btn(t('versions.undo'), () => { s.notice = null; undoRestore(p.id, n.safety); }, { ic: 'undo' }) : null,
        n.kind === 'error' && dev() && n.raw ? h('pre', { class: 'ver__raw', text: n.raw }) : null,
        h('button', { class: 'btn btn--ghost btn--icon btn--sm', type: 'button', attrs: { 'aria-label': t('common.close') }, on: { click: () => { s.notice = null; paint(); } } }, icon('x'))));
    }
    if (!d) {
      root.append(s.error ? h('p', { class: 'ver__err', text: t('versions.failed', { message: s.error }) }) : h('div', { class: 'muted row' }, h('span', { class: 'spinner' }), t('versions.loading')));
      return;
    }
    if (!d.isRepo) { root.append(h('div', { class: 'muted', text: t(dev() ? 'versions.notRepoDev' : 'versions.notRepo') })); return; }
    root.append(h('div', { class: 'ver__status card' },
      h('div', { class: 'row between' },
        h('span', { class: 'strong' + (dev() ? ' mono' : ''), text: t(dev() ? 'versions.onBranchDev' : 'versions.onBranch', { name: d.current ? (d.current === d.autoBranch && !dev() ? t('versions.autoBadge') : d.current) : '-' }) }),
        badge(d.dirty ? (d.dirty === 1 ? t('versions.unsavedOne') : t('versions.unsaved', { count: d.dirty })) : t('versions.allSaved'), d.dirty ? 'badge--amber' : 'badge--green')),
      h('p', { class: 'muted ver__autowhere', text: dev() ? t('versions.autoWhereDev', { name: d.autoBranch }) : t('versions.autoWhere', { name: t('versions.autoBadge') }) })));
    if (s.view !== 'compare') {
      const tabs = h('div', { class: 'pill-tabs ver__tabs', attrs: { role: 'tablist' } }, ...VIEWS.map((v) => h('button', {
        class: 'pill-tab' + (s.view === v ? ' is-active' : ''), type: 'button', id: 'ver-tab-' + v, attrs: { role: 'tab', 'aria-selected': String(s.view === v), tabindex: s.view === v ? '0' : '-1' },
        on: { click: () => { s.view = v; paint(); } },
      }, t(v === 'timeline' ? 'versions.tabTimeline' : v === 'versions' ? 'versions.tabVersions' : (dev() ? 'versions.tabBranchesDev' : 'versions.tabBranches')))));
      tabs.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        s.view = VIEWS[(VIEWS.indexOf(s.view) + (e.key === 'ArrowRight' ? 1 : VIEWS.length - 1)) % VIEWS.length];
        paint();
        const a = root.querySelector('[role="tab"][aria-selected="true"]'); if (a) a.focus();
      });
      root.append(tabs);
    }
    const scroller = h('div', { class: 'ver__scroll', attrs: { role: 'tabpanel' } },
      s.view === 'compare' && s.cmp ? compareView(d, s) : s.view === 'versions' ? versionsView(d, s) : s.view === 'branches' ? branchesView(d) : timelineView(d, s));
    root.append(scroller);
  }

  return {
    /** Called by the Artifacts pane whenever the Versions tab is visible and project/git state may have changed. */
    render() {
      const p = proj();
      if (p) load(p.id, false);
      paint();
    },
    update() { paint(); },
    /** Open the panel on a given sub-view ('timeline' | 'versions' | 'branches'). */
    show(view) { const p = proj(); if (p && VIEWS.includes(view)) { st(p.id).view = view; paint(); } },
    refresh() { const p = proj(); if (p) load(p.id, true); },
  };
}
