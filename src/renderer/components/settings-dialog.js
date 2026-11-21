// Settings dialog: language, theme, code theme (live preview), CLI paths, autoLaunch. Changes apply immediately.
import { h } from '../lib/dom.js';
import { t, onChange } from '../lib/i18n.js';
import { renderMarkdown } from '../lib/markdown.js';
import { openDialog } from './modal.js';

export const CODE_THEMES = ['vs-dark', 'github-dark', 'github-light', 'dracula', 'one-dark', 'solarized-dark', 'monokai'];

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
      h('option', { value: 'dark', text: t('settings.themeDark') }), h('option', { value: 'light', text: t('settings.themeLight') }));
    theme.value = s.theme;
    theme.addEventListener('change', () => actions.updateSettings({ theme: theme.value }));

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

    const auto = h('input', { type: 'checkbox', id: 'set-autolaunch', checked: !!s.autoLaunch });
    auto.addEventListener('change', () => actions.updateSettings({ autoLaunch: auto.checked }));
    const redo = h('button', { class: 'btn', type: 'button', text: t('settings.restartWalkthrough') });
    redo.addEventListener('click', () => { dlg.close('walkthrough'); onWalkthrough(); });

    body.replaceChildren(
      h('div', { class: 'settings-grid' },
        field(t('settings.language'), lang),
        field(t('settings.theme'), theme)),
      field(t('settings.codeTheme'), code),
      h('div', { class: 'settings-preview-wrap', attrs: { 'aria-label': t('settings.codeTheme') } }, preview),
      field(t('settings.claudePath'), pathInput('set-claude-path', 'claudePath'), t('settings.pathHint')),
      field(t('settings.agyPath'), pathInput('set-agy-path', 'agyPath'), t('settings.pathHint')),
      h('label', { class: 'toggle', for: 'set-autolaunch' }, auto, h('span', { class: 'toggle__track' }), h('span', { text: t('settings.autoLaunch') })),
      h('div', null, redo));

    if (activeId) { const el = dlg.el.querySelector('#' + activeId); if (el) el.focus(); }
  }

  render();
  unsub = onChange(() => render());
  return dlg;
}
