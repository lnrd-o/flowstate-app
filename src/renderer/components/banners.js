// Banner slot: VPN (danger), agent missing / not signed in (warn), AGY always-proceed (info/warn).
import { h, icon, clear } from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import { activeProject } from '../lib/store.js';

const dismissed = new Set();

/** Pure: which banners apply. Returns [{ id, level, text, actions: ['recheck'|'settings'|'dismiss'] }]. */
export function computeBanners(project, health, chat) {
  const out = [];
  if (health && health.vpn && health.vpn.active) {
    const reach = health.anthropicReachable ? t('health.reachable') : t('health.unreachable');
    out.push({ id: 'vpn', level: 'danger', text: t('banner.vpn') + ' ' + t('health.anthropic') + ': ' + reach, actions: ['recheck'] });
  }
  if (project && health) {
    if (project.agent === 'claude') {
      if (!health.claude.found) out.push({ id: 'claude-missing', level: 'warn', text: t('banner.claudeMissing') + ' ' + t('banner.claudeMissingHint'), actions: ['settings', 'recheck'] });
      else if (health.claude.loggedIn === false || (chat && chat.needsAuth)) out.push({ id: 'claude-login', level: 'warn', text: t('banner.notLoggedIn'), actions: ['signin', 'recheck'] });
    } else if (project.agent === 'agy' && !health.agy.found) {
      out.push({ id: 'agy-missing', level: 'warn', text: t('health.agy') + ': ' + t('health.missing'), actions: ['settings', 'recheck'] });
    }
  }
  if (project && health && project.autoCommit && health.git && !health.git.found) {
    out.push({ id: 'git-missing', level: 'warn', text: t('banner.gitMissing'), actions: ['install:git', 'recheck'] });
  }
  // agy applies edits without asking in every mode except 'plan' (verified: --mode plan blocks writes; agy's own
  // init label "always-proceed" is unreliable, so the banner depends on the project's mode, not on that label).
  if (project && project.agent === 'agy' && project.mode !== 'plan') out.push({ id: 'agy-proceed', level: 'warn', text: t('banner.agyAlwaysProceed'), actions: ['dismiss'] });
  return out.filter((b) => !dismissed.has(b.id));
}

export function mountBanners(el, { store, actions }) {
  const label = (a) => (a === 'recheck' ? t('banner.recheck') : a === 'settings' ? t('banner.browseSettings') : a === 'signin' ? t('banner.signIn')
    : a.startsWith('install:') ? t('prereq.install') : t('banner.dismiss'));
  let sig = '';
  function render() {
    const s = store.get();
    const project = activeProject(s);
    const chat = project ? s.chats[project.id] : null;
    const banners = computeBanners(project, s.health, chat);
    const next = JSON.stringify(banners);
    if (next === sig) return;
    sig = next;
    clear(el);
    for (const b of banners) {
      const acts = h('span', { class: 'banner__actions' });
      for (const a of b.actions) {
        acts.append(h('button', {
          class: 'btn btn--sm', type: 'button', text: label(a),
          on: { click: () => {
            if (a === 'recheck') actions.recheckHealth();
            else if (a === 'settings') actions.openSettings();
            else if (a === 'signin') actions.signIn(activeProject(store.get()).agent);
            else if (a.startsWith('install:')) actions.installPrereq(a.slice(8), { dialog: true });
            else { dismissed.add(b.id); sig = ''; render(); }
          } },
        }));
      }
      el.append(h('div', { class: 'banner banner--' + b.level, attrs: { role: 'alert' } },
        icon(b.level === 'danger' ? 'shield' : 'alert', 'banner__icon'),
        h('span', { class: 'banner__text', text: b.text }), acts));
    }
  }
  store.subscribe((s, prev) => {
    if (s.health !== prev.health || s.activeProjectId !== prev.activeProjectId || s.projects !== prev.projects
      || s.chats !== prev.chats) render();
  });
  render();
  return { update: () => { sig = ''; render(); } };
}
