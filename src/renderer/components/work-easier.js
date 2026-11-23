// "Work easier" features (renderer):
//  - after-turn bar: what changed + Undo, Export (PDF / Word / PowerPoint), Save as recipe, Compare spreadsheets
//  - plan card: "Plan first" turns end with an editable checklist -> Run plan
//  - quick ask (Ctrl+Space, or Ctrl+Shift+Space from anywhere in Windows): one line, sent to the active conversation
//  - drop a file anywhere -> "What should FlowState do with it?"
//  - ask about a file (Files tab / file viewer)
//  - spreadsheet before/after compare dialog
//  - scheduled tasks dialog
//  - update-ready banner
import { h, icon } from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import { activeProject } from '../lib/store.js';
import { turnMessages, turnStats } from '../lib/activity.js';
import { renderMarkdown } from '../lib/markdown.js';
import { openDialog, toast, confirmDialog } from './modal.js';

const SHEET_RE = /\.(xlsx|xlsm|csv|tsv)$/i;
const DATA_RE = /\.(xlsx|xlsm|xls|csv|tsv|json)$/i;
const DOC_RE = /\.(pdf|docx|txt|md|html?)$/i;
const SLIDES_RE = /\.pptx$/i;
const IMAGE_RE = /\.(png|jpe?g|gif|webp)$/i;

// ---------- pure helpers (unit-tested) ----------

/** Checklist steps from a plan answer: bullet / numbered / task-list lines, without markdown emphasis. Max 30. */
export function parsePlanSteps(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^\s{0,6}(?:[-*+]|\d{1,3}[.)])\s+(?:\[[ xX]\]\s+)?(.+?)\s*$/.exec(line);
    if (!m) continue;
    const s = m[1].replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').trim();
    if (s) out.push(s.slice(0, 500));
    if (out.length >= 30) break;
  }
  return out;
}

/** Prompt that runs an approved plan. */
export function runPlanPrompt(steps) {
  return `Carry out this approved plan step by step, in this order. Do not skip steps; say briefly when each one is done:\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`;
}

/** What a dropped / chosen file can be used for: [{id, prompt(rel)}]. */
export function fileActions(rel) {
  const name = String(rel);
  const acts = [];
  if (DATA_RE.test(name)) {
    acts.push({ id: 'analyze', prompt: (r) => `Analyze the data file ${r}: profile it (rows, columns, types, missing values, odd values), find the key insights, make 2 to 4 clear charts in the outputs folder and write a short report with the findings.` });
    acts.push({ id: 'clean', prompt: (r) => `Clean and summarize ${r}: work on a copy (never change the original), fix spaces, dates, numbers and duplicates, then save a clean version and a summary sheet in the outputs folder and list what you changed.` });
    acts.push({ id: 'dashboard', prompt: (r) => `Build a dashboard from ${r}: one self-contained HTML file in the outputs folder with KPI cards, 3 to 5 charts and filters, working offline.` });
  }
  if (DOC_RE.test(name)) {
    acts.push({ id: 'summarize', prompt: (r) => `Summarize ${r}: the main points in plain language, key numbers and dates, and any action items. Save the summary as a Markdown file in the outputs folder.` });
    acts.push({ id: 'extract', prompt: (r) => `Extract the important data from ${r} (tables, amounts, dates, names) into a tidy spreadsheet in the outputs folder.` });
  }
  if (SLIDES_RE.test(name)) {
    acts.push({ id: 'summarize', prompt: (r) => `Summarize the presentation ${r} slide by slide and list its key messages. Save it as Markdown in the outputs folder.` });
    acts.push({ id: 'improve', prompt: (r) => `Review the presentation ${r}: suggest clearer titles, tighter text and a better order, and create an improved copy in the outputs folder.` });
  }
  if (IMAGE_RE.test(name)) acts.push({ id: 'describe', prompt: (r) => `Look at the image ${r} and describe what it shows. If it contains a table or numbers, transcribe them into a spreadsheet in the outputs folder.` });
  acts.push({ id: 'explain', prompt: (r) => `Explain what ${r} contains and how it could be used in this project.` });
  return acts;
}

