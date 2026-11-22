// Methodology editor: header + graph canvas (left) + inspector / variables / checks (right).
import { NODE_TYPES, VAR_TYPES, ID_RE, KEY_RE, pickText, validateMethodology, extractVarKeys, undeclaredVars } from '../../shared/methodology.js';
import { h, icon, nextId } from '../lib/dom.js';
import { t, tIn, getLanguage } from '../lib/i18n.js';
import * as G from '../lib/graph-state.js';
import { NODE_META, duplicateOf } from '../lib/method-utils.js';
import { createGraph } from './graph.js';
import { confirmDialog, toast } from './modal.js';

const AGENTS = ['claude', 'agy'];
const MODES = ['default', 'acceptEdits', 'plan'];

export function createMethodEditor({ store, api, actions }) {
  const root = h('div', { class: 'me' });
  let hist = null;
  let savedJson = '';
  let isNew = false;
  let sel = null;
  let tab = 'node';
  let serverError = '';
  let current = null; // the object received from the store (identity check)

  const lang = () => getLanguage();
  const m = () => hist.present;
  const dirty = () => JSON.stringify(m()) !== savedJson;

  // ---------- skeleton ----------
  const backBtn = h('button', { class: 'btn btn--ghost btn--sm', type: 'button', on: { click: () => requestClose() } }, icon('chevron', 'prompts__back-icon'), h('span', { class: 'me__back-label' }));
  const titleEl = h('h2', { class: 'me__title truncate' });
  const badges = h('span', { class: 'row gap-1' });
  const btnRun = h('button', { class: 'btn btn--sm', type: 'button', on: { click: () => runIt() } }, icon('play'), h('span', { text: '' }));
  const btnExport = h('button', { class: 'btn btn--sm', type: 'button', on: { click: () => exportIt() } }, icon('download'), h('span'));
  const btnCopy = h('button', { class: 'btn btn--sm', type: 'button', on: { click: () => saveCopy() } }, icon('copy'), h('span'));
  const btnSave = h('button', { class: 'btn btn--sm btn--primary', type: 'button', on: { click: () => save() } }, icon('check'), h('span'));
  const head = h('div', { class: 'me__head' }, backBtn, titleEl, badges, h('span', { class: 'grow' }), btnRun, btnExport, btnCopy, btnSave);
  const saveErr = h('div', { class: 'me__saveerr', hidden: true, attrs: { role: 'alert' } });

  const mk = (id, cls = 'input') => h(cls === 'textarea' ? 'textarea' : 'input', { class: cls, id, type: cls === 'textarea' ? undefined : 'text', autocomplete: 'off', spellcheck: false });
  const nameEn = mk('me-name-en'); const nameEs = mk('me-name-es');
  const descEn = mk('me-desc-en'); const descEs = mk('me-desc-es');
  const tagsIn = mk('me-tags'); const idIn = mk('me-id'); idIn.classList.add('mono');
  const lab = (id, key) => h('label', { class: 'field__label', for: id, text: t(key) });
  const fieldWrap = (id, key, c, hint) => h('div', { class: 'field' }, lab(id, key), c, hint ? h('div', { class: 'field__hint', text: t(hint) }) : null);
  const metaGrid = h('div', { class: 'me__meta' });
  const metaDetails = h('details', { class: 'me__details' }, h('summary', { class: 'me__sum' }), metaGrid);
  const nameRow = h('div', { class: 'me__names' });

  const setMeta = (patch, key) => apply(G.updateMeta(m(), patch), key);
  nameEn.addEventListener('input', () => setMeta({ name: { ...m().name, en: nameEn.value } }, 'name-en'));
  nameEs.addEventListener('input', () => setMeta({ name: { ...m().name, es: nameEs.value } }, 'name-es'));
  descEn.addEventListener('input', () => setMeta({ description: { ...(m().description || {}), en: descEn.value } }, 'desc-en'));
  descEs.addEventListener('input', () => setMeta({ description: { ...(m().description || {}), es: descEs.value } }, 'desc-es'));
  tagsIn.addEventListener('input', () => setMeta({ tags: tagsIn.value.split(',').map((x) => x.trim()).filter(Boolean) }, 'tags'));
  idIn.addEventListener('input', () => setMeta({ id: idIn.value.trim() }, 'id'));

  const palette = h('div', { class: 'me__palette', attrs: { role: 'group' } });
  const btnConnect = tbBtn('link', () => toggleConnect());
  const btnDelete = tbBtn('trash', () => deleteSelection());
  const btnLayout = tbBtn('grid', () => { apply(G.clearLayout(m())); graph.fit(); });
  const btnUndo = tbBtn('undo', () => doUndo());
  const btnRedo = tbBtn('redo', () => doRedo());
  const validity = h('span', { class: 'badge', attrs: { role: 'status' } });
  const toolbar = h('div', { class: 'me__toolbar' }, palette, btnConnect, btnLayout, btnDelete, h('span', { class: 'me__sep' }), btnUndo, btnRedo, h('span', { class: 'grow' }), validity);
  function tbBtn(ic, fn) { return h('button', { class: 'btn btn--sm me__tb', type: 'button', on: { click: fn } }, icon(ic), h('span', { class: 'me__tb-label' })); }

  const graph = createGraph({
    editable: true,
    onSelect: (s) => { sel = s; if (s) tab = 'node'; renderSide(); renderToolbar(); },
    onOpen: (id) => { sel = { kind: 'node', id }; tab = 'node'; renderSide(); const first = side.querySelector('.me__panel input, .me__panel textarea, .me__panel select'); if (first) first.focus(); },
    onMove: (id, x, y) => apply(G.setNodePos(m(), id, x, y)),
    onConnect: (from, to) => doConnect(from, to),
    onDelete: (s) => deleteSelection(s),
    onModeChange: () => renderToolbar(),
  });

  const tabsEl = h('div', { class: 'pill-tabs me__tabs', attrs: { role: 'tablist' } });
  const panel = h('div', { class: 'me__panel', attrs: { role: 'tabpanel' } });
  const side = h('aside', { class: 'me__side' }, tabsEl, panel);
  const body = h('div', { class: 'me__body' }, h('div', { class: 'me__canvas' }, graph.el), side);
  root.append(head, saveErr, nameRow, metaDetails, toolbar, body);

  // ---------- state transitions ----------
  function apply(next, key) {
    hist = G.commit(hist, next, key || null);
    sync(false);
  }
  function sync(rebuild) {
    if (sel && sel.kind === 'node' && !m().nodes.some((n) => n.id === sel.id)) { sel = null; rebuild = true; }
    if (sel && sel.kind === 'edge' && !m().edges[sel.index]) { sel = null; rebuild = true; }
    graph.setMethodology(m());
    graph.setSelection(sel);
    renderHead(); renderToolbar(); renderTabs();
    if (rebuild) { fillMeta(); renderPanel(); } else refreshLive();
  }
  function doUndo() { hist = G.undo(hist); sync(true); }
  function doRedo() { hist = G.redo(hist); sync(true); }

  function loadDraft(draft, asNew) {
    isNew = asNew;
    const d = JSON.parse(JSON.stringify(draft));
    if (!d.vars) d.vars = [];
    if (!d.edges) d.edges = [];
    if (!d.tags) d.tags = [];
    if (!ID_RE.test(d.id || '')) d.id = G.uniqueId(G.slugify(pickText(d.name, 'en')) || 'methodology', store.get().methods.map((x) => x.id));
    hist = G.createHistory(d);
    savedJson = asNew ? '' : JSON.stringify(d);
    sel = null; tab = 'node'; serverError = ''; saveErr.hidden = true;
    graph.setMethodology(d, { keepView: false });
    graph.setSelection(null);
    renderStatic(); sync(true);
    metaDetails.open = asNew;
  }

  // ---------- header / toolbar ----------
  function renderStatic() {
    const set = (b, key) => { const sp = b.querySelector('span'); sp.textContent = t(key); b.setAttribute('title', t(key)); };
    backBtn.querySelector('.me__back-label').textContent = t('method.editor.back');
    set(btnRun, 'method.run.button'); set(btnExport, 'method.export'); set(btnCopy, 'method.editor.saveCopy'); set(btnSave, 'common.save');
    metaDetails.querySelector('summary').textContent = t('method.editor.details');
    nameRow.replaceChildren(fieldWrap('me-name-en', 'method.editor.nameEn', nameEn), fieldWrap('me-name-es', 'method.editor.nameEs', nameEs));
    metaGrid.replaceChildren(
      fieldWrap('me-desc-en', 'method.editor.descEn', descEn), fieldWrap('me-desc-es', 'method.editor.descEs', descEs),
      fieldWrap('me-tags', 'method.editor.tags', tagsIn, 'method.editor.tagsHint'), fieldWrap('me-id', 'method.editor.id', idIn, 'method.editor.idHint'));
    palette.setAttribute('aria-label', t('method.editor.addNode'));
    palette.replaceChildren(h('span', { class: 'me__plabel small muted', text: t('method.editor.addNode') }), ...NODE_TYPES.map((ty) => h('button', {
      class: `btn btn--sm me__add me__add--${ty}`, type: 'button', attrs: { title: t('method.editor.addType', { type: t('method.type.' + ty) }) },
      on: { click: () => addNodeOfType(ty) },
    }, icon(NODE_META[ty].icon), h('span', { class: 'me__add-label', text: t('method.type.' + ty) }))));
    const lbl = (b, key) => { b.querySelector('.me__tb-label').textContent = t(key); b.setAttribute('title', t(key)); b.setAttribute('aria-label', t(key)); };
    lbl(btnConnect, 'method.editor.connect'); lbl(btnLayout, 'method.editor.autoLayout'); lbl(btnDelete, 'method.editor.delete'); lbl(btnUndo, 'method.editor.undo'); lbl(btnRedo, 'method.editor.redo');
  }

  function fillMeta() {
    const d = m();
    const set = (inp, v) => { if (document.activeElement !== inp) inp.value = v || ''; };
    set(nameEn, d.name && d.name.en); set(nameEs, d.name && d.name.es);
    set(descEn, d.description && d.description.en); set(descEs, d.description && d.description.es);
    set(tagsIn, (d.tags || []).join(', ')); set(idIn, d.id);
    idIn.readOnly = !isNew && d.source !== 'recorded' ? true : false;
  }

  function renderHead() {
    const d = m();
    titleEl.textContent = pickText(d.name, lang()) || t('method.untitled');
    const srcTone = { bundled: 'badge--muted', user: 'badge--accent', recorded: 'badge--amber' }[d.source] || 'badge--muted';
    badges.replaceChildren(...[h('span', { class: 'badge ' + srcTone, text: t('method.source.' + (d.source || 'user')) }),
      dirty() ? h('span', { class: 'badge badge--amber', text: t('method.editor.unsaved') }) : null].filter(Boolean));
    btnRun.disabled = isNew || dirty();
    btnRun.title = isNew || dirty() ? t('method.editor.saveFirst') : t('method.run.button');
    btnExport.disabled = isNew || dirty();
    btnExport.title = isNew || dirty() ? t('method.editor.saveFirst') : t('method.export');
    const issues = validateMethodology(d);
    btnSave.disabled = false;
    if (d.source === 'bundled') titleEl.title = t('method.editor.bundledNote');
  }

  function renderToolbar() {
    btnUndo.disabled = !G.canUndo(hist); btnRedo.disabled = !G.canRedo(hist);
    btnDelete.disabled = !sel;
    btnConnect.classList.toggle('is-active', graph.isConnecting());
    btnConnect.setAttribute('aria-pressed', String(graph.isConnecting()));
    const errs = validateMethodology(m());
    const lint = G.lint(m()).filter((l) => l.code !== 'undeclared-var');
    const n = errs.length + lint.length;
    validity.className = 'badge ' + (errs.length ? 'badge--red' : lint.length ? 'badge--amber' : 'badge--green');
    validity.replaceChildren(h('span', { class: 'badge__dot' }), errs.length ? t('method.editor.invalid', { n }) : lint.length ? t('method.editor.warnings', { n }) : t('method.editor.valid'));
  }

  // ---------- tabs ----------
  function renderTabs() {
    const d = m();
    const unresolved = undeclaredVars(d).length;
    const checks = validateMethodology(d).length + G.lint(d).length;
    const defs = [['node', t('method.editor.tabNode')], ['vars', t('method.editor.tabVars') + ` (${(d.vars || []).length})`, unresolved], ['checks', t('method.editor.tabChecks') + ` (${checks})`]];
    tabsEl.replaceChildren(...defs.map(([id, label, flag]) => h('button', {
      class: 'pill-tab' + (tab === id ? ' is-active' : ''), type: 'button', attrs: { role: 'tab', 'aria-selected': String(tab === id), tabindex: tab === id ? '0' : '-1' },
      on: { click: () => { tab = id; renderTabs(); renderPanel(); } },
    }, h('span', { class: 'truncate', text: label }), flag ? h('span', { class: 'dot dot--amber', title: t('method.var.undeclaredTitle') }) : null, flag ? h('span', { class: 'sr-only', text: t('method.var.undeclaredTitle') }) : null)));
  }
  tabsEl.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const ids = ['node', 'vars', 'checks'];
    tab = ids[(ids.indexOf(tab) + (e.key === 'ArrowRight' ? 1 : 2)) % 3];
    renderTabs(); renderPanel();
    const b = tabsEl.querySelector('[aria-selected="true"]'); if (b) b.focus();
  });

  function renderSide() { renderTabs(); renderPanel(); }
  function renderPanel() {
    if (tab === 'vars') panel.replaceChildren(...varsPanel());
    else if (tab === 'checks') panel.replaceChildren(...checksPanel());
    else panel.replaceChildren(...nodePanel());
  }
  /** After a non-structural edit: refresh the parts that mirror the data without stealing focus. */
  function refreshLive() {
    if (tab === 'checks') panel.replaceChildren(...checksPanel());
    if (tab === 'node' && chipsHost) fillChips();
    if (tab === 'vars' && suggestHost) fillSuggest();
  }

  // ---------- helpers for inspector fields ----------
  const fid = () => nextId('mf');
  function field(label, control, hint) {
    if (!control.id) control.id = fid();
    return h('div', { class: 'field' }, h('label', { class: 'field__label', for: control.id, text: label }), control, hint ? h('div', { class: 'field__hint', text: hint }) : null);
  }
  function textIn(value, onInput, { area = false, mono = false, rows = 4, placeholder } = {}) {
    const c = h(area ? 'textarea' : 'input', { class: (area ? 'textarea' : 'input') + (mono ? ' mono' : ''), value: value || '', autocomplete: 'off', spellcheck: false, placeholder: placeholder || '' });
    if (area) c.rows = rows; else c.type = 'text';
    c.addEventListener('input', () => onInput(c.value));
    return c;
  }
  function selectIn(options, value, onChange) {
    const c = h('select', { class: 'select' }, ...options.map(([v, label]) => h('option', { value: v, text: label })));
    c.value = value;
    c.addEventListener('change', () => onChange(c.value));
    return c;
  }
  const editNode = (id, patch, key) => apply(G.updateNode(m(), id, patch), key ? `${id}:${key}` : null);

  let chipsHost = null;
  let suggestHost = null;
  let chipsText = '';

  function fillChips() {
    if (!chipsHost) return;
    const d = m();
    const n = sel && sel.kind === 'node' ? d.nodes.find((q) => q.id === sel.id) : null;
    if (!n) return;
    const keys = extractVarKeys(chipsText);
    const declared = new Set([...(d.vars || []).map((v) => v.key), ...d.nodes.filter((q) => q.type === 'ask-user').map((q) => q.saveAs), 'projectName', 'projectPath']);
    chipsHost.replaceChildren(...keys.map((k) => h('span', { class: 'chip ' + (declared.has(k) ? 'chip--ok' : 'chip--warn'), title: declared.has(k) ? t('method.chip.declared') : t('method.chip.undeclared') },
      `{{${k}}}`, declared.has(k) ? null : h('span', { class: 'sr-only', text: ' ' + t('method.chip.undeclared') }))));
    chipsHost.hidden = !keys.length;
  }

  // ---------- node / edge inspector ----------
  function nodePanel() {
    chipsHost = null; suggestHost = null;
    if (!sel) return [h('div', { class: 'empty-state me__empty' }, h('div', { class: 'empty-state__icon' }, icon('pointer', 'icon--lg')), h('div', { class: 'empty-state__title', text: t('method.inspector.noneTitle' ) }), h('div', { class: 'empty-state__text', text: t('method.inspector.noneText') }))];
    if (sel.kind === 'edge') return edgePanel();
    const d = m();
    const n = d.nodes.find((q) => q.id === sel.id);
    if (!n) return [];
    const L = lang();
    const ti = (typeof n.title === 'string') ? { en: n.title, es: n.title } : n.title;
    const out = [
      h('div', { class: 'row gap-2 wrap' }, h('span', { class: `badge me__type me__type--${n.type}` }, icon(NODE_META[n.type].icon), t('method.type.' + n.type)), h('span', { class: 'faint small mono', text: n.id })),
      h('div', { class: 'me__two' },
        field(t('method.inspector.titleEn'), textIn(ti.en, (v) => editNode(n.id, { title: { ...ti, ...(typeof n.title === 'object' ? n.title : {}), en: v } }, 'title-en'))),
        field(t('method.inspector.titleEs'), textIn(ti.es || '', (v) => editNode(n.id, { title: { ...(typeof n.title === 'object' ? n.title : { en: n.title }), es: v } }, 'title-es')))),
    ];
    if (n.type === 'prompt') {
      chipsText = n.text || '';
      const ta = textIn(n.text, (v) => { chipsText = v; editNode(n.id, { text: v }, 'text'); }, { area: true, rows: 7, mono: true });
      chipsHost = h('div', { class: 'row wrap gap-1 me__chips' });
      out.push(field(t('method.inspector.promptText'), ta, t('method.inspector.promptHint')), chipsHost,
        h('div', { class: 'me__two' },
          field(t('method.inspector.agent'), selectIn([['', t('method.inspector.projectDefault')], ...AGENTS.map((a) => [a, t('agent.' + a)])], n.agent || '', (v) => editNode(n.id, { agent: v || undefined }))),
          field(t('mode.label'), selectIn([['', t('method.inspector.projectDefault')], ...MODES.map((x) => [x, t('mode.' + x)])], n.mode || '', (v) => editNode(n.id, { mode: v || undefined })))));
      fillChips();
    } else if (n.type === 'command') {
      out.push(h('div', { class: 'me__warn', attrs: { role: 'note' } }, icon('shield'), h('span', { text: t('method.inspector.commandWarn') })),
        field(t('method.inspector.exe'), textIn(n.exe, (v) => editNode(n.id, { exe: v }, 'exe'), { mono: true, placeholder: 'python' })),
        argsEditor(n));
    } else if (n.type === 'git-commit') {
      out.push(field(t('method.inspector.commitMessage'), textIn(n.message, (v) => editNode(n.id, { message: v }, 'message')), t('method.inspector.commitHint')));
    } else if (n.type === 'ask-user') {
      out.push(field(t('method.inspector.question'), textIn(n.question, (v) => editNode(n.id, { question: v }, 'question'), { area: true, rows: 3 })),
        field(t('method.inspector.saveAs'), textIn(n.saveAs, (v) => editNode(n.id, { saveAs: v }, 'saveAs'), { mono: true }), t('method.inspector.saveAsHint')));
    } else if (n.type === 'checkpoint') {
      out.push(field(t('method.inspector.checkpointMessage'), textIn(n.message, (v) => editNode(n.id, { message: v }, 'message'), { area: true, rows: 3 }), t('method.inspector.checkpointHint')));
    } else if (n.type === 'artifact') {
      out.push(field(t('method.inspector.artifactPath'), textIn(n.path, (v) => editNode(n.id, { path: v }, 'path'), { mono: true, placeholder: 'dashboard.py' }), t('method.inspector.artifactHint')),
        field(t('method.inspector.artifactDesc'), textIn(n.description || '', (v) => editNode(n.id, { description: v || undefined }, 'description'))));
    } else if (n.type === 'condition') {
      const dl = h('datalist', { id: 'me-vars-dl' }, ...[...(d.vars || []).map((v) => v.key), ...d.nodes.filter((q) => q.type === 'ask-user').map((q) => q.saveAs)].map((k) => h('option', { value: k })));
      const vin = textIn(n.var, (v) => editNode(n.id, { var: v }, 'var'), { mono: true });
      vin.setAttribute('list', 'me-vars-dl');
      out.push(dl, h('div', { class: 'me__two' }, field(t('method.inspector.condVar'), vin), field(t('method.inspector.condEquals'), textIn(n.equals, (v) => editNode(n.id, { equals: v }, 'equals'), { mono: true }))),
        h('div', { class: 'faint small', text: t('method.inspector.condHint') }));
    }
    if (n.note) out.push(h('div', { class: 'me__note' }, h('div', { class: 'field__label', text: t('method.inspector.note') }), h('div', { class: 'small', text: n.note })));
    out.push(connections(n));
    out.push(h('div', null, h('button', { class: 'btn btn--danger btn--sm', type: 'button', on: { click: () => deleteSelection() } }, icon('trash'), t('method.editor.deleteNode'))));
    return out;
  }

  function argsEditor(n) {
    const args = n.args || [];
    const box = h('div', { class: 'field' }, h('div', { class: 'field__label', text: t('method.inspector.args') }));
    const list = h('div', { class: 'col gap-1' });
    args.forEach((a, i) => {
      const inp = h('input', { class: 'input mono', type: 'text', value: a, autocomplete: 'off', spellcheck: false, attrs: { 'aria-label': t('method.inspector.argN', { n: i + 1 }) } });
      inp.addEventListener('input', () => { const next = [...(m().nodes.find((q) => q.id === n.id).args || [])]; next[i] = inp.value; editNode(n.id, { args: next }, 'arg' + i); });
      list.append(h('div', { class: 'row gap-1' }, inp, h('button', {
        class: 'btn btn--ghost btn--icon btn--sm', type: 'button', attrs: { 'aria-label': t('method.inspector.removeArg', { n: i + 1 }), title: t('method.inspector.removeArg', { n: i + 1 }) },
        on: { click: () => { editNode(n.id, { args: args.filter((_, j) => j !== i) }); renderPanel(); } },
      }, icon('x'))));
    });
    box.append(list, h('div', null, h('button', { class: 'btn btn--sm', type: 'button', on: { click: () => { editNode(n.id, { args: [...args, ''] }); renderPanel(); const ins = panel.querySelectorAll('.me__panel .field .input.mono'); if (ins.length) ins[ins.length - 1].focus(); } } }, icon('plus'), t('method.inspector.addArg'))),
      h('div', { class: 'field__hint', text: t('method.inspector.argsHint') }));
    return box;
  }

  function connections(n) {
    const d = m();
    const L = lang();
    const outs = d.edges.map((e, i) => ({ e, i })).filter((x) => x.e.from === n.id);
    const title = (id) => pickText((d.nodes.find((q) => q.id === id) || {}).title, L) || id;
    const box = h('div', { class: 'me__conns' }, h('div', { class: 'field__label', text: t('method.inspector.connections') }));
    if (!outs.length) box.append(h('div', { class: 'faint small', text: t('method.inspector.noOut') }));
    for (const { e, i } of outs) {
      const row = h('div', { class: 'row gap-1 me__conn' }, h('span', { class: 'icon-arrow', attrs: { 'aria-hidden': 'true' }, text: '\u2192' }), h('span', { class: 'grow truncate', text: title(e.to), title: title(e.to) }));
      if (n.type === 'condition') {
        const sl = selectIn([['', t('graph.none')], ['yes', t('graph.yes')], ['no', t('graph.no')]], e.label || '', (v) => {
          const r = G.setEdgeLabel(m(), i, v);
          if (r.error) { toast(t('graph.err.' + r.error), 'warn'); sl.value = e.label || ''; return; }
          apply(r.m); renderPanel();
        });
        sl.setAttribute('aria-label', t('method.inspector.branchLabel'));
        sl.classList.add('select--sm');
        row.append(sl);
      }
      row.append(h('button', { class: 'btn btn--ghost btn--icon btn--sm', type: 'button', attrs: { 'aria-label': t('method.inspector.removeEdge', { name: title(e.to) }), title: t('method.inspector.removeEdge', { name: title(e.to) }) }, on: { click: () => { apply(G.removeEdge(m(), i)); renderPanel(); } } }, icon('x')));
      box.append(row);
    }
    const targets = d.nodes.filter((q) => q.id !== n.id && !G.connectError(d, n.id, q.id));
    if (targets.length) {
      const pick = selectIn([['', t('method.inspector.connectTo')], ...targets.map((q) => [q.id, title(q.id)])], '', () => {});
      pick.classList.add('select--sm');
      pick.setAttribute('aria-label', t('method.inspector.connectTo'));
      pick.addEventListener('change', () => { if (pick.value) { doConnect(n.id, pick.value); renderPanel(); } });
      box.append(pick);
    } else if (n.type !== 'condition' && outs.length) box.append(h('div', { class: 'faint small', text: t('method.inspector.singleOut') }));
    return box;
  }

  function edgePanel() {
    const d = m();
    const e = d.edges[sel.index];
    const L = lang();
    const title = (id) => pickText((d.nodes.find((q) => q.id === id) || {}).title, L) || id;
    const src = d.nodes.find((q) => q.id === e.from);
    const out = [h('div', { class: 'row gap-2 wrap' }, h('span', { class: 'badge badge--muted', text: t('method.inspector.edge') }), h('strong', { text: title(e.from) }), h('span', { text: '\u2192' }), h('strong', { text: title(e.to) }))];
    if (src && src.type === 'condition') {
      const sl = selectIn([['', t('graph.none')], ['yes', t('graph.yes')], ['no', t('graph.no')]], e.label || '', (v) => {
        const r = G.setEdgeLabel(m(), sel.index, v);
        if (r.error) { toast(t('graph.err.' + r.error), 'warn'); sl.value = e.label || ''; return; }
        apply(r.m);
      });
      out.push(field(t('method.inspector.branchLabel'), sl));
    }
    out.push(h('div', null, h('button', { class: 'btn btn--danger btn--sm', type: 'button', on: { click: () => deleteSelection() } }, icon('trash'), t('method.editor.deleteEdge'))));
    return out;
  }

  // ---------- variables ----------
  function varsPanel() {
    chipsHost = null;
    const d = m();
    suggestHost = h('div', { class: 'col gap-2' });
    const out = [suggestHost];
    (d.vars || []).forEach((v, i) => {
      const upd = (patch, key) => apply(G.updateVar(m(), i, patch), `var${i}:${key || Object.keys(patch)[0]}`);
      const key = textIn(v.key, (x) => { upd({ key: x }, 'key'); fillSuggest(); }, { mono: true });
      key.classList.add('me__varkey');
      const type = selectIn(VAR_TYPES.map((x) => [x, t('method.vtype.' + x)]), v.type, (x) => { upd({ type: x, ...(x === 'select' && !(v.options || []).length ? { options: ['a', 'b'] } : {}) }); renderPanel(); });
      const opts = textIn((v.options || []).join(', '), (x) => upd({ options: x.split(',').map((q) => q.trim()).filter(Boolean) }, 'options'));
      const req = h('input', { type: 'checkbox', id: fid(), checked: !!v.required });
      req.addEventListener('change', () => upd({ required: req.checked }));
      out.push(h('div', { class: 'card me__var' },
        h('div', { class: 'row gap-2' },
          h('div', { class: 'grow' }, field(t('method.var.key'), key)),
          h('div', null, field(t('method.var.type'), type))),
        h('div', { class: 'me__two' },
          field(t('method.var.labelEn'), textIn((v.label && v.label.en) || '', (x) => upd({ label: { ...(v.label || {}), en: x } }, 'len'))),
          field(t('method.var.labelEs'), textIn((v.label && v.label.es) || '', (x) => upd({ label: { ...(v.label || {}), es: x } }, 'les')))),
        v.type === 'select' ? field(t('method.var.options'), opts, t('method.var.optionsHint')) : null,
        field(t('method.var.default'), textIn(v.default || '', (x) => upd({ default: x || undefined }, 'default'))),
        h('div', { class: 'row between' },
          h('label', { class: 'toggle', for: req.id }, req, h('span', { class: 'toggle__track' }), h('span', { text: t('method.var.required') })),
          h('button', { class: 'btn btn--ghost btn--sm', type: 'button', on: { click: () => { apply(G.removeVar(m(), i)); renderPanel(); } } }, icon('trash'), t('common.delete')))));
    });
    out.push(h('div', null, h('button', { class: 'btn btn--sm', type: 'button', on: { click: () => {
      const taken = new Set((m().vars || []).map((v) => v.key));
      let k = 'var1'; for (let i = 2; taken.has(k); i += 1) k = 'var' + i;
      apply(G.addVar(m(), G.newVar(k))); renderPanel();
    } } }, icon('plus'), t('method.var.add'))), h('div', { class: 'faint small', text: t('method.var.renameHint') }));
    fillSuggest();
    return out;
  }
  function fillSuggest() {
    if (!suggestHost) return;
    const keys = undeclaredVars(m());
    if (!keys.length) { suggestHost.replaceChildren(); return; }
    suggestHost.replaceChildren(h('div', { class: 'me__suggest', attrs: { role: 'group', 'aria-label': t('method.var.undeclaredTitle') } },
      h('div', { class: 'strong small', text: t('method.var.undeclaredTitle') }),
      ...keys.map((k) => h('div', { class: 'row gap-2 between' }, h('span', { class: 'chip chip--warn', text: `{{${k}}}` }),
        h('button', { class: 'btn btn--sm', type: 'button', attrs: { 'aria-label': t('method.var.declareKey', { key: k }) }, on: { click: () => { apply(G.declareVars(m(), [k])); renderPanel(); } } }, icon('plus'), t('method.var.declare')))),
      keys.length > 1 ? h('div', null, h('button', { class: 'btn btn--sm', type: 'button', on: { click: () => { apply(G.declareVars(m(), keys)); renderPanel(); } } }, t('method.var.declareAll'))) : null));
  }

  // ---------- checks ----------
  function checksPanel() {
    chipsHost = null; suggestHost = null;
    const d = m();
    const errs = validateMethodology(d);
    const lint = G.lint(d);
    const L = lang();
    const title = (id) => pickText((d.nodes.find((q) => q.id === id) || {}).title, L) || id;
    const items = [];
    errs.forEach((e) => items.push(h('li', { class: 'me__check me__check--err' }, h('span', { class: 'badge badge--red', text: t('method.checks.error') }), h('span', { class: 'mono small', text: e }))));
    lint.forEach((l) => {
      const msg = l.code === 'branch-missing' ? t('method.checks.branchMissing', { name: title(l.nodeId), label: t('graph.' + l.label) })
        : l.code === 'multi-out' ? t('method.checks.multiOut', { name: title(l.nodeId) })
          : l.code === 'multi-start' ? t('method.checks.multiStart', { names: l.nodeIds.map(title).join(', ') })
            : t('method.checks.undeclared', { key: l.key });
      items.push(h('li', { class: 'me__check' }, h('span', { class: 'badge badge--amber', text: t('method.checks.warning') }), h('span', { class: 'small', text: msg })));
    });
    if (!items.length) return [h('div', { class: 'row gap-2' }, h('span', { class: 'badge badge--green' }, h('span', { class: 'badge__dot' }), t('method.editor.valid')), h('span', { class: 'muted small', text: t('method.checks.allGood') }))];
    return [h('div', { class: 'faint small', text: t('method.checks.intro') }), h('ul', { class: 'me__checks' }, ...items)];
  }

  // ---------- actions ----------
  function addNodeOfType(type) {
    const afterId = sel && sel.kind === 'node' ? sel.id : (m().nodes.length ? lastNodeId() : null);
    const title = { en: tIn('en', 'method.type.' + type), es: tIn('es', 'method.type.' + type) };
    const r = G.addNode(m(), type, { title, afterId });
    if (!r.id) { toast(t('graph.err.max'), 'warn'); return; }
    sel = { kind: 'node', id: r.id }; tab = 'node';
    apply(r.m);
    renderSide();
    graph.setSelection(sel);
    graph.focusNode(r.id);
    announce(r.connected ? t('method.editor.addedConnected', { type: t('method.type.' + type) }) : t('method.editor.added', { type: t('method.type.' + type) }));
  }
  function lastNodeId() {
    const d = m();
    const sinks = d.nodes.filter((n) => !d.edges.some((e) => e.from === n.id));
    return sinks.length === 1 ? sinks[0].id : null;
  }
  function doConnect(from, to) {
    const r = G.connect(m(), from, to);
    if (r.error) { toast(t('graph.err.' + r.error), 'warn'); announce(t('graph.err.' + r.error)); return; }
    apply(r.m);
    announce(t('method.editor.connected'));
  }
  function announce(msg) { const live = root.querySelector('.me__live'); if (live) live.textContent = msg; }
  function toggleConnect() { graph.setConnectMode(!graph.isConnecting(), sel && sel.kind === 'node' && !graph.isConnecting() ? sel.id : null); renderToolbar(); }
  function deleteSelection(s) {
    const target = s || sel;
    if (!target) return;
    if (target.kind === 'node') {
      if (m().nodes.length <= 1) { toast(t('method.editor.lastNode'), 'warn'); return; }
      sel = null; apply(G.removeNode(m(), target.id));
    } else { sel = null; apply(G.removeEdge(m(), target.index)); }
    graph.setSelection(null);
    renderSide();
  }

  async function save({ silent = false } = {}) {
    serverError = ''; saveErr.hidden = true;
    let d = JSON.parse(JSON.stringify(m()));
    if (!ID_RE.test(d.id || '')) d.id = G.uniqueId(G.slugify(pickText(d.name, 'en')) || 'methodology', store.get().methods.map((x) => x.id));
    btnSave.disabled = true;
    try {
      const saved = await api.method.save(d);
      hist = G.createHistory(saved); savedJson = JSON.stringify(saved); isNew = false;
      sel = sel && saved.nodes.some((n) => sel.kind === 'node' && n.id === sel.id) ? sel : null;
      await actions.loadMethods();
      store.set({ editing: { ...(store.get().editing || {}), draft: saved, isNew: false, token: current.token } });
      sync(true);
      if (!silent) toast(t('method.saved', { name: pickText(saved.name, lang()) }), 'success');
      return saved;
    } catch (e) {
      serverError = (e && e.message) || t('errors.saveFailed');
      saveErr.replaceChildren(icon('alert'), h('span', { text: t('method.saveFailed', { message: serverError }) }));
      saveErr.hidden = false;
      toast(t('method.saveFailed', { message: serverError }), 'error', 7000);
      return null;
    } finally { btnSave.disabled = false; }
  }

  async function saveCopy() {
    const taken = store.get().methods.map((x) => x.id);
    const d = duplicateOf(m(), G.uniqueId(m().id + '-copy', taken), { en: tIn('en', 'method.copySuffix'), es: tIn('es', 'method.copySuffix') });
    d.source = 'user';
    try {
      const saved = await api.method.save(d);
      await actions.loadMethods();
      toast(t('method.saved', { name: pickText(saved.name, lang()) }), 'success');
      actions.openMethodEditor(saved, { isNew: false });
    } catch (e) {
      toast(t('method.saveFailed', { message: (e && e.message) || t('errors.generic') }), 'error', 7000);
    }
  }
  async function exportIt() { await actions.exportMethod(m().id); }
  function runIt() { actions.runMethod(m().id); }

  async function requestClose() {
    if (dirty()) {
      const ok = await confirmDialog({ title: t('method.editor.closeTitle'), message: t('method.editor.closeConfirm'), confirmLabel: t('method.editor.discard'), danger: true });
      if (!ok) return false;
    }
    store.set({ editing: null });
    return true;
  }

  // keyboard shortcuts (outside text fields)
  root.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || tag === 'select';
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return; }
    if (typing || !mod) return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); doUndo(); } else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); doRedo(); }
  });
  root.append(h('div', { class: 'sr-only me__live', attrs: { role: 'status', 'aria-live': 'polite' } }));

  return {
    el: root,
    /** Called by the page when store.editing changes. */
    show(editing) {
      if (!editing) { current = null; return; }
      if (current && current.token === editing.token) return;
      current = editing;
      loadDraft(editing.draft, !!editing.isNew);
    },
    update() { if (hist) { renderStatic(); sync(true); } },
    requestClose,
    isDirty: () => !!hist && dirty(),
  };
}
