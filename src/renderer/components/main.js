// Main column: topbar + (chat | placeholder page).
import { h, icon } from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import { activeProject } from '../lib/store.js';
import { mountChat } from './chat.js';
import { mountComposer } from './composer.js';

export function mountMain(el, deps) {
  const { store, actions } = deps;
  const crumbs = h('span', { class: 'topbar__crumbs' });
  const title = h('span', { class: 'topbar__title truncate' });
  const status = h('span', { class: 'badge' });
  const toggleSide = h('button', { class: 'btn btn--ghost btn--icon btn--sm', type: 'button', on: { click: () => actions.toggleSidebar() } }, icon('panelLeft'));
  const toggleArt = h('button', { class: 'btn btn--ghost btn--icon btn--sm', type: 'button', on: { click: () => actions.toggleArtifacts() } }, icon('panelRight'));
  const topbar = h('div', { class: 'topbar' }, crumbs, title, status, h('div', { class: 'topbar__actions' }, toggleSide, toggleArt));

  const chatRoot = h('div', { class: 'chat' });
  const chatInner = h('div', { class: 'chat__list' });
  const composerWrap = h('div', { class: 'composer-wrap' });
  chatRoot.append(chatInner, composerWrap);
  const page = h('div', { class: 'page', hidden: true });
  el.append(topbar, chatRoot, page);

  const chat = mountChat(chatInner, deps);
  const composer = mountComposer(composerWrap, deps);

  function render() {
    const s = store.get();
    const p = activeProject(s);
    const showChat = s.view === 'project' && !!p;
    chatRoot.hidden = !showChat;
    page.hidden = showChat;
    status.hidden = !showChat;
    toggleSide.setAttribute('aria-label', t('nav.toggleSidebar'));
    toggleSide.title = t('nav.toggleSidebar');
    toggleArt.setAttribute('aria-label', t('nav.toggleArtifacts'));
    toggleArt.title = t('nav.toggleArtifacts');
    const section = s.view === 'prompts' ? t('nav.prompts') : s.view === 'methodologies' ? t('nav.methodologies') : t('nav.projects');
    crumbs.replaceChildren(section, ' ', h('span', { class: 'sep', text: '/' }));
    if (showChat) {
      const running = !!(s.chats[p.id] && s.chats[p.id].running);
      title.textContent = p.name;
      status.className = 'badge ' + (running ? 'badge--purple' : 'badge--green');
      status.replaceChildren(h('span', { class: 'badge__dot' }), running ? t('agent.running') : t('agent.idle'));
    } else {
      title.textContent = s.view === 'project' ? t('app.name') : section;
      page.replaceChildren(buildPage(s, p));
    }
  }

  function buildPage(s, p) {
    if (s.view === 'prompts' || s.view === 'methodologies') {
      return h('div', { class: 'page__inner' }, h('div', { class: 'empty-state' },
        h('div', { class: 'empty-state__icon' }, icon(s.view === 'prompts' ? 'file' : 'layers', 'icon--lg')),
        h('div', { class: 'empty-state__title', text: t('nav.comingSoon') }),
        h('div', { class: 'empty-state__text', text: (s.view === 'prompts' ? t('nav.prompts') : t('nav.methodologies')) + ': ' + t('nav.comingSoonText') })));
    }
    return h('div', { class: 'page__inner' }, h('div', { class: 'empty-state' },
      h('div', { class: 'empty-state__icon' }, icon('folder', 'icon--lg')),
      h('div', { class: 'empty-state__title', text: t('project.noProjects') }),
      h('div', { class: 'empty-state__text', text: t('project.noProjectsText') }),
      h('button', { class: 'btn btn--primary', type: 'button', on: { click: () => actions.openWalkthrough() } }, icon('plus'), t('nav.newProject'))));
  }

  let sig = '';
  function update(force) {
    const s = store.get();
    const p = activeProject(s);
    const signature = JSON.stringify([s.view, p && [p.id, p.name], p && !!(s.chats[p.id] && s.chats[p.id].running), !!p]) + t('nav.projects');
    if (!force && signature === sig) return;
    sig = signature;
    render();
  }
  store.subscribe(() => update(false));
  update(true);
  return {
    chat, composer,
    update() { update(true); chat.update(); composer.update(); },
  };
}
