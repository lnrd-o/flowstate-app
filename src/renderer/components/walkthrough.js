// New-project walkthrough: welcome -> prerequisites -> folder -> agent -> git -> done.
import { h, radioKeys } from '../lib/dom.js';
import { pickText } from '../../shared/methodology.js';
import { t, onChange, getLanguage } from '../lib/i18n.js';
import { openDialog } from './modal.js';
import { installJobs } from '../lib/install-state.js';
import { createLogBox } from './log-box.js';
import { buildVarsForm } from './vars-form.js';
import { runDefaults } from '../lib/method-utils.js';

const INSTALLABLE = ['git', 'node', 'python'];

export const STEPS = ['welcome', 'prerequisites', 'folder', 'agent', 'start', 'git', 'done'];

/** Step ids for the wizard: the variables step only exists when a methodology is chosen. Pure. */
export function stepsFor(methodId) {
  return methodId ? ['welcome', 'prerequisites', 'folder', 'agent', 'start', 'variables', 'git', 'done'] : STEPS;
}

/** Last path segment of a Windows or POSIX path. Pure. */
export function folderName(p) {
  return String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
}

export function prereqRows(health) {
  if (!health) return [];
  return [
    { id: 'claude', ok: !!health.claude.found, version: health.claude.version, extra: health.claude.found ? (health.claude.loggedIn === false ? 'notLoggedIn' : 'loggedIn') : null },
    { id: 'agy', ok: !!health.agy.found, version: health.agy.version },
    { id: 'node', ok: !!health.node.found, version: health.node.version },
    { id: 'git', ok: !!health.git.found, version: health.git.version },
    { id: 'python', ok: !!health.python.found, version: health.python.version },
  ];
}

