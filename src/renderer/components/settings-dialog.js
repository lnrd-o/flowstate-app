// Settings dialog: language, theme, code theme (live preview), CLI paths, autoLaunch. Changes apply immediately.
import { h } from '../lib/dom.js';
import { t, onChange } from '../lib/i18n.js';
import { renderMarkdown } from '../lib/markdown.js';
import { openDialog } from './modal.js';
import { statusChip } from '../lib/login-state.js';
import { isDev } from '../lib/store.js';

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

    const devBox = h('input', { type: 'checkbox', id: 'set-devmode', checked: isDev(store.get()) });
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
      field(t('settings.claudePath'), pathInput('set-claude-path', 'claudePath'), t('settings.pathHint')),
      field(t('settings.agyPath'), pathInput('set-agy-path', 'agyPath'), t('settings.pathHint')),
      h('label', { class: 'toggle', for: 'set-autolaunch' }, auto, h('span', { class: 'toggle__track' }), h('span', { text: t('settings.autoLaunch') })),
      h('div', null, redo));

    if (activeId) { const el = dlg.el.querySelector('#' + activeId); if (el) el.focus(); }
  }

  render();
  const unsubLang = onChange(() => render());
  let lastSigned = store.get().signedIn;
  const unsubStore = store.subscribe((st) => { if (st.signedIn !== lastSigned) { lastSigned = st.signedIn; render(); } });
  unsub = () => { unsubLang(); unsubStore(); };
  return dlg;
}
