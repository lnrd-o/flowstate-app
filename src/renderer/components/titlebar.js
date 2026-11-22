// Custom title bar: logo + breadcrumb (left), search / command box (centre), status chips + native controls space (right).
// The bar is a drag region; every interactive child opts out with -webkit-app-region: no-drag (see styles/app.css).
import { h, icon } from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import { activeProject, isDev } from '../lib/store.js';
import { agentIcon } from './agent-icon.js';
import { cssColorToHexOr } from '../lib/colors.js';
import { computeInsets, needsOwnControls, normalizePlatform, statusChips, TITLEBAR_HEIGHT } from '../lib/titlebar-state.js';

export function mountTitlebar(el, { store, api, actions }) {
  const logo = h('span', { class: 'titlebar__logo', attrs: { 'aria-hidden': 'true' }, text: 'F' });
  const name = h('span', { class: 'titlebar__name' });
  const crumbs = h('span', { class: 'titlebar__crumbs truncate' });
  const left = h('div', { class: 'titlebar__left' }, logo, name, crumbs);

  const search = h('input', { class: 'input', type: 'search', id: 'project-search', autocomplete: 'off', spellcheck: false });
  const kbd = h('span', { class: 'kbd', attrs: { 'aria-hidden': 'true' } });
  const box = h('div', { class: 'search-box titlebar__search' }, icon('search', 'search-box__icon'), search, kbd);
  const center = h('div', { class: 'titlebar__center' }, box);
  search.addEventListener('input', () => store.set({ search: search.value }));
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { search.value = ''; store.set({ search: '' }); search.blur(); }
  });

  const agentChip = h('span', { class: 'titlebar__agent', hidden: true });
  const modePill = h('button', { class: 'titlebar__mode', type: 'button', attrs: { 'aria-pressed': 'true' } });
  modePill.addEventListener('click', () => actions.updateSettings({ developerMode: !isDev(store.get()) }));
  const chipsEl = h('div', { class: 'titlebar__chips' });
  const controls = h('div', { class: 'titlebar__controls', hidden: true, attrs: { role: 'group' } });
  const right = h('div', { class: 'titlebar__right' }, agentChip, modePill, chipsEl, controls);
  el.classList.add('titlebar');
  el.append(left, center, right);

  const ctl = (id, ic, action) => h('button', { class: 'titlebar__ctl titlebar__ctl--' + id, type: 'button', dataset: { action }, on: { click: () => { try { api.window.action(action); } catch { /* ignore */ } } } }, icon(ic));
  const bMin = ctl('min', 'minus', 'minimize');
  const bMax = ctl('max', 'maximize', 'toggle-maximize');
  const bClose = ctl('close', 'x', 'close');
  controls.append(bMin, bMax, bClose);

  function applyWindow() {
    const w = store.get().win;
    const platform = normalizePlatform(w.platform);
    const root = document.documentElement;
    for (const p of ['win32', 'darwin', 'linux']) root.classList.toggle('platform-' + p, p === platform);
    root.classList.toggle('is-fullscreen', !!w.fullscreen);
    const ins = computeInsets({ platform, overlay: w.overlay, fullscreen: w.fullscreen, controlsInset: w.controlsInset });
    el.style.setProperty('--tb-left', ins.left + 'px');
    el.style.setProperty('--tb-right', ins.right + 'px');
    controls.hidden = !needsOwnControls({ platform, overlay: w.overlay, fullscreen: w.fullscreen });
    bMax.replaceChildren(icon(w.maximized ? 'restore' : 'maximize'));
  }

  /** Make the native window-controls overlay match the theme (reads the computed bar colours). */
  function syncTheme() {
    const cs = getComputedStyle(el);
    const color = cssColorToHexOr(cs.backgroundColor, '#1b1b1f');
    const symbolColor = cssColorToHexOr(cs.color, '#ececf1');
    try {
      if (api.window && api.window.setTheme) Promise.resolve(api.window.setTheme({ color, symbolColor, height: TITLEBAR_HEIGHT })).catch(() => {});
    } catch { /* ignore */ }
  }

  function renderChips(s) {
    const p = activeProject(s);
    const list = statusChips({ health: s.health, remote: p && s.remote[p.id], signedIn: s.signedIn, project: p });
    chipsEl.replaceChildren(...list.map((c) => {
      const label = t(c.key, c.vars ? { agent: t('agent.' + c.vars.agent) } : undefined);
      const inner = [h('span', { class: 'badge__dot' }), h('span', { class: 'titlebar__chip-text', text: label })];
      if (c.action === 'signin') {
        return h('button', {
          class: 'badge badge--' + c.tone + ' titlebar__chip titlebar__chip--btn', type: 'button', title: t('banner.signIn'),
          attrs: { 'aria-label': label + '. ' + t('banner.signIn') }, on: { click: () => actions.openLogin(c.vars.agent) },
        }, ...inner);
      }
      return h('span', { class: 'badge badge--' + c.tone + ' titlebar__chip titlebar__chip--' + c.id, title: label }, ...inner);
    }));
  }

  function renderAgentAndMode(s) {
    const p = s.view === 'project' ? activeProject(s) : null;
    agentChip.hidden = !p;
    if (p) {
      const running = !!(s.chats[p.id] && s.chats[p.id].running);
      agentChip.className = 'titlebar__agent titlebar__agent--' + p.agent + (running ? ' is-running' : '');
      agentChip.title = t('agent.' + p.agent) + ' - ' + (running ? t('agent.running') : t('agent.idle'));
      agentChip.replaceChildren(agentIcon(p.agent, { size: 14, state: running ? 'running' : 'idle' }), h('span', { class: 'titlebar__agent-name', text: t('agent.' + p.agent) }));
    }
    const dev = isDev(s);
    modePill.setAttribute('aria-pressed', String(dev));
    modePill.className = 'titlebar__mode' + (dev ? ' is-dev' : '');
    modePill.title = t('devmode.pillTitle');
    modePill.setAttribute('aria-label', t('devmode.title') + ': ' + (dev ? t('devmode.on') : t('devmode.off')));
    modePill.replaceChildren(icon(dev ? 'code' : 'smile'), h('span', { class: 'titlebar__mode-text', text: dev ? t('devmode.pillDev') : t('devmode.pillSimple') }));
  }

  function renderText(s) {
    const p = activeProject(s);
    const section = s.view === 'prompts' ? t('nav.prompts') : s.view === 'methodologies' ? t('nav.methodologies') : t('nav.projects');
    const last = s.view === 'project' && p ? p.name : '';
    name.textContent = t('app.name');
    crumbs.replaceChildren(h('span', { class: 'sep', text: '/' }), section, ...(last ? [h('span', { class: 'sep', text: '/' }), h('strong', { text: last })] : []));
    crumbs.title = last ? section + ' / ' + last : section;
    search.placeholder = t('nav.searchPlaceholder');
    search.setAttribute('aria-label', t('nav.search'));
    kbd.textContent = (store.get().win.platform === 'darwin' ? 'Cmd' : 'Ctrl') + ' K';
    el.setAttribute('aria-label', t('app.name'));
    bMin.title = bMin.ariaLabel = t('titlebar.minimize');
    const maxed = s.win.maximized;
    bMax.title = bMax.ariaLabel = maxed ? t('titlebar.restore') : t('titlebar.maximize');
    bClose.title = bClose.ariaLabel = t('titlebar.close');
    if (search.value !== s.search) search.value = s.search;
  }

  let sig = '';
  function update(force) {
    const s = store.get();
    const p = activeProject(s);
    const next = JSON.stringify([isDev(s), p && !!(s.chats[p.id] && s.chats[p.id].running), s.view, p && [p.id, p.name, p.agent], s.search, s.win, s.signedIn, p && s.remote[p.id] && s.remote[p.id].running,
      s.health && [s.health.vpn && s.health.vpn.active, s.health.anthropicReachable]]) + t('nav.projects');
    if (!force && next === sig) return;
    sig = next;
    applyWindow();
    renderText(s);
    renderAgentAndMode(s);
    renderChips(s);
  }
  store.subscribe(() => update(false));
  update(true);

  return {
    update: () => update(true),
    syncTheme,
    focusSearch() { search.focus(); search.select(); },
  };
}