export function openWalkthrough({ store, api, actions, firstRun }) {
  const data = { path: '', name: '', agent: 'claude', mode: 'default', autoCommit: true, methodId: '', method: null, varValues: {} };
  let step = 0;
  let varsForm = null;
  let runError = '';
  const ids = () => stepsFor(data.methodId);
  let health = store.get().health;
  let checking = false;
  let error = '';
  let creating = false;
  let created = null;
  let finished = false;
  let startLoaded = false;

  const body = h('div', { class: 'wt' });
  const dlg = openDialog({
    title: t('walkthrough.title'), body, footer: [], size: 'lg',
    onClose: () => { unsub(); if (!finished) actions.walkthroughClosed(); },
  });
  let logBoxes = [];
  const runningNow = () => INSTALLABLE.map((i) => installJobs.get(i).running).join();
  let lastRunning = runningNow();
  const unsubLang = onChange(() => render());
  const unsubJobs = installJobs.subscribe(() => { const r = runningNow(); if (r !== lastRunning) { lastRunning = r; if (ids()[step] === 'prerequisites') { health = store.get().health; render(); } } });
  const unsub = () => { unsubLang(); unsubJobs(); logBoxes.forEach((l) => l.destroy()); };

  async function runCheck() {
    checking = true; render();
    try { health = await api.health.check(); actions.setHealth(health); } catch { /* keep previous */ }
    checking = false; render();
  }

  async function create() {
    if (!data.path) { error = t('walkthrough.folderRequired'); step = 2; render(); return; }
    creating = true; error = ''; render();
    try {
      created = await actions.createProject({ ...data, name: data.name || folderName(data.path) });
      step = ids().length - 1;
      if (data.methodId) {
        try {
          await actions.startRun(created.id, data.methodId, data.varValues);
          finished = true; actions.walkthroughClosed(); dlg.close('done');
          return;
        } catch (e) { runError = (e && e.message) || t('errors.generic'); }
      }
    } catch (e) {
      error = (e && e.message) || t('errors.generic');
    }
    creating = false; render();
  }

  function next() {
    if (step === 2 && !data.path) { error = t('walkthrough.folderRequired'); render(); return; }
    error = '';
    if (ids()[step] === 'variables' && varsForm && !varsForm.validate()) return;
    if (ids()[step] === 'git') { create(); return; }
    step = Math.min(step + 1, ids().length - 1);
    if (ids()[step] === 'prerequisites') runCheck(); else render();
  }

  function stepBody() {
    const id = ids()[step];
    const text = h('p', { text: t('walkthrough.' + id + 'Text') });
    if (id === 'welcome') return [h('h3', { class: 'wt__h', text: t('app.name') }), text, h('p', { class: 'muted', text: t('app.tagline') })];
    if (id === 'prerequisites') {
      const rows = prereqRows(health).map((r) => {
        const acts = [];
        if (!r.ok && INSTALLABLE.includes(r.id)) {
          acts.push(h('button', { class: 'btn btn--sm', type: 'button', disabled: installJobs.get(r.id).running, text: t('prereq.install'),
            on: { click: async () => { await actions.installPrereq(r.id, { dialog: false }); health = store.get().health; render(); } } }));
        }
        if (!r.ok && (r.id === 'claude' || r.id === 'agy')) acts.push(h('button', { class: 'btn btn--sm', type: 'button', text: t('banner.browseSettings'), on: { click: () => actions.openSettings() } }));
        if (r.ok && r.extra === 'notLoggedIn') acts.push(h('button', { class: 'btn btn--sm', type: 'button', text: t('banner.signIn'), on: { click: () => actions.signIn('claude') } }));
        return h('div', { class: 'list-row' },
          h('div', { class: 'list-row__main list-row__main--wrap' },
            h('div', { class: 'list-row__title', text: t('health.' + r.id) }),
            h('div', { class: 'list-row__sub list-row__sub--wrap' }, r.ok ? (r.version || t('health.found')) : t('walkthrough.hint.' + r.id)),
            r.extra ? h('div', { class: 'list-row__sub', text: t('health.' + r.extra) }) : null,
            acts.length ? h('div', { class: 'row wrap gap-1 list-row__acts' }, ...acts) : null),
          h('span', { class: 'badge ' + (r.ok ? 'badge--green' : 'badge--red') }, h('span', { class: 'badge__dot' }), r.ok ? t('health.found') : t('health.missing')));
      });
      logBoxes.forEach((l) => l.destroy());
      logBoxes = INSTALLABLE.map((i) => createLogBox(installJobs, i, { lines: 5 }));
      const vpn = health && health.vpn.active;
      return [text,
        checking || !health ? h('div', { class: 'row muted' }, h('span', { class: 'spinner' }), t('common.loading')) : h('div', { class: 'card card--flush' }, ...rows),
        health ? h('div', { class: 'row' },
          h('span', { class: 'badge ' + (vpn ? 'badge--red' : 'badge--green') }, h('span', { class: 'badge__dot' }), vpn ? t('health.vpnActive') : t('health.vpnInactive')),
          h('span', { class: 'badge ' + (health.anthropicReachable ? 'badge--green' : 'badge--red') }, h('span', { class: 'badge__dot' }),
            t('health.anthropic') + ': ' + (health.anthropicReachable ? t('health.reachable') : t('health.unreachable')))) : null,
        ...logBoxes.map((l) => l.el),
        h('div', null, h('button', { class: 'btn btn--sm', type: 'button', text: t('banner.recheck'), disabled: checking, on: { click: runCheck } }))];
    }
    if (id === 'folder') {
      const pathInput = h('input', { class: 'input mono', id: 'wt-path', type: 'text', value: data.path, readOnly: true, placeholder: 'C:\\...' });
      const browse = h('button', { class: 'btn', type: 'button', text: t('project.browse'), on: { click: async () => {
        const p = await api.projects.pickFolder();
        if (p) { data.path = p; if (!data.name) data.name = folderName(p); error = ''; render(); }
      } } });
      const nameInput = h('input', { class: 'input', id: 'wt-name', type: 'text', value: data.name || folderName(data.path) });
      nameInput.addEventListener('input', () => { data.name = nameInput.value; });
      return [text,
        h('div', { class: 'field' }, h('label', { class: 'field__label', for: 'wt-path', text: t('project.path') }),
          h('div', { class: 'row' }, pathInput, browse)),
        h('div', { class: 'field' }, h('label', { class: 'field__label', for: 'wt-name', text: t('project.name') }), nameInput),
        error ? h('div', { class: 'field__error', attrs: { role: 'alert' }, text: error }) : null];
    }
    if (id === 'agent') {
      const seg = h('div', { class: 'segmented', attrs: { role: 'radiogroup', 'aria-label': t('agent.switch') } },
        ...['claude', 'agy'].map((a) => h('button', {
          class: 'segmented__item' + (data.agent === a ? ' is-active' : ''), type: 'button', text: t('agent.' + a),
          attrs: { role: 'radio', 'aria-checked': String(data.agent === a), tabindex: data.agent === a ? '0' : '-1' },
          on: { click: () => { data.agent = a; render(); } },
        })));
      radioKeys(seg);
      const mode = h('select', { class: 'select', id: 'wt-mode' }, ...['default', 'acceptEdits', 'plan'].map((m) => h('option', { value: m, text: t('mode.' + m) })));
      mode.value = data.mode;
      mode.addEventListener('change', () => { data.mode = mode.value; });
      return [text, h('div', null, seg), h('div', { class: 'field' }, h('label', { class: 'field__label', for: 'wt-mode', text: t('mode.label') }), mode)];
    }
    if (id === 'start') return startStep(text);
    if (id === 'variables') {
      varsForm = buildVarsForm({ vars: (data.method && data.method.vars) || [], values: data.varValues, api });
      return [text, h('div', { class: 'strong', text: pickText(data.method && data.method.name, getLanguage()) }), varsForm.el, h('div', { class: 'faint small', text: t('walkthrough.startRunNote') })];
    }
    if (id === 'git') {
      const cb = h('input', { type: 'checkbox', id: 'wt-git', checked: data.autoCommit });
      cb.addEventListener('change', () => { data.autoCommit = cb.checked; });
      return [text, h('label', { class: 'toggle', for: 'wt-git' }, cb, h('span', { class: 'toggle__track' }), h('span', { text: t('project.autoCommit') })),
        error ? h('div', { class: 'field__error', attrs: { role: 'alert' }, text: error }) : null];
    }
    return [h('div', { class: 'row' }, h('span', { class: 'badge badge--green' }, h('span', { class: 'badge__dot' }), t('common.ok')),
      h('strong', { text: created ? created.name : '' })), text,
      runError ? h('div', { class: 'field__error', attrs: { role: 'alert' }, text: t('walkthrough.runFailed', { message: runError }) }) : null];
  }

  async function pickMethod(id) {
    if (!id) { data.methodId = ''; data.method = null; data.varValues = {}; error = ''; render(); return; }
    try {
      const m = await api.method.get(id);
      data.methodId = id; data.method = m; data.varValues = runDefaults(m.vars || []); error = '';
    } catch (e) { error = (e && e.message) || t('errors.generic'); }
    render();
  }

  function startStep(text) {
    const list = store.get().methods;
    if (!list.length && !startLoaded) { startLoaded = true; actions.loadMethods({ quiet: true }).then(() => { if (ids()[step] === 'start') render(); }); }
    const L = getLanguage();
    const opt = (id, name, desc, badge) => h('button', {
      class: 'wt-opt' + (data.methodId === id ? ' is-active' : ''), type: 'button',
      attrs: { role: 'radio', 'aria-checked': String(data.methodId === id), tabindex: data.methodId === id ? '0' : '-1' },
      on: { click: () => pickMethod(id) },
    }, h('span', { class: 'row between gap-2' }, h('span', { class: 'strong truncate', text: name }), badge ? h('span', { class: 'badge badge--muted', text: badge }) : null), desc ? h('span', { class: 'muted small wt-opt__desc', text: desc }) : null);
    const group = h('div', { class: 'wt-opts', attrs: { role: 'radiogroup', 'aria-label': t('walkthrough.steps.start') } },
      opt('', t('walkthrough.startEmpty'), t('walkthrough.startEmptyText'), ''),
      ...list.map((m) => opt(m.id, pickText(m.name, L), pickText(m.description, L), t('method.source.' + m.source))));
    radioKeys(group);
    return [text, group, !list.length ? h('div', { class: 'faint small', text: t('walkthrough.startNoMethods') }) : null,
      error ? h('div', { class: 'field__error', attrs: { role: 'alert' }, text: error }) : null];
  }

  function render() {
    const id = ids()[step];
    dlg.setTitle(t('walkthrough.title'));
    const stepper = h('div', { class: 'stepper', attrs: { role: 'list', 'aria-label': t('walkthrough.stepOf', { current: step + 1, total: ids().length }) } },
      ...ids().map((s, i) => h('div', {
        class: 'stepper__step' + (i === step ? ' is-active' : i < step ? ' is-done' : ''),
        attrs: { role: 'listitem', ...(i === step ? { 'aria-current': 'step' } : {}) },
      }, h('span', { class: 'stepper__num', text: i < step ? '\u2713' : String(i + 1) }), h('span', { class: 'truncate', text: t('walkthrough.steps.' + s) }))));
    const content = h('div', { class: 'wt__content' },
      h('div', { class: 'wt__title', text: t('walkthrough.steps.' + id) }), ...stepBody());
    body.replaceChildren(stepper, content);

    const buttons = [];
    if (id !== 'done') {
      buttons.push(h('button', { class: 'btn btn--ghost', type: 'button', text: t('walkthrough.skip'), on: { click: () => dlg.close('skip') } }));
      if (step > 0) buttons.push(h('button', { class: 'btn', type: 'button', text: t('walkthrough.back'), disabled: creating, on: { click: () => { error = ''; step -= 1; render(); } } }));
      const nextBtn = h('button', { class: 'btn btn--primary', type: 'button', disabled: creating || (id === 'prerequisites' && checking), text: id === 'git' ? t('walkthrough.finish') : t('walkthrough.next'), on: { click: next } });
      buttons.push(nextBtn);
    } else {
      buttons.push(h('button', { class: 'btn btn--primary', type: 'button', text: t('common.close'), on: { click: () => { finished = true; actions.walkthroughClosed(); dlg.close('done'); } } }));
    }
    dlg.setFooter(buttons);
    const focusTarget = content.querySelector('input:not([readonly]), select, .segmented__item.is-active, .wt-opt.is-active');
    if (!dlg.dialog.contains(document.activeElement) || document.activeElement === document.body) (focusTarget || buttons[buttons.length - 1]).focus();
  }

  render();
  if (ids()[step] === 'prerequisites') runCheck();
  return dlg;
}
