// Help > About FlowState and Help > Keyboard shortcuts.
import { h, icon } from '../lib/dom.js';
import { t, onChange } from '../lib/i18n.js';
import { MENU, flattenMenu } from '../../shared/menu.js';
import { accelKeys, buildMenuView, shortcutGroups } from '../lib/menu-state.js';
import { isDev } from '../lib/store.js';
import { copyText } from '../lib/clipboard.js';
import { openDialog, toast } from './modal.js';

const LINKS = ['help.docs', 'help.releases', 'help.report'];

export function openAboutDialog({ store, api }) {
  const body = h('div', { class: 'about' }, h('div', { class: 'row muted' }, h('span', { class: 'spinner' }), t('common.loading')));
  const closeBtn = h('button', { class: 'btn btn--primary', type: 'button', text: t('common.close') });
  let info = null;
  let unsub = () => {};
  const dlg = openDialog({ title: t('about.title'), body, footer: [closeBtn], onClose: () => unsub() });
  closeBtn.addEventListener('click', () => dlg.close('done'));

  function render() {
    dlg.setTitle(t('about.title'));
    closeBtn.textContent = t('common.close');
    if (!info) return;
    const row = (label, value) => h('div', { class: 'about__row' }, h('dt', { class: 'faint small', text: label }), h('dd', { class: 'about__val', text: String(value ?? '-') }));
    const links = flattenMenu(MENU).filter((i) => LINKS.includes(i.id));
    body.replaceChildren(
      h('div', { class: 'about__head' }, h('span', { class: 'about__logo', attrs: { 'aria-hidden': 'true' }, text: 'F' }),
        h('div', null, h('div', { class: 'about__name', text: info.name || t('app.name') }), h('div', { class: 'muted', text: t('about.version', { version: info.version }) }))),
      h('p', { class: 'muted small', text: t('app.tagline') }),
      h('dl', { class: 'about__grid' },
        row(t('about.electron'), info.electron), row(t('about.chrome'), info.chrome), row(t('about.node'), info.node),
        row(t('about.platform'), [info.platform, info.arch].filter(Boolean).join(' / '))),
      h('div', { class: 'field' }, h('div', { class: 'field__label', text: t('about.userData') }),
        h('div', { class: 'row gap-2' }, h('code', { class: 'about__path mono small truncate', title: info.userData, text: info.userData }),
          h('button', { class: 'btn btn--sm', type: 'button', on: { click: async () => toast((await copyText(info.userData)) ? t('about.copied') : t('errors.generic'), 'success') } }, icon('copy'), t('about.copy')))),
      h('div', { class: 'field' }, h('div', { class: 'field__label', text: t('about.links') }),
        h('div', { class: 'row gap-2 wrap' }, ...links.map((l) => h('button', { class: 'btn btn--sm', type: 'button', on: { click: () => window.open(l.url, '_blank') } }, icon('external'), t(l.label))))));
  }

  Promise.resolve().then(() => (api.app && api.app.info ? api.app.info() : null)).then((i) => {
    info = i || { name: t('app.name'), version: '-', userData: '-' };
    store.set({ appInfo: info });
    render();
  }).catch(() => { info = { name: t('app.name'), version: '-', userData: '-' }; render(); });
  unsub = onChange(() => render());
  return dlg;
}

export function openShortcutsDialog({ store, api }) {
  const body = h('div', { class: 'shortcuts' });
  const closeBtn = h('button', { class: 'btn btn--primary', type: 'button', text: t('common.close') });
  let unsub = () => {};
  const dlg = openDialog({ title: t('shortcuts.title'), body, footer: [closeBtn], size: 'lg', onClose: () => unsub() });
  closeBtn.addEventListener('click', () => dlg.close('done'));
  let model = { items: MENU, state: { packaged: true } };

  function render() {
    dlg.setTitle(t('shortcuts.title'));
    closeBtn.textContent = t('common.close');
    const s = store.get();
    const view = buildMenuView(model, { t, platform: s.win.platform, developerMode: isDev(s), theme: s.settings.theme, packaged: model.state ? model.state.packaged : true });
    const groups = shortcutGroups(view);
    body.replaceChildren(
      h('p', { class: 'muted small', text: t('shortcuts.intro') }),
      groups.length ? h('div', { class: 'shortcuts__groups' }, ...groups.map((g) => h('section', { class: 'shortcuts__group', attrs: { 'aria-label': g.label } },
        h('h3', { class: 'shortcuts__title', text: g.label }),
        h('dl', { class: 'shortcuts__list' }, ...g.items.flatMap((it) => [
          h('dt', { class: 'shortcuts__label', text: it.label }),
          h('dd', { class: 'shortcuts__keys' }, ...accelKeys(it.accel).flatMap((k, i, all) => [h('kbd', { class: 'kbd', text: k }), i < all.length - 1 ? h('span', { class: 'shortcuts__plus', attrs: { 'aria-hidden': 'true' }, text: '+' }) : null])),
        ]))))) : h('div', { class: 'faint', text: t('shortcuts.none') }));
  }

  render();
  Promise.resolve().then(() => (api.menu && api.menu.model ? api.menu.model() : null)).then((m) => { if (m && Array.isArray(m.items)) { model = m; render(); } }).catch(() => {});
  unsub = onChange(() => render());
  return dlg;
}