/** Ask-about-this-file prompts. */
export function askPrompt(kind, rel) {
  const P = {
    explain: `Explain ${rel} in plain language: what it is, what it contains and anything important to know.`,
    errors: `Check ${rel} for errors and problems (wrong formulas or numbers, inconsistencies, typos, broken references) and list them with where they are and how to fix them. Do not change the file.`,
    chart: `Make clear charts from the data in ${rel} and save them in the outputs folder. Pick the chart types that fit the data.`,
    summarize: `Summarize ${rel}: the key points, numbers and conclusions.`,
  };
  return P[kind] || P.explain;
}

/** Plain HTML of a markdown answer, for the PDF export. */
export function answerHtml(text) {
  const d = document.createElement('div');
  d.append(renderMarkdown(String(text ?? '')));
  return d.innerHTML;
}

/** Last finished turn of a chat: {turnId, text, userText, stats} or null. */
export function lastTurn(chat, root) {
  if (!chat || chat.running || !chat.turn || !chat.turn.id || !chat.turn.endedAt) return null;
  const turnId = chat.turn.id;
  const msgs = turnMessages(chat.messages || [], turnId);
  const answers = msgs.filter((m) => m.role === 'assistant' && m.text);
  const user = (chat.messages || []).find((m) => m.role === 'user' && m.turn === turnId);
  return { turnId, text: answers.length ? answers[answers.length - 1].text : '', userText: user ? user.text : '', stats: turnStats(msgs, root) };
}

// ---------- after-turn bar + plan card ----------

