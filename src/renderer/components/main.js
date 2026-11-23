// Main column: topbar + (chat | placeholder page).
import { h, icon } from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import { activeProject, isDev } from '../lib/store.js';
import { mountChat } from './chat.js';
import { mountComposer } from './composer.js';
import { mountThreadsBar } from './threads-bar.js';
import { mountAfterTurnBar } from './work-easier.js';
import { mountPrompts } from './prompts.js';
import { mountMethods } from './methods.js';
import { mountRunPanel } from './run-panel.js';
import { mountTasksPanel } from './tasks-panel.js';
import { openProjectMenu } from './project-menu.js';
import { copyText } from '../lib/clipboard.js';
import { toast } from './modal.js';

export function mountMain(el, deps) {
  const { store, actions } = deps;
  const crumbs = h('span', { class: 'topbar__crumbs' });
  const title = h('span', { class: 'topbar__title truncate' });
  const status = h('span', { class: 'badge' });
  const savedBadge = h('span', { class: 'badge badge--muted topbar__saved', hidden: true, attrs: { tabindex: '0' } }, icon('folder'), h('span', { class: 'topbar__saved-text' }));
  const toggleSide = h('button', { class: 'btn btn--ghost btn--icon btn--sm', type: 'button', on: { click: () => actions.toggleSidebar() } }, icon('panelLeft'));
  const toggleArt = h('button', { class: 'btn btn--ghost btn--icon btn--sm', type: 'button', on: { click: () => actions.toggleArtifacts() } }, icon('panelRight'));
  const menuBtn = h('button', { class: 'btn btn--ghost btn--icon btn--sm', type: 'button', attrs: { 'aria-haspopup': 'menu', 'aria-expanded': 'false' } }, icon('more'));
  menuBtn.addEventListener('click', () => { const id = store.get().activeProjectId; if (id) openProjectMenu(menuBtn, id, { store, actions }); });
  const topbar = h('div', { class: 'topbar' }, crumbs, title, status, savedBadge, h('div', { class: 'topbar__actions' }, menuBtn, toggleSide, toggleArt));
  const subbar = h('div', { class: 'subbar', hidden: true });
  const remoteCard = h('div', { class: 'remote-card-wrap', hidden: true });

  const chatRoot = h('div', { class: 'chat' });
  const runHost = h('div', { class: 'run-host' });
  const chatInner = h('div', { class: 'chat__list' });
  const composerWrap = h('div', { class: 'composer-wrap' });
  const threadsHost = h('div');
  const afterHost = h('div');
  chatRoot.append(threadsHost, runHost, chatInner, afterHost, composerWrap);
  const page = h('div', { class: 'page', hidden: true });
  const promptsHost = h('div', { class: 'prompts-host' });
  el.append(topbar, subbar, remoteCard, chatRoot, page);
  const prompts = mountPrompts(promptsHost, deps);
  const methodsHost = h('div', { class: 'prompts-host methods-host' });
  const methods = mountMethods(methodsHost, deps);
  const runPanel = mountRunPanel(runHost, deps);
  const tasksHost = h('div', { class: 'prompts-host tasks-host' });
  const tasksPanel = mountTasksPanel(tasksHost, deps);

  mountThreadsBar(threadsHost, deps);
  mountAfterTurnBar(afterHost, deps);
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
    menuBtn.hidden = !p || s.view !== 'project';
    if (p) { menuBtn.setAttribute('aria-label', t('menu.projectActions', { name: p.name })); menuBtn.title = t('menu.projectActions', { name: p.name }); }
    renderRemote(s, showChat ? p : null);
    const section = s.view === 'prompts' ? t('nav.prompts') : s.view === 'methodologies' ? t('nav.methodologies') : s.view === 'tasks' ? t('nav.tasks') : t('nav.projects');
    const saved = showChat && !!(s.storeStatus[p.id] && s.storeStatus[p.id].exists);
    savedBadge.hidden = !saved;
    savedBadge.title = t('pdata.badgeTip');
    savedBadge.setAttribute('aria-label', t('pdata.badge') + '. ' + t('pdata.badgeTip'));
    savedBadge.lastChild.textContent = t('pdata.badge');
    crumbs.replaceChildren(section, ' ', h('span', { class: 'sep', text: '/' }));
    if (showChat) {
      const running = !!(s.chats[p.id] && s.chats[p.id].running);
      title.textContent = p.name;
      status.className = 'badge ' + (running ? 'badge--accent' : 'badge--green');
      status.replaceChildren(h('span', { class: 'badge__dot' }), running ? t('agent.running') : t('agent.idle'));
    } else {
      title.textContent = s.view === 'project' ? t('app.name') : section;
      if (s.view === 'prompts') { page.classList.add('page--fill'); page.replaceChildren(promptsHost); prompts.render(); }
      else if (s.view === 'methodologies') { page.classList.add('page--fill'); page.replaceChildren(methodsHost); methods.render(); }
      else if (s.view === 'tasks') { page.classList.add('page--fill'); page.replaceChildren(tasksHost); tasksPanel.render(); }
      else { page.classList.remove('page--fill'); page.replaceChildren(buildPage(s, p)); }
    }
  }

  function remoteBadge(r, supported) {
    if (!supported) return h('span', { class: 'badge badge--muted' }, h('span', { class: 'badge__dot' }), t('remote.unsupported'));
    if (r.busy) return h('span', { class: 'badge badge--amber' }, h('span', { class: 'spinner' }), t(r.running ? 'remote.stopping' : 'remote.starting'));
    return h('span', { class: 'badge ' + (r.running ? 'badge--green' : 'badge--muted') }, h('span', { class: 'badge__dot' }), r.running ? t('remote.on') : t('remote.off'));
  }

  function renderRemote(s, p) {
    subbar.hidden = !p || !isDev(s); // Simple mode: no remote-control row
    remoteCard.hidden = true;
    if (!p || !isDev(s)) return;
    const r = s.remote[p.id] || { running: false, supported: true };
    const supported = r.supported !== false;
    const cb = h('input', { type: 'checkbox', id: 'remote-toggle', checked: !!r.running, disabled: !supported || !!r.busy, attrs: { 'aria-describedby': 'remote-help' } });
    cb.addEventListener('change', () => { cb.checked = !!(store.get().remote[p.id] || {}).running; actions.toggleRemote(p.id); });
    const tip = t('remote.tooltip');
    subbar.replaceChildren(
      h('label', { class: 'toggle', for: 'remote-toggle', title: tip }, cb, h('span', { class: 'toggle__track' }), h('span', { text: t('remote.label') })),
      remoteBadge(r, supported),
      h('span', { class: 'faint small subbar__help', id: 'remote-help', text: t('remote.tooltipShort') }));
    if (r.running && r.info) {
      const url = (String(r.info).match(/https:\/\/\S+/) || [])[0];
      remoteCard.hidden = false;
      remoteCard.replaceChildren(h('details', { class: 'card remote-card', open: true },
        h('summary', { class: 'remote-card__sum', text: t('remote.details') }),
        h('pre', { class: 'remote-card__info mono', text: String(r.info) }),
        url ? h('div', { class: 'row wrap gap-2' },
          h('button', { class: 'btn btn--sm', type: 'button', on: { click: () => window.open(url, '_blank') } }, icon('external'), t('remote.openUrl')),
          h('button', { class: 'btn btn--sm', type: 'button', on: { click: async () => toast((await copyText(url)) ? t('prompts.copied') : t('errors.generic'), 'success') } }, icon('copy'), t('dashboard.copyUrl'))) : null));
    }
  }

  function buildPage(s, p) {
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
    const signature = JSON.stringify([isDev(s), s.view, p && [p.id, p.name, p.mode], p && !!(s.storeStatus[p.id] && s.storeStatus[p.id].exists), p && !!(s.chats[p.id] && s.chats[p.id].running), !!p, p && s.remote[p.id]]) + t('nav.projects');
    if (!force && signature === sig) return;
    sig = signature;
    render();
  }
  store.subscribe((s, prev) => {
    update(false);
    if (s.view === 'methodologies' && (s.methods !== prev.methods || s.editing !== prev.editing || s.activeProjectId !== prev.activeProjectId || s.projects !== prev.projects)) methods.render();
    if (s.view === 'prompts' && (s.templates !== prev.templates || s.selectedTemplate !== prev.selectedTemplate || s.activeProjectId !== prev.activeProjectId)) prompts.render();
  });
  update(true);
  return {
    chat, composer,
    update() { update(true); chat.update(); composer.update(); methods.update(); runPanel.update(); },
  };
}
