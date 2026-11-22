// New-project wizard: What do you need help with? -> questions of the chosen case -> name -> agent -> ready.
// Pure logic (case filtering, quick picks, folder preview, file import) lives in lib/cases.js.
import { h, icon, radioKeys } from '../lib/dom.js';
import { pickText } from '../../shared/methodology.js';
import { t, onChange, getLanguage } from '../lib/i18n.js';
import { openDialog } from './modal.js';
import { buildVarsForm } from './vars-form.js';
import { runDefaults } from '../lib/method-utils.js';
import { statusChip } from '../lib/login-state.js';
import { isGlobalDev } from '../lib/store.js';
import {
  CASE_FILTERS, QUICK_PICKS, caseIcon, casesOf, filterCases, resolveQuickPick, defaultProjectName, folderPreview, wizardSteps,
  filesToImport, importFileVars, preferredAgent,
} from '../lib/cases.js';

/** Last path segment of a Windows or POSIX path. Pure. */
export function folderName(p) {
  return String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
}

/** The agent step counts as satisfied only when the chosen agent is signed in (never blocks). Pure. */
export function prerequisitesSatisfied(signedIn, agent) {
  return !!signedIn && signedIn[agent] === true;
}

export { wizardSteps as stepsFor };
export const STEPS = wizardSteps(false);