export function mountAfterTurnBar(host, { store, api, actions }) {
  const dismissed = new Set();
  let sig = '';
  host.className = 'after-turn';

  function exportReport(p, info, kind) {
    if (kind === 'pdf') {
      const title = (info.userText || p.name).split(/\r?\n/)[0].slice(0, 60);
      return api.workflow.exportPdf(p.id, { html: answerHtml(info.text || ''), title })
        .then((r) => { toast(t('work.exported', { file: r.rel }), 'success', 6000); actions.openFile(r.rel); })
        .catch(() => toast(t('errors.generic'), 'error'));
    }
    const what = kind === 'word'
      ? 'a Word document (.docx) using python-docx: title, short summary, sections, and any tables or charts already produced'
      : 'a PowerPoint presentation (.pptx) using python-pptx: 6 to 10 slides with a title slide, key points, and any charts already produced';
    return actions.send(`Turn the result of your previous answer into ${what}. Save it in the project's outputs folder with a clear file name, then tell me the path.`);
  }

  function planCard(p, info) {
    const steps = parsePlanSteps(info.text);
    const items = steps.map((s) => ({ on: true, text: s }));
    const list = h('ol', { class: 'plan-card__list' });
    const paint = () => list.replaceChildren(...items.map((it, i) => {
      const cb = h('input', { type: 'checkbox', checked: it.on, attrs: { 'aria-label': t('work.plan.include', { n: i + 1 }) } });
      cb.addEventListener('change', () => { it.on = cb.checked; });
      const inp = h('input', { class: 'input input--sm plan-card__step', type: 'text', value: it.text, attrs: { 'aria-label': t('work.plan.step', { n: i + 1 }) } });
      inp.addEventListener('input', () => { it.text = inp.value; });
      return h('li', { class: 'plan-card__item' }, cb, inp);
    }));
    paint();
    const run = h('button', { class: 'btn btn--primary btn--sm', type: 'button', text: t('work.plan.run'), on: { click: () => {
      const chosen = items.filter((x) => x.on && x.text.trim()).map((x) => x.text.trim());
      actions.clearPlan(p.id);
      actions.send(chosen.length ? runPlanPrompt(chosen) : 'Go ahead and carry out the plan you just proposed.');
    } } });
    const add = h('button', { class: 'btn btn--ghost btn--sm', type: 'button', text: t('work.plan.addStep'), on: { click: () => { items.push({ on: true, text: '' }); paint(); } } });
    return h('div', { class: 'plan-card', attrs: { role: 'group', 'aria-label': t('work.plan.title') } },
      h('div', { class: 'plan-card__head' }, icon('list'), h('strong', { text: t('work.plan.title') }), h('span', { class: 'small muted', text: steps.length ? t('work.plan.hint') : t('work.plan.noSteps') })),
      steps.length ? list : null,
      h('div', { class: 'plan-card__actions' }, run, steps.length ? add : null,
        h('button', { class: 'btn btn--ghost btn--sm', type: 'button', text: t('work.plan.discard'), on: { click: () => actions.clearPlan(p.id) } })));
  }

  function render() {
    const s = store.get();
    const p = activeProject(s);
    const chat = p && s.chats[p.id];
    const info = p && lastTurn(chat, p.path);
    const plan = p && s.plans && s.plans[p.id];
    const key = p && info ? `${p.id}:${info.turnId}` : '';
    const isPlan = !!(plan && info && plan.turnId === info.turnId);
    const nextSig = JSON.stringify([key, isPlan, dismissed.has(key), info && info.stats, p && p.autoCommit, s.settings && s.settings.language, info && info.text.length]);
    if (nextSig === sig) return;
    sig = nextSig;
    if (!info || s.view !== 'project' || (dismissed.has(key) && !isPlan)) { host.hidden = true; host.replaceChildren(); return; }
    host.hidden = false;
    if (isPlan) { host.replaceChildren(planCard(p, info)); return; }
    const st = info.stats;
    const bits = [];
    if (st.files.length) bits.push(t(st.files.length === 1 ? 'work.bar.fileOne' : 'work.bar.files', { n: st.files.length }));
    if (st.commands) bits.push(t(st.commands === 1 ? 'work.bar.commandOne' : 'work.bar.commands', { n: st.commands }));
    const sheets = st.files.filter((f) => SHEET_RE.test(f.path) && f.op !== 'delete').slice(0, 3);
    const btn = (label, ic, on, cls = '') => h('button', { class: 'btn btn--ghost btn--sm ' + cls, type: 'button', on: { click: on } }, ic ? icon(ic) : null, label);
    host.replaceChildren(
      h('div', { class: 'after-turn__line' }, icon('check', 'after-turn__ok'),
        h('span', { class: 'small', text: bits.length ? t('work.bar.done', { what: bits.join(', ') }) : t('work.bar.doneText') })),
      h('div', { class: 'after-turn__actions' },
        p.autoCommit && st.files.length ? btn(t('work.bar.undo'), 'undo', async () => {
          if (await confirmDialog({ title: t('work.bar.undo'), message: t('work.bar.undoConfirm'), confirmLabel: t('work.bar.undo'), danger: true })) actions.undoTurn();
        }) : null,
        ...sheets.map((f) => btn(t('work.bar.compare', { file: f.path.split('/').pop() }), 'table', () => openSheetCompare({ api, projectId: p.id, rel: f.path }))),
        h('span', { class: 'after-turn__group' }, h('span', { class: 'xs faint', text: t('work.bar.export') }),
          btn('PDF', 'file', () => exportReport(p, info, 'pdf')),
          btn('Word', 'file', () => exportReport(p, info, 'word')),
          btn('PowerPoint', 'file', () => exportReport(p, info, 'pptx'))),
        btn(t('work.bar.recipe'), 'sparkles', () => actions.recordMethod()),
        h('button', { class: 'btn btn--ghost btn--icon btn--sm', type: 'button', title: t('common.close'), attrs: { 'aria-label': t('common.close') }, on: { click: () => { dismissed.add(key); sig = ''; render(); } } }, icon('x'))));
  }

  store.subscribe(render);
  render();
  return { render };
}

// ---------- spreadsheet compare ----------

