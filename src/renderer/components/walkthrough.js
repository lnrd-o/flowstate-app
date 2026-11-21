// New-project walkthrough: welcome -> prerequisites -> folder -> agent -> git -> done.
import { h, radioKeys } from '../lib/dom.js';
import { t, onChange } from '../lib/i18n.js';
import { openDialog } from './modal.js';

export const STEPS = ['welcome', 'prerequisites', 'folder', 'agent', 'git', 'done'];

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
  const data = { path: '', name: '', agent: 'claude', mode: 'default', autoCommit: true };
  let step = 0;
  let health = store.get().health;
  let checking = false;
  let error = '';
  let creating = false;
  let created = null;
  let finished = false;

  const body = h('div', { class: 'wt' });
  const dlg = openDialog({
    title: t('walkthrough.title'), body, footer: [], size: 'lg',
    onClose: () => { unsub(); if (!finished) actions.walkthroughClosed(); },
  });
  const unsub = onChange(() => render());

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
      step = STEPS.length - 1;
    } catch (e) {
      error = (e && e.message) || t('errors.generic');
    }
    creating = false; render();
  }

  function next() {
    if (step === 2 && !data.path) { error = t('walkthrough.folderRequired'); render(); return; }
    error = '';
    if (STEPS[step] === 'git') { create(); return; }
    step = Math.min(step + 1, STEPS.length - 1);
    if (STEPS[step] === 'prerequisites') runCheck(); else render();
  }

  function stepBody() {
    const id = STEPS[step];
    const text = h('p', { text: t('walkthrough.' + id + 'Text') });
    if (id === 'welcome') return [h('h3', { class: 'wt__h', text: t('app.name') }), text, h('p', { class: 'muted', text: t('app.tagline') })];
    if (id === 'prerequisites') {
      const rows = prereqRows(health).map((r) => h('div', { class: 'list-row' },
        h('div', { class: 'list-row__main' },
          h('div', { class: 'list-row__title', text: t('health.' + r.id) }),
          h('div', { class: 'list-row__sub' }, r.ok ? (r.version || t('health.found')) : t('walkthrough.hint.' + r.id)),
          r.extra ? h('div', { class: 'list-row__sub', text: t('health.' + r.extra) }) : null),
        h('span', { class: 'badge ' + (r.ok ? 'badge--green' : 'badge--red') }, h('span', { class: 'badge__dot' }), r.ok ? t('health.found') : t('health.missing'))));
      const vpn = health && health.vpn.active;
      return [text,
        checking || !health ? h('div', { class: 'row muted' }, h('span', { class: 'spinner' }), t('common.loading')) : h('div', { class: 'card card--flush' }, ...rows),
        health ? h('div', { class: 'row' },
          h('span', { class: 'badge ' + (vpn ? 'badge--red' : 'badge--green') }, h('span', { class: 'badge__dot' }), vpn ? t('health.vpnActive') : t('health.vpnInactive')),
          h('span', { class: 'badge ' + (health.anthropicReachable ? 'badge--green' : 'badge--red') }, h('span', { class: 'badge__dot' }),
            t('health.anthropic') + ': ' + (health.anthropicReachable ? t('health.reachable') : t('health.unreachable')))) : null,
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
    if (id === 'git') {
      const cb = h('input', { type: 'checkbox', id: 'wt-git', checked: data.autoCommit });
      cb.addEventListener('change', () => { data.autoCommit = cb.checked; });
      return [text, h('label', { class: 'toggle', for: 'wt-git' }, cb, h('span', { class: 'toggle__track' }), h('span', { text: t('project.autoCommit') })),
        error ? h('div', { class: 'field__error', attrs: { role: 'alert' }, text: error }) : null];
    }
    return [h('div', { class: 'row' }, h('span', { class: 'badge badge--green' }, h('span', { class: 'badge__dot' }), t('common.ok')),
      h('strong', { text: created ? created.name : '' })), text];
  }

  function render() {
    const id = STEPS[step];
    dlg.setTitle(t('walkthrough.title'));
    const stepper = h('div', { class: 'stepper', attrs: { role: 'list', 'aria-label': t('walkthrough.stepOf', { current: step + 1, total: STEPS.length }) } },
      ...STEPS.map((s, i) => h('div', {
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
    const focusTarget = content.querySelector('input:not([readonly]), select, .segmented__item.is-active');
    if (!dlg.dialog.contains(document.activeElement) || document.activeElement === document.body) (focusTarget || buttons[buttons.length - 1]).focus();
  }

  render();
  if (STEPS[step] === 'prerequisites') runCheck();
  return dlg;
}
