// First-run setup wizard: language first, then welcome, how you use it, look, AI helpers, tools, extras, storage, done.
// Pure step logic lives in lib/setup-steps.js. Everything applies immediately (language, mode, theme) and is saved through settings.
import { h, icon, radioKeys } from '../lib/dom.js';
import { t, onChange } from '../lib/i18n.js';
import { openDialog, confirmDialog } from './modal.js';
import { statusChip } from '../lib/login-state.js';
import { isGlobalDev } from '../lib/store.js';
import { installJobs } from '../lib/install-state.js';
import { cleanKey, deepseekError } from '../lib/deepseek.js';
import { SETUP_STEPS, THEMES, stepProgress, nextIndex, prevIndex, stepError, toolRows, helperRows, helpersState } from '../lib/setup-steps.js';

function chip(tone, text) { return h('span', { class: 'badge badge--' + tone }, h('span', { class: 'badge__dot' }), text); }

export function openSetupWizard({ store, api, actions }) {
  let step = 0;
  let checking = false;
  let defaultDir = '';
  let dsKey = '';
  let dsMsg = null;
  let finished = false;
  const body = h('div', { class: 'wt' });
  const dlg = openDialog({ title: t('setup.title'), body, footer: [], size: 'lg', dismissible: false, onClose: () => cleanup() });

  const ids = SETUP_STEPS;
  const cur = () => ids[step];

  const unsubLang = onChange(() => render());
  let lastSig = store.get().signedIn;
  let lastHealth = store.get().health;
  const unsubStore = store.subscribe((s) => {
    const changed = s.signedIn !== lastSig || s.health !== lastHealth;
    lastSig = s.signedIn; lastHealth = s.health;
    if (changed && ['helpers', 'tools'].includes(cur())) render();
  });
  const unsubJobs = installJobs.subscribe(() => { if (cur() === 'tools') render(); });
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    const modals = document.querySelectorAll('.modal');
    if (modals[modals.length - 1] !== dlg.el) return;
    leave();
  };
  document.addEventListener('keydown', onKey, true);
  function cleanup() { unsubLang(); unsubStore(); unsubJobs(); document.removeEventListener('keydown', onKey, true); if (!finished) { finished = true; actions.walkthroughClosed(); } }

  async function leave() {
    const ok = await confirmDialog({ title: t('setup.leaveTitle'), message: t('setup.leaveText'), confirmLabel: t('setup.leaveYes') });
    if (ok) dlg.close('leave');
  }

  async function runCheck() {
    checking = true; render();
    try { actions.setHealth(await api.health.check()); } catch { /* keep previous */ }
    try { await actions.refreshLoginStatus(); } catch { /* ignore */ }
    checking = false; render();
  }

  async function enter() {
    const id = cur();
    render();
    if (id === 'helpers' || id === 'tools') runCheck();
    if (id === 'storage' && !defaultDir) {
      try { defaultDir = (await api.projects.defaultDir()) || ''; } catch { defaultDir = ''; }
      if (cur() === 'storage') render();
    }
    if (id === 'extras' && store.get().settings.deepseekEnabled) actions.refreshDeepseek(false);
  }

  async function next() {
    if (stepError(cur(), { language: store.get().settings.language })) return;
    if (cur() === 'language') await actions.updateSettings({ language: store.get().settings.language });
    step = nextIndex(step); enter();
  }

  async function finish(createProject) {
    finished = true;
    await actions.updateSettings({ walkthroughDone: true });
    dlg.close('done');
    if (createProject) actions.openWalkthrough();
  }

  // ---- step bodies ----
  function radioCard(on, label, onPick, ...kids) {
    return h('button', { class: 'wt-mode' + (on ? ' is-active' : ''), type: 'button', attrs: { role: 'radio', 'aria-checked': String(on), 'aria-label': label, tabindex: on ? '0' : '-1' }, on: { click: onPick } }, ...kids);
  }

  function languageStep() {
    const lang = store.get().settings.language;
    const card = (code, name) => {
      const el = radioCard(lang === code, name, () => { if (store.get().settings.language !== code) actions.updateSettings({ language: code }); },
        h('span', { class: 'wt-mode__ic' }, icon('globe', 'icon--lg')), h('span', { class: 'wt-mode__title strong', text: name }));
      el.classList.add('wt-lang');
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && el.classList.contains('is-active')) { e.preventDefault(); next(); } });
      return el;
    };
    const group = h('div', { class: 'wt-modes', attrs: { role: 'radiogroup', 'aria-label': 'Choose your language / Elige tu idioma' } },
      card('en', t('settings.languageEn')), card('es', t('settings.languageEs')));
    radioKeys(group);
    return [h('h3', { class: 'wt__h wt__h--center', text: 'Choose your language / Elige tu idioma' }), group];
  }

  function modeStep() {
    const dev = isGlobalDev(store.get());
    const card = (isDevCard, ic, titleKey, textKey) => radioCard(dev === isDevCard, t(titleKey), () => { actions.updateSettings({ developerMode: isDevCard }).then(() => render()); },
      h('span', { class: 'wt-mode__ic' }, icon(ic, 'icon--lg')), h('span', { class: 'wt-mode__title strong', text: t(titleKey) }), h('span', { class: 'wt-mode__text muted small', text: t(textKey) }));
    const group = h('div', { class: 'wt-modes', attrs: { role: 'radiogroup', 'aria-label': t('setup.steps.mode') } },
      card(false, 'smile', 'devmode.simpleTitle', 'devmode.simpleText'), card(true, 'code', 'devmode.devTitle', 'devmode.devText'));
    radioKeys(group);
    return [h('p', { text: t('setup.modeText') }), group];
  }

  function lookStep() {
    const theme = THEMES.includes(store.get().settings.theme) ? store.get().settings.theme : 'dark';
    const names = { dark: 'settings.themeDark', light: 'settings.themeLight', gold: 'settings.themeGold' };
    const group = h('div', { class: 'wt-themes', attrs: { role: 'radiogroup', 'aria-label': t('settings.theme') } },
      ...THEMES.map((th) => radioCard(theme === th, t(names[th]), () => { actions.updateSettings({ theme: th }).then(() => render()); },
        h('span', { class: 'wt-prev wt-prev--' + th, attrs: { 'aria-hidden': 'true' } }, h('span', { class: 'wt-prev__bar' }), h('span', { class: 'wt-prev__line' }), h('span', { class: 'wt-prev__line wt-prev__line--short' }), h('span', { class: 'wt-prev__btn' })),
        h('span', { class: 'wt-mode__title strong', text: t(names[th]) }))));
    radioKeys(group);
    return [h('p', { text: t('setup.lookText') }), group];
  }

  function helpersStep() {
    const signed = store.get().signedIn;
    const oc = store.get().health && store.get().health.opencode;
    const rows = helperRows(signed).map((r) => {
      if (r.id === 'opencode' && !(oc && oc.found)) { // optional third helper: not installed -> install hint, no sign-in button
        return h('div', { class: 'list-row' }, h('div', { class: 'list-row__main list-row__main--wrap' }, h('div', { class: 'list-row__title', text: t('agent.opencode') }),
          h('div', { class: 'list-row__sub list-row__sub--wrap', text: t('walkthrough.hint.opencode') })),
          h('button', { class: 'btn btn--sm', type: 'button', text: t('sources.installOpencode'), on: { click: async () => { await actions.installOpencode(); render(); } } }));
      }
      const c = statusChip(r.signed);
      return h('div', { class: 'list-row' },
        h('div', { class: 'list-row__main list-row__main--wrap' }, h('div', { class: 'list-row__title', text: t('agent.' + r.id) }),
          h('div', { class: 'list-row__sub list-row__sub--wrap', text: t('setup.helpers.' + r.id) })),
        chip(c.tone, t(c.key)),
        r.signed === true || r.id === 'opencode' ? null : h('button', { class: 'btn btn--sm btn--primary', type: 'button', text: t('banner.signIn'), on: { click: () => actions.openLogin(r.id) } }));
    });
    return [h('p', { text: t('setup.helpersText') }), h('div', { class: 'card card--flush' }, ...rows),
      h('div', { class: helpersState(signed) === 'ready' ? 'faint small' : 'wt-note', attrs: { role: 'status' }, text: t(helpersState(signed) === 'ready' ? 'setup.helpersReady' : 'setup.helpersLater') }),
      h('div', null, h('button', { class: 'btn btn--sm', type: 'button', disabled: checking, text: t('banner.recheck'), on: { click: runCheck } }))];
  }

  function toolsStep() {
    const rows = toolRows(store.get().health).map((r) => {
      const running = installJobs.get(r.id).running;
      return h('div', { class: 'list-row' },
        h('div', { class: 'list-row__main list-row__main--wrap' }, h('div', { class: 'list-row__title', text: t('health.' + r.id) }),
          h('div', { class: 'list-row__sub list-row__sub--wrap', text: t(r.reason) + (r.ok && r.version ? ' (' + r.version + ')' : '') })),
        r.ok === null ? chip('muted', t('login.unknown')) : chip(r.ok ? 'green' : 'amber', t(r.ok ? 'health.found' : 'health.missing')),
        r.ok === false ? h('button', { class: 'btn btn--sm btn--primary', type: 'button', disabled: running, text: running ? t('prereq.installing') : t('prereq.install'), on: { click: () => actions.installPrereq(r.id) } }) : null);
    });
    return [h('p', { text: t('setup.toolsText') }),
      checking && !store.get().health ? h('div', { class: 'row muted' }, h('span', { class: 'spinner' }), t('common.loading')) : h('div', { class: 'card card--flush' }, ...rows),
      h('div', null, h('button', { class: 'btn btn--sm', type: 'button', disabled: checking, text: t('banner.recheck'), on: { click: runCheck } }))];
  }

  function extrasStep() {
    const st = store.get();
    const ds = st.deepseek;
    const enable = h('input', { type: 'checkbox', id: 'setup-ds', checked: !!st.settings.deepseekEnabled });
    enable.addEventListener('change', async () => { await actions.updateSettings({ deepseekEnabled: enable.checked }); if (enable.checked) actions.refreshDeepseek(false); render(); });
    const key = h('input', { class: 'input mono', id: 'setup-ds-key', type: 'password', autocomplete: 'off', spellcheck: false, placeholder: t('deepseek.keyPlaceholder'), value: dsKey, disabled: !st.settings.deepseekEnabled });
    key.addEventListener('input', () => { dsKey = key.value; save.disabled = !cleanKey(dsKey); });
    const save = h('button', { class: 'btn', type: 'button', text: t('deepseek.save'), disabled: !cleanKey(dsKey) || !st.settings.deepseekEnabled, on: { click: async () => {
      const k = cleanKey(dsKey);
      if (!k) { dsMsg = { kind: 'error', text: t('deepseek.err.invalid-key') }; render(); return; }
      let r; try { r = await actions.saveDeepseekKey(k); } catch { r = { ok: false, error: 'generic' }; }
      dsKey = '';
      if (r && r.ok) dsMsg = { kind: 'ok', text: t('deepseek.saved') }; else { const e = deepseekError(r && r.error); dsMsg = { kind: 'error', text: t(e.key, e.vars) }; }
      render();
    } } });
    return [h('p', { text: t('setup.extrasText') }),
      h('div', { class: 'card wt-extra' }, h('div', { class: 'row gap-2' }, icon('gauge'), h('strong', { text: t('setup.extras.usageTitle') })), h('div', { class: 'muted small', text: t('setup.extras.usageText') })),
      h('div', { class: 'card wt-extra' },
        h('div', { class: 'row between gap-2' }, h('strong', { text: t('deepseek.title') }), h('span', { class: 'badge badge--muted', text: t('setup.optional') })),
        h('div', { class: 'muted small', text: t('deepseek.hint') }),
        h('label', { class: 'toggle', for: 'setup-ds' }, enable, h('span', { class: 'toggle__track' }), h('span', { text: t('deepseek.enable') })),
        h('div', { class: 'field' }, h('label', { class: 'field__label', for: 'setup-ds-key', text: t('deepseek.keyLabel') }), h('div', { class: 'row' }, key, save)),
        h('div', { class: dsMsg && dsMsg.kind === 'error' ? 'field__error' : 'faint small', attrs: { role: 'status' }, text: dsMsg ? dsMsg.text : (ds && ds.configured ? t('deepseek.hasKey') : t('setup.extras.skip')) }))];
  }

  function storageStep() {
    return [h('p', { text: t('setup.storageText') }),
      h('div', { class: 'wt-note wt-note--data', attrs: { role: 'note' } }, icon('folder'),
        h('span', null, h('strong', { text: t('setup.storage.where') + ' ' }), defaultDir ? h('span', { class: 'mono', text: defaultDir }) : h('span', { class: 'spinner' }))),
      h('div', { class: 'wt-note wt-note--data', attrs: { role: 'note' } }, icon('shield'), h('span', { text: t('setup.storage.inside') }))];
  }

  function stepBody() {
    switch (cur()) {
      case 'language': return languageStep();
      case 'welcome': return [h('h3', { class: 'wt__h', text: t('app.name') }), h('p', { text: t('setup.welcomeText') }), h('p', { class: 'muted', text: t('app.tagline') })];
      case 'mode': return modeStep();
      case 'look': return lookStep();
      case 'helpers': return helpersStep();
      case 'tools': return toolsStep();
      case 'extras': return extrasStep();
      case 'storage': return storageStep();
      default: return [h('div', { class: 'row' }, chip('green', t('common.ok'))), h('p', { text: t('setup.doneText') })];
    }
  }

  function render() {
    const id = cur();
    const pr = stepProgress(step, ids.length);
    dlg.setTitle(t('setup.title'));
    const stepper = h('div', { class: 'stepper', attrs: { role: 'list', 'aria-label': t('walkthrough.stepOf', { current: pr.current, total: pr.total }) } },
      ...ids.map((s, i) => h('div', { class: 'stepper__step' + (i === step ? ' is-active' : i < step ? ' is-done' : ''), attrs: { role: 'listitem', ...(i === step ? { 'aria-current': 'step' } : {}) } },
        h('span', { class: 'stepper__num', text: i < step ? '\u2713' : String(i + 1) }), h('span', { class: 'truncate', text: t('setup.steps.' + s) }))));
    const content = h('div', { class: 'wt__content' },
      h('div', { class: 'faint small', text: t('walkthrough.stepOf', { current: pr.current, total: pr.total }) }),
      h('div', { class: 'wt__title', text: t('setup.steps.' + id) }), ...stepBody());
    body.replaceChildren(stepper, content);
    const buttons = [h('button', { class: 'btn btn--ghost', type: 'button', text: t('setup.skipSetup'), on: { click: leave } })];
    if (step > 0) buttons.push(h('button', { class: 'btn', type: 'button', text: t('walkthrough.back'), on: { click: () => { step = prevIndex(step); enter(); } } }));
    if (id === 'done') {
      buttons.push(h('button', { class: 'btn', type: 'button', text: t('setup.finishOnly'), on: { click: () => finish(false) } }));
      buttons.push(h('button', { class: 'btn btn--primary', type: 'button', text: t('setup.createFirst'), on: { click: () => finish(true) } }));
    } else {
      if (!['language', 'welcome'].includes(id)) buttons.push(h('button', { class: 'btn btn--ghost', type: 'button', text: t('setup.skipStep'), on: { click: () => { step = nextIndex(step); enter(); } } }));
      buttons.push(h('button', { class: 'btn btn--primary', type: 'button', text: t('walkthrough.next'), on: { click: next } }));
    }
    dlg.setFooter(buttons);
    const focusTarget = content.querySelector('[role="radio"].is-active, input:not([disabled]):not([type="checkbox"])');
    if (!dlg.dialog.contains(document.activeElement) || document.activeElement === document.body || ['language', 'mode', 'look'].includes(id)) {
      if (!(document.activeElement && content.contains(document.activeElement))) (focusTarget || buttons[buttons.length - 1]).focus();
    }
  }

  enter();
  return dlg;
}