export async function openSheetCompare({ api, projectId, rel }) {
  const body = h('div', { class: 'sheet-cmp' }, h('div', { class: 'row muted' }, h('span', { class: 'spinner' }), t('work.cmp.loading')));
  const close = h('button', { class: 'btn btn--primary', type: 'button', text: t('common.close') });
  const dlg = openDialog({ title: t('work.cmp.title', { file: rel.split('/').pop() }), body, footer: [close], size: 'lg', isDirty: () => false });
  close.addEventListener('click', () => dlg.close('done'));
  let r;
  try { r = await api.workflow.compareSheet(projectId, rel); } catch (e) { r = { ok: false, reason: 'error', message: e && e.message }; }
  if (!r || !r.ok) { body.replaceChildren(h('p', { class: 'muted', text: t('work.cmp.err.' + ((r && r.reason) || 'error')) })); return; }
  const changed = r.sheets.filter((s) => s.status !== 'same');
  let cur = (changed[0] || r.sheets[0] || {}).name;
  const tabs = h('div', { class: 'pill-tabs sheet-cmp__tabs', attrs: { role: 'tablist' } });
  const view = h('div', { class: 'sheet-cmp__view' });
  const paint = () => {
    tabs.replaceChildren(...r.sheets.map((s) => h('button', { class: 'pill-tab' + (s.name === cur ? ' is-active' : ''), type: 'button', attrs: { role: 'tab', 'aria-selected': String(s.name === cur) }, on: { click: () => { cur = s.name; paint(); } } },
      s.name, s.status === 'same' ? null : h('span', { class: 'badge badge--amber sheet-cmp__n', text: s.status === 'changed' ? String(s.changes.length) : t('work.cmp.' + s.status) }))));
    const sh = r.sheets.find((s) => s.name === cur);
    if (!sh) { view.replaceChildren(); return; }
    if (sh.status === 'same') { view.replaceChildren(h('p', { class: 'muted', text: t('work.cmp.same') })); return; }
    if (sh.status !== 'changed') { view.replaceChildren(h('p', { class: 'muted', text: t('work.cmp.sheet.' + sh.status) })); return; }
    view.replaceChildren(
      h('div', { class: 'small muted', text: t('work.cmp.summary', { n: sh.changes.length, before: sh.beforeRows, after: sh.afterRows }) + (sh.truncated ? ' ' + t('work.cmp.truncated') : '') }),
      h('div', { class: 'sheet-cmp__table-wrap' }, h('table', { class: 'sheet-cmp__table' },
        h('thead', null, h('tr', null, h('th', { text: t('work.cmp.cell') }), h('th', { text: t('work.cmp.before') }), h('th', { text: t('work.cmp.after') }))),
        h('tbody', null, ...sh.changes.slice(0, 1000).map((c) => h('tr', { class: 'sheet-cmp__row sheet-cmp__row--' + c.kind },
          h('td', { class: 'mono', text: c.cell }), h('td', { class: 'sheet-cmp__old', text: c.before }), h('td', { class: 'sheet-cmp__new', text: c.after })))))));
  };
  paint();
  const fromTo = r.created ? t('work.cmp.created') : r.deleted ? t('work.cmp.deleted') : t('work.cmp.fromTo.' + (r.to === 'working' ? 'working' : 'commit'));
  body.replaceChildren(h('p', { class: 'small muted', text: fromTo }), changed.length ? null : h('p', { text: t('work.cmp.noChanges') }), tabs, view);
}

// ---------- ask about a file ----------

export function openAskAboutFile({ actions, rel }) {
  const close = h('button', { class: 'btn', type: 'button', text: t('common.cancel') });
  const pick = (kind) => { dlg.close('done'); actions.askAboutFile(rel, kind); };
  const opt = (kind, ic) => h('button', { class: 'wt-quick__btn ask-file__opt', type: 'button', on: { click: () => pick(kind) } }, h('span', { class: 'wt-mode__ic' }, icon(ic)), h('span', { class: 'strong', text: t('work.ask.' + kind) }));
  const body = h('div', { class: 'ask-file' }, h('p', { class: 'muted small mono', text: rel }),
    h('div', { class: 'wt-quick' }, opt('explain', 'info'), opt('errors', 'alert'), opt('chart', 'chart'), opt('summarize', 'list'), opt('custom', 'edit')));
  const dlg = openDialog({ title: t('work.ask.title'), body, footer: [close], isDirty: () => false });
  close.addEventListener('click', () => dlg.close('cancel'));
}

// ---------- drop a file anywhere ----------

