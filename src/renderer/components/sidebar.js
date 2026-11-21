// Rail + sidebar: workspace header, search, projects, placeholders, footer status.
import { h, icon, clear } from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import { filterProjects } from '../lib/store.js';
import { openProjectMenu } from './project-menu.js';

export function mountRail(el, { store, actions }) {
  const render = () => {
    const s = store.get();
    clear(el);
    const btn = (view, ic, label) => h('button', {
      class: 'rail__btn' + (s.view === view ? ' is-active' : ''), type: 'button',
      attrs: { 'aria-label': label, title: label, 'aria-pressed': String(s.view === view) },
      on: { click: () => actions.setView(view) },
    }, icon(ic));
    el.append(
      btn('project', 'message', t('nav.projects')),
      btn('prompts', 'file', t('nav.prompts')),
      btn('methodologies', 'layers', t('nav.methodologies')),
      h('div', { class: 'rail__spacer' }),
      h('button', {
        class: 'rail__btn', type: 'button', attrs: { 'aria-label': t('nav.settings'), title: t('nav.settings') },
        on: { click: () => actions.openSettings() },
      }, icon('settings')),
    );
  };
  let sig = '';
  const update = () => {
    const s = store.get();
    const next = s.view + '|' + t('nav.projects');
    if (next === sig) return;
    sig = next;
    render();
  };
  store.subscribe(update);
  return { update: () => { sig = ''; update(); } };
}

export function mountSidebar(el, { store, actions }) {
  const avatar = h('span', { class: 'workspace-switcher__avatar', attrs: { 'aria-hidden': 'true' }, text: 'F' });
  const wsName = h('span', { class: 'grow truncate' });
  const header = h('div', { class: 'sidebar__header' },
    h('div', { class: 'workspace-switcher' }, avatar, wsName));
  const scroll = h('div', { class: 'sidebar__scroll' });
  const footer = h('div', { class: 'sidebar__footer' });
  el.append(header, scroll, footer);

  function renderScroll(s) {
    clear(scroll);
    const list = filterProjects(s.projects, s.search);
    scroll.append(h('div', { class: 'section-head' },
      h('div', { class: 'nav-section-label', text: t('nav.projects') }),
      h('button', {
        class: 'btn btn--ghost btn--icon btn--sm', type: 'button',
        attrs: { 'aria-label': t('nav.newProject'), title: t('nav.newProject') },
        on: { click: () => actions.openWalkthrough() },
      }, icon('plus'))));
    if (!list.length) {
      scroll.append(h('div', { class: 'faint small side-empty', text: s.search ? t('nav.noMatches') : t('project.noProjects') }));
    }
    for (const p of list) {
      const running = !!(s.chats[p.id] && s.chats[p.id].running);
      const active = s.view === 'project' && p.id === s.activeProjectId;
      const runWait = !!(s.runs[p.id] && s.runs[p.id].status === 'waiting');
      const kebab = h('button', {
        class: 'btn btn--ghost btn--icon btn--sm nav-kebab', type: 'button',
        attrs: { 'aria-label': t('menu.projectActions', { name: p.name }), title: t('menu.projectActions', { name: p.name }), 'aria-haspopup': 'menu', 'aria-expanded': 'false' },
      }, icon('more'));
      kebab.addEventListener('click', (e) => { e.stopPropagation(); openProjectMenu(kebab, p.id, { store, actions }); });
      const item = h('button', {
        class: 'nav-item' + (active ? ' is-active' : ''), type: 'button', title: p.path,
        attrs: active ? { 'aria-current': 'true' } : null,
        on: { click: () => actions.selectProject(p.id) },
      },
      h('span', { class: 'nav-item__icon' }, icon('folder')),
      h('span', { class: 'nav-item__label truncate', text: p.name }),
      running ? h('span', { class: 'nav-item__dot nav-item__dot--green', attrs: { role: 'img', 'aria-label': t('agent.running') }, title: t('agent.running') }) : null,
      runWait ? h('span', { class: 'nav-item__dot nav-item__dot--amber', attrs: { role: 'img', 'aria-label': t('method.run.status.waiting') }, title: t('method.run.status.waiting') }) : null);
      item.addEventListener('contextmenu', (e) => { e.preventDefault(); openProjectMenu(kebab, p.id, { store, actions }); });
      scroll.append(h('div', { class: 'nav-row' }, item, kebab));
    }
    scroll.append(
      h('button', { class: 'btn btn--sm new-project-btn', type: 'button', on: { click: () => actions.openWalkthrough() } },
        icon('plus'), t('nav.newProject')),
      h('div', { class: 'nav-section-label', text: t('nav.manage') }),
      h('button', {
        class: 'nav-item' + (s.view === 'prompts' ? ' is-active' : ''), type: 'button',
        on: { click: () => actions.setView('prompts') },
      }, h('span', { class: 'nav-item__icon' }, icon('file')), h('span', { class: 'nav-item__label', text: t('nav.prompts') })),
      h('button', {
        class: 'nav-item' + (s.view === 'methodologies' ? ' is-active' : ''), type: 'button',
        on: { click: () => actions.setView('methodologies') },
      }, h('span', { class: 'nav-item__icon' }, icon('layers')), h('span', { class: 'nav-item__label', text: t('nav.methodologies') })),
    );
  }

  function renderFooter(s) {
    clear(footer);
    const hl = s.health;
    const online = !!hl && !hl.vpn.active && hl.anthropicReachable;
    const vpn = !!hl && hl.vpn.active;
    footer.append(
      h('div', { class: 'row', attrs: { role: 'status' } },
        h('span', { class: 'dot ' + (online ? 'dot--green' : 'dot--red') }),
        h('span', { class: 'muted', text: online ? t('nav.connected') : t('nav.offline') })),
      h('div', { class: 'row' },
        h('span', { class: 'badge ' + (vpn ? 'badge--red' : 'badge--muted') }, h('span', { class: 'badge__dot' }),
          vpn ? t('health.vpnActive') : t('health.vpnInactive'))),
      h('button', { class: 'btn btn--ghost btn--sm settings-btn', type: 'button', on: { click: () => actions.openSettings() } },
        icon('settings'), t('nav.settings')));
  }

  function renderHeader() {
    wsName.textContent = t('app.name');
    el.setAttribute('aria-label', t('nav.workspace'));
  }

  let sig = '';
  function update() {
    const s = store.get();
    const signature = JSON.stringify([
      s.view, s.activeProjectId, s.search,
      s.projects.map((p) => [p.id, p.name, !!(s.chats[p.id] && s.chats[p.id].running), s.runs[p.id] && s.runs[p.id].status]),
      s.health && [s.health.vpn.active, s.health.anthropicReachable],
    ]) + t('nav.projects');
    if (signature === sig) return;
    sig = signature;
    renderHeader();
    renderScroll(s);
    renderFooter(s);
  }
  store.subscribe(update);
  update();
  return {
    update: () => { sig = ''; update(); },
  };
}