export function openWalkthrough({ store, api, actions }) {
  const data = {
    choice: '', caseId: '', method: null, varValues: {}, name: '', nameTouched: false, agent: 'claude', agentTouched: false,
    cats: [], query: '', customPath: '',
  };
  let step = 0;
  let varsForm = null;
  let allCases = null;
  let defaultDir = '';
  let error = '';
  let busy = false;
  let created = null;
  let finished = false;
  const imported = {};

  const body = h('div', { class: 'wt' });
  const dlg = openDialog({ title: t('wizard.title'), body, footer: [], size: 'lg', onClose: () => { unsubLang(); unsubStore(); } });
  const hasQuestions = () => !!(data.method && (data.method.vars || []).length);
  const ids = () => wizardSteps(hasQuestions());
  const cur = () => ids()[step];
  const caseName = () => (data.method ? pickText(data.method.name, getLanguage()) : t('wizard.emptyName'));

  const unsubLang = onChange(() => render());
  let lastSig = store.get().signedIn;
  const unsubStore = store.subscribe((s) => { if (s.signedIn !== lastSig) { lastSig = s.signedIn; if (cur() === 'agent') render(); } });

  (async () => {
    try { allCases = casesOf(await api.method.list(store.get().activeProjectId || undefined)); } catch { allCases = []; }
    if (cur() === 'help') render();
  })();
  (async () => {
    try { defaultDir = (await api.projects.defaultDir()) || ''; } catch { defaultDir = ''; }
    if (cur() === 'name') render();
  })();

  async function pickCase(id) {
    error = '';
    if (!id) { data.choice = 'empty'; data.caseId = ''; data.method = null; data.varValues = {}; return; }
    try {
      const m = await api.method.get(id, store.get().activeProjectId || undefined);
      data.choice = 'case'; data.caseId = id; data.method = m; data.varValues = runDefaults(m.vars || []);
    } catch (e) { error = (e && e.message) || t('errors.generic'); }
  }

  async function quickPick(pick) {
    const r = resolveQuickPick(allCases || [], pick);
    if (r.kind === 'case') { await pickCase(r.id); if (data.choice) { go(1); return; } } else { data.cats = r.categories; data.query = ''; }
    render();
    const g = body.querySelector('.wt-cases [role="radio"]');
    if (g) g.scrollIntoView({ block: 'nearest' });
  }

  function go(delta) {
    error = '';
    const n = ids().length;
    step = Math.max(0, Math.min(step + delta, n - 1));
    if (cur() === 'name' && !data.nameTouched) data.name = defaultProjectName(caseName());
    if (cur() === 'agent' && !data.agentTouched) data.agent = preferredAgent(store.get().signedIn);
    render();
  }

  function next() {
    const id = cur();
    if (id === 'help' && !data.choice) { error = t('wizard.pickFirst'); render(); return; }
    if (id === 'questions' && varsForm && !varsForm.validate()) return;
    if (id === 'name' && !data.name.trim()) { error = t('wizard.nameRequired'); render(); return; }
    if (id === 'ready') { start(); return; }
    go(1);
  }

  async function start() {
    busy = true; error = ''; render();
    const name = data.name.trim();
    try {
      if (!created) {
        let path = data.customPath;
        if (!path) path = (await api.projects.newDir(name)).path;
        created = await actions.createProject({ name, path, agent: data.agent, mode: 'default', autoCommit: true });
      }
      if (data.caseId) {
        const vals = await importFileVars(api, created.id, (data.method && data.method.vars) || [], data.varValues, imported);
        await actions.startRun(created.id, data.caseId, vals);
      }
      finished = true;
      dlg.close('done');
      return;
    } catch (e) { error = (e && e.message) || t('errors.generic'); }
    busy = false; render();
  }

  // ---- screens ----
  function caseCard(m) {
    const L = getLanguage();
    const on = data.caseId === m.id;
    return h('button', { class: 'wt-case' + (on ? ' is-active' : ''), type: 'button', attrs: { role: 'radio', 'aria-checked': String(on), tabindex: on ? '0' : '-1' }, on: { click: async () => { await pickCase(m.id); render(); } } },
      h('span', { class: 'wt-case__ic' }, icon(caseIcon(m.meta && m.meta.icon))),
      h('span', { class: 'wt-case__name strong', text: pickText(m.name, L) }),
      h('span', { class: 'wt-case__desc muted small', text: pickText(m.description, L) }));
  }

  function helpScreen() {
    const L = getLanguage();
    const quick = h('div', { class: 'wt-quick' }, ...QUICK_PICKS.map((p) => h('button', { class: 'wt-quick__btn', type: 'button', disabled: allCases === null, on: { click: () => quickPick(p) } },
      h('span', { class: 'wt-mode__ic' }, icon(p.icon, 'icon--lg')), h('span', { class: 'wt-quick__t strong', text: t('wizard.quick.' + p.id) }))));
    quick.append(h('button', { class: 'wt-quick__btn', type: 'button', on: { click: async () => { await pickCase(''); go(1); } } },
      h('span', { class: 'wt-mode__ic' }, icon('folder', 'icon--lg')), h('span', { class: 'wt-quick__t strong', text: t('wizard.quick.empty') })));
    const search = h('input', { class: 'input', id: 'wz-search', type: 'search', value: data.query, placeholder: t('wizard.search'), attrs: { 'aria-label': t('wizard.search') } });
    search.addEventListener('input', () => { data.query = search.value; fillGrid(); });
    const chipBtn = (c) => {
      const on = (c === 'all' && !data.cats.length) || (data.cats.length === 1 && data.cats[0] === c);
      return h('button', { class: 'wt-filter' + (on ? ' is-active' : ''), type: 'button', text: t('wizard.cat.' + c), attrs: { 'aria-pressed': String(on) }, on: { click: () => { data.cats = c === 'all' ? [] : [c]; render(); } } });
    };
    const chips = h('div', { class: 'wt-filters', attrs: { role: 'group', 'aria-label': t('wizard.filters') } }, ...CASE_FILTERS.map(chipBtn));
    const grid = h('div', { class: 'wt-cases', attrs: { role: 'radiogroup', 'aria-label': t('wizard.more') } });
    radioKeys(grid);
    function fillGrid() {
      const list = filterCases(allCases || [], { category: data.cats, query: data.query, lang: L });
      const emptyOn = data.choice === 'empty';
      grid.replaceChildren(...list.map(caseCard),
        h('button', { class: 'wt-case wt-case--empty' + (emptyOn ? ' is-active' : ''), type: 'button', attrs: { role: 'radio', 'aria-checked': String(emptyOn), tabindex: emptyOn ? '0' : '-1' }, on: { click: async () => { await pickCase(''); render(); } } },
          h('span', { class: 'wt-case__ic' }, icon('folder')), h('span', { class: 'wt-case__name strong', text: t('wizard.empty') }), h('span', { class: 'wt-case__desc muted small', text: t('wizard.emptyText') })));
      if (allCases && !list.length) grid.prepend(h('div', { class: 'faint small wt-cases__none', text: t('wizard.noMatch') }));
    }
    fillGrid();
    return [h('p', { text: t('wizard.helpText') }), quick,
      h('div', { class: 'wt__sub strong', text: t('wizard.more') }), search, chips,
      allCases === null ? h('div', { class: 'row muted' }, h('span', { class: 'spinner' }), t('common.loading')) : grid,
      error ? h('div', { class: 'field__error', attrs: { role: 'alert' }, text: error }) : null];
  }

  function questionsScreen() {
    varsForm = buildVarsForm({ vars: (data.method && data.method.vars) || [], values: data.varValues, api });
    return [h('p', { text: t('wizard.questionsText', { name: caseName() }) }), varsForm.el];
  }

  function nameScreen() {
    const input = h('input', { class: 'input', id: 'wz-name', type: 'text', value: data.name, maxLength: 80, autocomplete: 'off' });
    const preview = h('div', { class: 'faint small mono wt-folder', id: 'wz-folder' });
    const paint = () => { preview.textContent = t('wizard.folder', { path: data.customPath || folderPreview(defaultDir, data.name, getLanguage()) }); };
    input.addEventListener('input', () => { data.name = input.value; data.nameTouched = true; paint(); });
    paint();
    input.setAttribute('aria-describedby', 'wz-folder');
    const dev = isGlobalDev(store.get());
    const adv = dev ? h('details', { class: 'wt-adv' }, h('summary', { text: t('wizard.advanced') }),
      h('div', { class: 'row gap-2' },
        h('button', { class: 'btn btn--sm', type: 'button', text: t('project.browse'), on: { click: async () => { const p = await api.projects.pickFolder(); if (p) { data.customPath = p; render(); } } } }),
        data.customPath ? h('button', { class: 'btn btn--sm btn--ghost', type: 'button', text: t('wizard.useDefault'), on: { click: () => { data.customPath = ''; render(); } } }) : null)) : null;
    if (adv && data.customPath) adv.open = true;
    return [h('p', { text: t('wizard.nameText') }),
      h('div', { class: 'field' }, h('label', { class: 'field__label', for: 'wz-name', text: t('project.name') }), input, preview),
      adv, error ? h('div', { class: 'field__error', attrs: { role: 'alert' }, text: error }) : null];
  }

  function agentScreen() {
    const signed = store.get().signedIn;
    const dev = isGlobalDev(store.get());
    const seg = h('div', { class: 'segmented', attrs: { role: 'radiogroup', 'aria-label': t('agent.switch') } },
      ...['claude', 'agy'].map((a) => h('button', { class: 'segmented__item' + (data.agent === a ? ' is-active' : ''), type: 'button', text: t('agent.' + a),
        attrs: { role: 'radio', 'aria-checked': String(data.agent === a), tabindex: data.agent === a ? '0' : '-1' }, on: { click: () => { data.agent = a; data.agentTouched = true; render(); } } })));
    radioKeys(seg);
    const rows = ['claude', 'agy'].map((a) => {
      const c = statusChip(signed[a]);
      const health = store.get().health;
      return h('div', { class: 'list-row' }, h('div', { class: 'list-row__main' }, h('div', { class: 'list-row__title', text: t('agent.' + a) }),
        dev && health && health[a] && health[a].version ? h('div', { class: 'list-row__sub', text: health[a].version }) : null),
      h('span', { class: 'badge badge--' + c.tone }, h('span', { class: 'badge__dot' }), t(c.key)),
      signed[a] === true ? null : h('button', { class: 'btn btn--sm', type: 'button', text: t('banner.signIn'), on: { click: () => actions.openLogin(a) } }));
    });
    return [h('p', { text: t(dev ? 'wizard.agentTextDev' : 'wizard.agentText') }), h('div', null, seg), h('div', { class: 'card card--flush' }, ...rows),
      prerequisitesSatisfied(signed, data.agent) ? null : h('div', { class: 'wt-note', attrs: { role: 'status' }, text: t('walkthrough.signInNeeded', { agent: t('agent.' + data.agent) }) })];
  }

  function readyScreen() {
    const files = filesToImport(data.method && data.method.vars, data.varValues);
    const dev = isGlobalDev(store.get());
    const line = (k, v) => h('div', { class: 'wt-sum__row' }, h('span', { class: 'faint small wt-sum__k', text: k }), h('span', { class: 'wt-sum__v', text: v }));
    return [h('p', { text: t('wizard.readyText') }),
      h('div', { class: 'card wt-sum' },
        line(t('wizard.sum.what'), data.method ? caseName() : t('wizard.empty')),
        line(t('project.name'), data.name.trim()),
        dev ? line(t('wizard.sum.folder'), data.customPath || folderPreview(defaultDir, data.name, getLanguage())) : null,
        line(t('wizard.sum.agent'), t('agent.' + data.agent))),
      files.length ? h('div', { class: 'wt-note wt-note--data', attrs: { role: 'note' } }, icon('copy'),
        h('span', null, h('strong', { text: t('wizard.sum.copied') + ' ' }), files.map((f) => f.name).join(', '), ' ', t('wizard.sum.copiedNote'))) : null,
      busy ? h('div', { class: 'row muted', attrs: { role: 'status' } }, h('span', { class: 'spinner' }), t('wizard.creating')) : null,
      error ? h('div', { class: 'field__error', attrs: { role: 'alert' }, text: t('wizard.failed', { message: error }) }) : null];
  }

  function render() {
    const id = cur();
    dlg.setTitle(t('wizard.title'));
    const list = ids();
    const stepper = h('div', { class: 'stepper', attrs: { role: 'list', 'aria-label': t('walkthrough.stepOf', { current: step + 1, total: list.length }) } },
      ...list.map((s, i) => h('div', { class: 'stepper__step' + (i === step ? ' is-active' : i < step ? ' is-done' : ''), attrs: { role: 'listitem', ...(i === step ? { 'aria-current': 'step' } : {}) } },
        h('span', { class: 'stepper__num', text: i < step ? '\u2713' : String(i + 1) }), h('span', { class: 'truncate', text: t('wizard.steps.' + s) }))));
    const screens = { help: helpScreen, questions: questionsScreen, name: nameScreen, agent: agentScreen, ready: readyScreen };
    const content = h('div', { class: 'wt__content' }, h('div', { class: 'wt__title', text: id === 'help' ? t('wizard.helpTitle') : t('wizard.steps.' + id) }), ...screens[id]());
    body.replaceChildren(stepper, content);
    const buttons = [h('button', { class: 'btn btn--ghost', type: 'button', text: t('common.cancel'), disabled: busy, on: { click: () => dlg.close('cancel') } })];
    if (step > 0) buttons.push(h('button', { class: 'btn', type: 'button', text: t('walkthrough.back'), disabled: busy || !!created, on: { click: () => go(-1) } }));
    buttons.push(h('button', { class: 'btn btn--primary', type: 'button', disabled: busy, text: id === 'ready' ? (error ? t('wizard.retry') : t('wizard.start')) : t('walkthrough.next'), on: { click: next } }));
    dlg.setFooter(buttons);
    const target = content.querySelector('#wz-name, .vf input, .vf textarea, .vf .vf-drop, .segmented__item.is-active, .wt-quick__btn');
    if (!dlg.dialog.contains(document.activeElement) || document.activeElement === document.body) (target || buttons[buttons.length - 1]).focus();
  }

  render();
  return dlg;
}