export function installDropToStart({ store, api, actions }) {
  let depth = 0;
  const overlay = h('div', { class: 'drop-start', hidden: true, attrs: { 'aria-hidden': 'true' } },
    h('div', { class: 'drop-start__card' }, icon('upload', 'drop-start__ic'), h('div', { class: 'strong drop-start__t' }), h('div', { class: 'small muted drop-start__s' })));
  document.body.appendChild(overlay);
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  const inComposer = (e) => !!(e.target && e.target.closest && e.target.closest('.composer, .composer-wrap, .modal'));
  document.addEventListener('dragenter', (e) => {
    if (!hasFiles(e) || inComposer(e)) return;
    depth++;
    overlay.querySelector('.drop-start__t').textContent = t('work.drop.title');
    overlay.querySelector('.drop-start__s').textContent = t('work.drop.sub');
    overlay.hidden = false;
  });
  document.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) overlay.hidden = true; });
  document.addEventListener('dragover', (e) => { if (hasFiles(e) && !inComposer(e)) e.preventDefault(); });
  document.addEventListener('drop', (e) => {
    depth = 0; overlay.hidden = true;
    if (!hasFiles(e) || inComposer(e) || e.defaultPrevented) return;
    e.preventDefault();
    const f = [...e.dataTransfer.files][0];
    if (!f) return;
    const abs = api.pathForFile ? api.pathForFile(f) : '';
    if (!abs) { toast(t('work.drop.noPath'), 'error'); return; }
    openDropDialog({ store, api, actions, abs, name: f.name });
  });
}

function openDropDialog({ store, api, actions, abs, name }) {
  const p = activeProject(store.get());
  let target = p ? 'current' : 'new';
  const close = h('button', { class: 'btn', type: 'button', text: t('common.cancel') });
  const acts = fileActions(name);
  const run = async (act) => {
    dlg.close('done');
    try {
      let pid = p && target === 'current' ? p.id : null;
      if (!pid) {
        const base = name.replace(/\.[^.]+$/, '').slice(0, 60) || 'Project';
        const dir = await api.projects.newDir(base);
        const created = await actions.createProject({ name: base, path: dir.path, agent: (p && p.agent) || 'claude', mode: 'default', autoCommit: true });
        pid = created.id;
        await actions.selectProject(pid);
      }
      const imp = await api.files.import(pid, abs);
      if (!act) { toast(t('work.drop.added', { file: imp.rel }), 'success'); actions.openFile(imp.rel); return; }
      actions.send(act.prompt(imp.rel));
    } catch (e) { toast((e && e.message) || t('errors.generic'), 'error', 6000); }
  };
  const where = p ? h('div', { class: 'segmented drop-dlg__where', attrs: { role: 'radiogroup' } },
    ...['current', 'new'].map((k) => {
      const b = h('button', { class: 'segmented__item' + (target === k ? ' is-active' : ''), type: 'button', attrs: { role: 'radio', 'aria-checked': String(target === k) }, text: k === 'current' ? t('work.drop.current', { name: p.name }) : t('work.drop.new') });
      b.addEventListener('click', () => { target = k; [...b.parentNode.children].forEach((x) => { const on = x === b; x.classList.toggle('is-active', on); x.setAttribute('aria-checked', String(on)); }); });
      return b;
    })) : h('p', { class: 'small muted', text: t('work.drop.willCreate') });
  const body = h('div', { class: 'drop-dlg' }, h('p', { class: 'mono small', text: name }), where,
    h('div', { class: 'wt-quick' }, ...acts.map((a) => h('button', { class: 'wt-quick__btn', type: 'button', on: { click: () => run(a) } }, h('span', { class: 'strong', text: t('work.drop.act.' + a.id) })))),
    h('button', { class: 'btn btn--ghost btn--sm', type: 'button', text: t('work.drop.justAdd'), on: { click: () => run(null) } }));
  const dlg = openDialog({ title: t('work.drop.dialog'), body, footer: [close], isDirty: () => false });
  close.addEventListener('click', () => dlg.close('cancel'));
}

// ---------- quick ask ----------

