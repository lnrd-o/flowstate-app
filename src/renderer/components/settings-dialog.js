// Settings dialog: language, theme, code theme (live preview), CLI paths, autoLaunch. Changes apply immediately.
import { h, icon } from '../lib/dom.js';
import { t, onChange } from '../lib/i18n.js';
import { renderMarkdown } from '../lib/markdown.js';
import { openDialog } from './modal.js';
import { statusChip } from '../lib/login-state.js';
import { isGlobalDev } from '../lib/store.js';
import { balanceText, cleanKey, deepseekError } from '../lib/deepseek.js';
import { copyText } from '../lib/clipboard.js';
import { toast } from './modal.js';

export const CODE_THEMES = ['vs-dark', 'github-dark', 'github-light', 'dracula', 'one-dark', 'solarized-dark', 'monokai', 'gold-dark'];

const SAMPLE = [
  '```js',
  '// sample',
  'function greet(name) {',
  '  const n = 42, s = "hi", ok = true;',
  '  return console.log(s + name);',
  '}',
  '```',
].join('\n');

export function openSettingsDialog({ store, actions, onWalkthrough }) {
  let unsub = null;
  const body = h('div', { class: 'settings-form' });
  const closeBtn = h('button', { class: 'btn btn--primary', type: 'button' });
  const dlg = openDialog({
    title: t('settings.title'), body, footer: [closeBtn], size: 'lg',
    onClose: () => { if (unsub) unsub(); },
  });
  closeBtn.addEventListener('click', () => dlg.close('done'));

  // DeepSeek: the key is typed into a password field, sent once to main (encrypted there) and cleared; it is never displayed or kept.
  let dsKey = '';
  let dsMsg = null; // { kind:'ok'|'error', text }
  let dsBusy = false;
  let dsModelsOpen = false;

  function deepseekSection() {
    const st = store.get();
    const on = !!st.settings.deepseekEnabled;
    const ds = st.deepseek;
    const enable = h('input', { type: 'checkbox', id: 'set-ds-enabled', checked: on });
    enable.addEventListener('change', async () => {
      await actions.updateSettings({ deepseekEnabled: enable.checked });
      if (enable.checked) actions.refreshDeepseek(false);
    });
    const head = h('div', { class: 'field settings-ds__head' },
      h('label', { class: 'toggle', for: 'set-ds-enabled' }, enable, h('span', { class: 'toggle__track' }), h('span', { class: 'strong', text: t('deepseek.title') + ' - ' + t('deepseek.enable') })),
      h('div', { class: 'field__hint', text: t('deepseek.hint') }));
    if (!on) return h('div', { class: 'settings-ds' }, head);

    const saveBtn = h('button', { class: 'btn btn--primary', type: 'button', text: t('deepseek.save'), disabled: dsBusy || !dsKey.trim() });
    const input = h('input', {
      class: 'input mono', id: 'set-ds-key', type: 'password', autocomplete: 'off', spellcheck: false, placeholder: t('deepseek.keyPlaceholder'), value: dsKey,
      attrs: { 'aria-describedby': 'set-ds-state', autocapitalize: 'off' },
    });
    input.addEventListener('input', () => { dsKey = input.value; saveBtn.disabled = dsBusy || !input.value.trim(); });
    const save = async () => {
      const key = cleanKey(input.value);
      if (!key) { dsMsg = { kind: 'error', text: t('deepseek.err.invalid-key') }; render(); return; }
      dsBusy = true; dsMsg = null; render();
      let r;
      try { r = await actions.saveDeepseekKey(key); } catch { r = { ok: false, error: 'generic' }; }
      dsKey = ''; // the field is cleared after saving, whatever the result
      dsBusy = false;
      if (r && r.ok) dsMsg = { kind: 'ok', text: t('deepseek.saved') };
      else { const e = deepseekError(r && r.error); dsMsg = { kind: 'error', text: t(e.key, e.vars) }; }
      render();
    };
    saveBtn.addEventListener('click', save);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
    const removeBtn = h('button', { class: 'btn', type: 'button', text: t('deepseek.remove'), disabled: dsBusy || !(ds && ds.configured), on: { click: async () => {
      dsBusy = true; render();
      try { await actions.removeDeepseekKey(); dsMsg = { kind: 'ok', text: t('deepseek.removed') }; } catch { dsMsg = { kind: 'error', text: t('deepseek.err.generic') }; }
      dsBusy = false; render();
    } } });
    const state = h('div', { class: 'settings-ds__state ' + (dsMsg ? 'is-' + dsMsg.kind : 'faint'), id: 'set-ds-state', attrs: { role: 'status' } },
      dsMsg ? dsMsg.text : (ds && ds.configured ? t('deepseek.hasKey') : t('deepseek.noKey')));

    const refresh = h('button', { class: 'btn btn--sm', type: 'button', disabled: dsBusy, on: { click: async () => { dsBusy = true; render(); await actions.refreshDeepseek(true); dsBusy = false; render(); } } }, icon('refresh'), t('deepseek.refresh'));
    let status;
    if (dsBusy && !ds) status = h('div', { class: 'row muted' }, h('span', { class: 'spinner' }), t('deepseek.loading'));
    else if (!ds || !ds.configured) status = h('div', { class: 'faint small', text: t('deepseek.noKey') });
    else if (ds.error && !ds.balance) { const e = deepseekError(ds.error); status = h('div', { class: 'field__error', attrs: { role: 'alert' }, text: t(e.key, e.vars) }); }
    else {
      const b = ds.balance;
      const models = Array.isArray(ds.models) ? ds.models : [];
      const summary = h('summary', { text: dsModelsOpen ? t('deepseek.hideModels') : t('deepseek.showModels', { n: models.length }) });
      const det = h('details', { class: 'settings-ds__models', open: dsModelsOpen }, summary,
        h('ul', { class: 'settings-ds__list' }, ...models.map((m) => h('li', { class: 'settings-ds__model' },
          h('span', { class: 'mono truncate', text: m.id }),
          h('button', { class: 'btn btn--ghost btn--sm', type: 'button', attrs: { 'aria-label': t('deepseek.copyId') + ': ' + m.id }, title: t('deepseek.copyId'), on: { click: async () => { if (await copyText(m.id)) toast(t('deepseek.copied', { id: m.id }), 'success'); } } }, icon('copy'), t('deepseek.copyId'))))));
      det.addEventListener('toggle', () => { dsModelsOpen = det.open; summary.textContent = det.open ? t('deepseek.hideModels') : t('deepseek.showModels', { n: models.length }); });
      status = h('div', { class: 'settings-ds__status' },
        h('div', { class: 'settings-ds__grid' },
          h('div', null, h('div', { class: 'xs faint', text: t('deepseek.balance') }), h('div', { class: 'strong', text: balanceText(b) })),
          h('div', null, h('div', { class: 'xs faint', text: t('deepseek.availability') }), h('span', { class: 'badge ' + (b && b.available ? 'badge--green' : 'badge--red') }, h('span', { class: 'badge__dot' }), b && b.available ? t('deepseek.yes') : t('deepseek.no'))),
          b ? h('div', null, h('div', { class: 'xs faint', text: t('deepseek.granted') + ' / ' + t('deepseek.toppedUp') }), h('div', { text: b.granted + ' / ' + b.toppedUp })) : null),
        models.length ? det : null);
    }
    return h('div', { class: 'settings-ds' }, head,
      h('div', { class: 'field' }, h('label', { class: 'field__label', for: 'set-ds-key', text: t('deepseek.keyLabel') }),
        h('div', { class: 'row' }, input, saveBtn, removeBtn), state),
      h('div', { class: 'card settings-ds__card' }, h('div', { class: 'row between' }, h('span', { class: 'field__label', text: t('deepseek.status') }), refresh), status));
  }

  const field = (label, control, hint) => h('div', { class: 'field' },
    h('label', { class: 'field__label', for: control.id, text: label }), control,
    hint ? h('div', { class: 'field__hint', text: hint }) : null);

  function render() {
    const s = store.get().settings;
    const activeId = document.activeElement && dlg.el.contains(document.activeElement) ? document.activeElement.id : '';
    dlg.setTitle(t('settings.title'));
    closeBtn.textContent = t('common.close');

    const lang = h('select', { class: 'select', id: 'set-language' },
      h('option', { value: 'en', text: t('settings.languageEn') }), h('option', { value: 'es', text: t('settings.languageEs') }));
    lang.value = s.language;
    lang.addEventListener('change', () => actions.updateSettings({ language: lang.value }));

    const theme = h('select', { class: 'select', id: 'set-theme' },
      h('option', { value: 'dark', text: t('settings.themeDark') }), h('option', { value: 'light', text: t('settings.themeLight') }), h('option', { value: 'gold', text: t('settings.themeGold') }));
    theme.value = s.theme;
    theme.addEventListener('change', () => {
      // Pair the matching code palette: Dark Gold <-> gold-dark (only swaps the untouched defaults).
      const cur = code.value;
      if (theme.value === 'gold' && cur === 'github-dark') code.value = 'gold-dark';
      else if (theme.value !== 'gold' && cur === 'gold-dark') code.value = 'github-dark';
      if (code.value !== cur) code.dispatchEvent(new Event('change'));
      actions.updateSettings({ theme: theme.value });
    });

    const code = h('select', { class: 'select', id: 'set-code-theme' },
      ...CODE_THEMES.map((c) => h('option', { value: c, text: c })));
    code.value = s.codeTheme;
    const preview = h('div', { class: 'code-preview', dataset: { codeTheme: s.codeTheme } });
    const paint = (name) => { preview.dataset.codeTheme = name; };
    preview.append(renderMarkdown(SAMPLE, { lineNumbers: false }));
    code.addEventListener('change', () => { paint(code.value); actions.updateSettings({ codeTheme: code.value }); });

    const pathInput = (id, key) => {
      const inp = h('input', { class: 'input mono', id, type: 'text', value: s[key] || '', placeholder: 'C:\\...\\' + (key === 'claudePath' ? 'claude.exe' : 'agy.exe'), spellcheck: false });
      inp.addEventListener('change', () => actions.updateSettings({ [key]: inp.value.trim() || null }));
      return inp;
    };

    const devBox = h('input', { type: 'checkbox', id: 'set-devmode', checked: isGlobalDev(store.get()) });
    devBox.addEventListener('change', () => actions.updateSettings({ developerMode: devBox.checked }));
    const devRow = h('div', { class: 'field settings-dev' },
      h('label', { class: 'toggle', for: 'set-devmode' }, devBox, h('span', { class: 'toggle__track' }), h('span', { class: 'strong', text: t('devmode.title') })),
      h('div', { class: 'field__hint', text: t('devmode.hint') }));

    const auto = h('input', { type: 'checkbox', id: 'set-autolaunch', checked: !!s.autoLaunch });
    auto.addEventListener('change', () => actions.updateSettings({ autoLaunch: auto.checked }));
    const redo = h('button', { class: 'btn', type: 'button', text: t('settings.restartWalkthrough') });
    redo.addEventListener('click', () => { dlg.close('walkthrough'); onWalkthrough(); });

    const accounts = h('div', { class: 'settings-accounts' },
      h('div', { class: 'field__label', text: t('settings.accounts') }),
      h('div', { class: 'card card--flush' }, ...['claude', 'agy'].map((a) => {
        const known = store.get().signedIn[a];
        const c = statusChip(known);
        const acts = known === true
          ? [h('button', { class: 'btn btn--sm', type: 'button', text: t('login.signOut'), on: { click: () => (a === 'claude' ? actions.signOut(a) : actions.openLogin(a)) } })]
          : [h('button', { class: 'btn btn--sm btn--primary', type: 'button', text: t('banner.signIn'), on: { click: () => actions.openLogin(a) } })];
        return h('div', { class: 'list-row' },
          h('div', { class: 'list-row__main' }, h('div', { class: 'list-row__title', text: t('health.' + a) })),
          h('span', { class: 'badge badge--' + c.tone }, h('span', { class: 'badge__dot' }), t(c.key)), ...acts);
      })),
      h('div', { class: 'field__hint', text: t('settings.accountsHint') }));

    body.replaceChildren(
      h('div', { class: 'settings-grid' },
        field(t('settings.language'), lang),
        field(t('settings.theme'), theme)),
      devRow,
      field(t('settings.codeTheme'), code),
      h('div', { class: 'settings-preview-wrap', attrs: { 'aria-label': t('settings.codeTheme') } }, preview),
      accounts,
      deepseekSection(),
      field(t('settings.claudePath'), pathInput('set-claude-path', 'claudePath'), t('settings.pathHint')),
      field(t('settings.agyPath'), pathInput('set-agy-path', 'agyPath'), t('settings.pathHint')),
      h('label', { class: 'toggle', for: 'set-autolaunch' }, auto, h('span', { class: 'toggle__track' }), h('span', { text: t('settings.autoLaunch') })),
      h('div', null, redo));

    if (activeId) { const el = dlg.el.querySelector('#' + activeId); if (el) el.focus(); }
  }

  render();
  const unsubLang = onChange(() => render());
  let lastSigned = store.get().signedIn;
  let lastDs = store.get().deepseek;
  const unsubStore = store.subscribe((st) => {
    if (st.signedIn !== lastSigned) { lastSigned = st.signedIn; render(); }
    else if (st.deepseek !== lastDs) { lastDs = st.deepseek; render(); }
  });
  unsub = () => { unsubLang(); unsubStore(); };
  return dlg;
}