export function installQuickAsk({ store, actions }) {
  const input = h('input', { class: 'input quick-ask__input', type: 'text', attrs: { 'aria-label': t('work.quick.label'), autocomplete: 'off' } });
  const answer = h('div', { class: 'quick-ask__answer md' });
  const hint = h('div', { class: 'quick-ask__hint xs faint' });
  const box = h('div', { class: 'quick-ask', hidden: true, attrs: { role: 'dialog', 'aria-label': t('work.quick.label') } },
    h('div', { class: 'quick-ask__row' }, icon('sparkles', 'quick-ask__ic'), input), answer, hint);
  document.body.appendChild(box);
  let sentFor = null; // {pid, turnId}
  const paint = () => {
    const s = store.get();
    const p = activeProject(s);
    input.placeholder = p ? t('work.quick.placeholder', { name: p.name }) : t('work.quick.noProject');
    input.disabled = !p;
    hint.textContent = t('work.quick.hint');
    if (!sentFor || !p || p.id !== sentFor.pid) { answer.replaceChildren(); return; }
    const chat = s.chats[p.id];
    const msgs = chat ? turnMessages(chat.messages || [], sentFor.turnId) : [];
    const last = [...msgs].reverse().find((m) => m.role === 'assistant' && m.text);
    answer.replaceChildren(last ? renderMarkdown(last.text, { streaming: !!(chat && chat.running) }) : h('div', { class: 'row muted small' }, h('span', { class: 'spinner' }), t('work.quick.thinking')));
  };
  const open = () => { box.hidden = false; paint(); input.focus(); input.select(); };
  const close = () => { box.hidden = true; };
  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key !== 'Enter' || !input.value.trim()) return;
    e.preventDefault();
    const s = store.get();
    const p = activeProject(s);
    const chat = p && s.chats[p.id];
    if (!p || (chat && chat.running)) { toast(t('work.quick.busy'), 'warn'); return; }
    const text = input.value.trim();
    input.value = '';
    await actions.send(text);
    const c2 = store.get().chats[p.id];
    sentFor = { pid: p.id, turnId: c2 ? c2.turn.id : 0 };
    paint();
  });
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === 'Space') { e.preventDefault(); if (box.hidden) open(); else close(); return; }
    if (e.key === 'Escape' && !box.hidden) { e.preventDefault(); e.stopPropagation(); close(); }
  }, true);
  document.addEventListener('mousedown', (e) => { if (!box.hidden && !box.contains(e.target)) close(); });
  store.subscribe(() => { if (!box.hidden) paint(); });
  return { open, close };
}

// ---------- scheduled tasks ----------

export function openScheduleDialog({ store, api }) {
  const body = h('div', { class: 'sched' });
  const close = h('button', { class: 'btn btn--primary', type: 'button', text: t('common.close') });
  const dlg = openDialog({ title: t('work.sched.title'), body, footer: [close], size: 'lg', isDirty: () => !!editing && editingDirty });
  close.addEventListener('click', () => dlg.close('done'));
  let tasks = [];
  let editing = null; // task draft
  let editingDirty = false;
  const DAYS = [1, 2, 3, 4, 5, 6, 0];

  async function load() { try { tasks = await api.schedule.list(); } catch { tasks = []; } paint(); }
  const unsub = api.onSchedule ? api.onSchedule(({ tasks: list }) => { tasks = list || []; if (!editing) paint(); }) : null;
  const origClose = dlg.close;
  dlg.close = (r) => { if (unsub) unsub(); origClose(r); };

  function when(task) {
    const time = task.time;
    if (task.freq === 'hourly') return t('work.sched.everyHour', { min: time.slice(3) });
    if (task.freq === 'daily') return t('work.sched.everyDay', { time });
    return t('work.sched.everyWeek', { days: task.days.map((d) => t('work.sched.day.' + d)).join(', '), time });
  }

  function listView() {
    const add = h('button', { class: 'btn btn--primary btn--sm', type: 'button', on: { click: () => { editing = { name: '', projectId: (activeProject(store.get()) || {}).id || '', kind: 'prompt', prompt: '', recipeId: '', freq: 'daily', time: '09:00', days: [1], enabled: true, catchUp: true }; editingDirty = false; paint(); } } }, icon('plus'), t('work.sched.add'));
    const rows = tasks.map((task) => {
      const sw = h('input', { type: 'checkbox', checked: task.enabled, attrs: { role: 'switch', 'aria-label': t('work.sched.enabled') } });
      sw.addEventListener('change', () => api.schedule.save({ ...task, enabled: sw.checked }).catch(() => toast(t('errors.generic'), 'error')));
      const last = task.lastResult ? (task.lastResult.ok ? t('work.sched.lastOk', { when: new Date(task.lastResult.at).toLocaleString() }) : t('work.sched.lastFail', { error: task.lastResult.error || '' })) : t('work.sched.never');
      return h('div', { class: 'list-row sched__row' },
        h('label', { class: 'toggle' }, sw, h('span', { class: 'toggle__track' })),
        h('div', { class: 'list-row__main' }, h('div', { class: 'list-row__title', text: task.name }),
          h('div', { class: 'list-row__sub small muted', text: `${task.projectName || '?'} - ${when(task)} - ${task.enabled && task.nextAt ? t('work.sched.next', { when: new Date(task.nextAt).toLocaleString() }) : t('work.sched.paused')}` }),
          h('div', { class: 'xs faint', text: last })),
        h('button', { class: 'btn btn--sm', type: 'button', text: t('work.sched.runNow'), on: { click: async () => { const r = await api.schedule.runNow(task.id); toast(r && r.ok ? t('work.sched.started') : t('work.sched.notStarted', { error: (r && r.error) || '' }), r && r.ok ? 'success' : 'warn'); } } }),
        h('button', { class: 'btn btn--ghost btn--sm', type: 'button', text: t('work.sched.edit'), on: { click: () => { editing = { ...task }; editingDirty = false; paint(); } } }),
        h('button', { class: 'btn btn--ghost btn--icon btn--sm', type: 'button', title: t('work.sched.delete'), attrs: { 'aria-label': t('work.sched.delete') }, on: { click: async () => { if (await confirmDialog({ title: t('work.sched.delete'), message: task.name, confirmLabel: t('work.sched.delete'), danger: true })) api.schedule.remove(task.id); } } }, icon('trash')));
    });
    return [h('p', { class: 'small muted', text: t('work.sched.intro') }), h('div', null, add), tasks.length ? h('div', { class: 'card card--flush' }, ...rows) : h('p', { class: 'muted', text: t('work.sched.none') })];
  }

  function formView() {
    const e = editing;
    const mark = () => { editingDirty = true; };
    const field = (label, ctl) => h('div', { class: 'field' }, h('div', { class: 'field__label', text: label }), ctl);
    const name = h('input', { class: 'input', type: 'text', value: e.name, attrs: { maxlength: '80' } });
    name.addEventListener('input', () => { e.name = name.value; mark(); });
    const proj = h('select', { class: 'select' }, ...store.get().projects.map((p) => h('option', { value: p.id, text: p.name })));
    proj.value = e.projectId; proj.addEventListener('change', () => { e.projectId = proj.value; mark(); });
    const kind = h('select', { class: 'select' }, h('option', { value: 'prompt', text: t('work.sched.kindPrompt') }), h('option', { value: 'recipe', text: t('work.sched.kindRecipe') }));
    kind.value = e.kind; kind.addEventListener('change', () => { e.kind = kind.value; mark(); paint(); });
    const prompt = h('textarea', { class: 'input sched__prompt', rows: 4, value: e.prompt, attrs: { placeholder: t('work.sched.promptPh') } });
    prompt.value = e.prompt || '';
    prompt.addEventListener('input', () => { e.prompt = prompt.value; mark(); });
    const recipes = (store.get().methods || []);
    const recipe = h('select', { class: 'select' }, h('option', { value: '', text: t('work.sched.pickRecipe') }), ...recipes.map((m) => h('option', { value: m.id, text: m.name || m.id })));
    recipe.value = e.recipeId || ''; recipe.addEventListener('change', () => { e.recipeId = recipe.value; mark(); });
    const freq = h('select', { class: 'select' }, ...['hourly', 'daily', 'weekly'].map((f) => h('option', { value: f, text: t('work.sched.freq.' + f) })));
    freq.value = e.freq; freq.addEventListener('change', () => { e.freq = freq.value; mark(); paint(); });
    const time = h('input', { class: 'input', type: 'time', value: e.time });
    time.addEventListener('change', () => { e.time = time.value || '09:00'; mark(); });
    const days = h('div', { class: 'row wrap gap-2' }, ...DAYS.map((d) => {
      const cb = h('input', { type: 'checkbox', checked: e.days.includes(d) });
      cb.addEventListener('change', () => { e.days = cb.checked ? [...new Set([...e.days, d])] : e.days.filter((x) => x !== d); mark(); });
      return h('label', { class: 'row gap-1 small' }, cb, t('work.sched.day.' + d));
    }));
    const catchUp = h('input', { type: 'checkbox', checked: e.catchUp !== false });
    catchUp.addEventListener('change', () => { e.catchUp = catchUp.checked; mark(); });
    const err = h('div', { class: 'field__error', attrs: { role: 'alert' } });
    const save = h('button', { class: 'btn btn--primary', type: 'button', text: t('work.sched.save'), on: { click: async () => {
      try { await api.schedule.save(e); editing = null; editingDirty = false; await load(); } catch (x) { err.textContent = (x && x.message) || t('errors.generic'); }
    } } });
    const cancel = h('button', { class: 'btn', type: 'button', text: t('common.cancel'), on: { click: () => { editing = null; editingDirty = false; paint(); } } });
    return [
      field(t('work.sched.name'), name), field(t('work.sched.project'), proj), field(t('work.sched.what'), kind),
      e.kind === 'prompt' ? field(t('work.sched.prompt'), prompt) : field(t('work.sched.recipe'), recipe),
      h('div', { class: 'settings-grid' }, field(t('work.sched.freqLabel'), freq), field(e.freq === 'hourly' ? t('work.sched.minute') : t('work.sched.time'), time)),
      e.freq === 'weekly' ? field(t('work.sched.days'), days) : null,
      h('label', { class: 'row gap-2 small' }, catchUp, t('work.sched.catchUp')),
      h('p', { class: 'xs faint', text: t('work.sched.whileOpen') }),
      err, h('div', { class: 'row gap-2' }, save, cancel),
    ];
  }

  function paint() { body.replaceChildren(...(editing ? formView() : listView())); }
  load();
  return dlg;
}

// ---------- update banner ----------

export function installUpdateBanner({ api }) {
  const el = h('div', { class: 'update-banner', hidden: true, attrs: { role: 'status' } });
  document.body.appendChild(el);
  let dismissedVersion = null;
  let tick = null;
  const paint = (st) => {
    clearInterval(tick); tick = null;
    if (st && st.status === 'installing') { // countdown, then FlowState restarts and installs by itself
      el.hidden = false;
      const text = h('span', { class: 'small' });
      const upd = () => { text.textContent = t('work.update.installing', { version: st.version || '', s: Math.max(0, Math.ceil((st.at - Date.now()) / 1000)) }); };
      upd(); tick = setInterval(upd, 500);
      el.replaceChildren(icon('download', 'update-banner__ic'), text,
        h('button', { class: 'btn btn--primary btn--sm', type: 'button', text: t('work.update.now'), on: { click: () => api.update.install() } }),
        h('button', { class: 'btn btn--ghost btn--sm', type: 'button', text: t('common.cancel'), on: { click: () => api.update.cancel() } }));
      return;
    }
    if (!st || st.status !== 'ready' || st.version === dismissedVersion) { el.hidden = true; return; }
    el.hidden = false;
    el.replaceChildren(icon('download', 'update-banner__ic'),
      h('span', { class: 'small', text: t('work.update.ready', { version: st.version || '' }) }),
      h('button', { class: 'btn btn--primary btn--sm', type: 'button', text: t('work.update.restart'), on: { click: () => api.update.install() } }),
      h('button', { class: 'btn btn--ghost btn--sm', type: 'button', text: t('work.update.later'), on: { click: () => { dismissedVersion = st.version; el.hidden = true; } } }));
  };
  if (api.onUpdate) api.onUpdate(paint);
  if (api.update && api.update.status) Promise.resolve(api.update.status()).then(paint).catch(() => {});
}
