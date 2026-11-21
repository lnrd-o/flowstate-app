// Artifacts "Dashboard" tab: python missing -> setup (venv + deps) -> pick app, start/stop, embedded Streamlit iframe.
import { h, icon } from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import { activeProject } from '../lib/store.js';
import { installJobs, dashboardJobs } from '../lib/install-state.js';
import { createLogBox } from './log-box.js';
import { toast } from './modal.js';

/** Pure: which stage the dashboard tab is in. */
export function dashboardStage(status) {
  if (!status) return 'loading';
  if (!status.python || !status.python.found) return 'python';
  if (!status.venv || !status.deps) return 'setup';
  return status.running && status.url ? 'running' : 'ready';
}

export function mountDashboardTab(el, { store, api, actions }) {
  const head = h('div', { class: 'dash__head' });
  const frames = new Map(); // projectId -> { url, host, frame }
  const framesEl = h('div', { class: 'dash__frames' });
  el.append(h('div', { class: 'dash' }, head, framesEl));
  const selected = new Map(); // projectId -> app rel
  const busy = new Set();
  let logs = [];
  let shown = null;

  const stat = (pid) => store.get().dashboard[pid];

  function setBusy(pid, on) { if (on) busy.add(pid); else busy.delete(pid); render(); }

  async function setup(pid) {
    dashboardJobs.start(pid);
    setBusy(pid, true);
    try {
      const r = await api.dashboard.setup(pid);
      dashboardJobs.finish(pid, r && r.ok === false ? t('dashboard.setupFailed') : null);
      toast(r && r.ok === false ? t('dashboard.setupFailed') : t('dashboard.setupDone'), r && r.ok === false ? 'error' : 'success');
    } catch (e) {
      dashboardJobs.finish(pid, (e && e.message) || t('dashboard.setupFailed'));
      toast((e && e.message) || t('dashboard.setupFailed'), 'error');
    }
    setBusy(pid, false);
    actions.refreshDashboard(pid);
  }

  async function start(pid, app) {
    setBusy(pid, true);
    try {
      const r = await api.dashboard.start(pid, app);
      actions.setDashboard(pid, { ...(stat(pid) || {}), running: true, url: r.url, app });
    } catch (e) {
      toast((e && e.message) || t('dashboard.startFailed'), 'error');
    }
    setBusy(pid, false);
    actions.refreshDashboard(pid);
  }

  async function stop(pid) {
    setBusy(pid, true);
    try { await api.dashboard.stop(pid); } catch (e) { toast((e && e.message) || t('errors.generic'), 'error'); }
    setBusy(pid, false);
    actions.refreshDashboard(pid);
  }

  async function copyUrl(url) {
    try { await navigator.clipboard.writeText(url); toast(t('dashboard.urlCopied'), 'success'); } catch { toast(url, 'warn'); }
  }

  function card(titleKey, textKey, ...extra) {
    return h('div', { class: 'card dash__card' },
      h('div', { class: 'card__title', text: t(titleKey) }),
      h('p', { class: 'muted', text: t(textKey) }), ...extra);
  }

  const askAgent = () => h('button', { class: 'btn btn--ghost btn--sm', type: 'button', on: { click: () => actions.openTemplate('python-dashboard') } },
    icon('sparkles'), t('dashboard.askAgent'));

  function buildHead(p) {
    const pid = p.id;
    const st = stat(pid);
    const stage = dashboardStage(st);
    const isBusy = busy.has(pid);
    for (const l of logs) l.destroy();
    logs = [];
    if (stage === 'loading') return [h('div', { class: 'row muted dash__pad' }, h('span', { class: 'spinner' }), t('common.loading'))];
    if (stage === 'python') {
      const job = installJobs.get('python');
      const lb = createLogBox(installJobs, 'python');
      logs.push(lb);
      return [card('dashboard.pythonTitle', 'dashboard.pythonText',
        h('div', { class: 'row wrap' },
          h('button', { class: 'btn btn--primary', type: 'button', disabled: job.running, on: { click: () => actions.installPrereq('python', { dialog: false }) } }, icon('download'), t('dashboard.installPython')),
          h('button', { class: 'btn', type: 'button', on: { click: () => actions.recheckHealth().then(() => actions.refreshDashboard(pid)) } }, t('banner.recheck'))),
        lb.el)];
    }
    if (stage === 'setup') {
      const job = dashboardJobs.get(pid);
      const lb = createLogBox(dashboardJobs, pid);
      logs.push(lb);
      return [card('dashboard.setupTitle', 'dashboard.setupText',
        h('div', { class: 'row wrap' },
          h('span', { class: 'badge ' + (st.venv ? 'badge--green' : 'badge--amber') }, h('span', { class: 'badge__dot' }), t('dashboard.venv')),
          h('span', { class: 'badge ' + (st.deps ? 'badge--green' : 'badge--amber') }, h('span', { class: 'badge__dot' }), t('dashboard.deps'))),
        h('div', { class: 'row wrap' },
          h('button', { class: 'btn btn--primary', type: 'button', disabled: job.running || isBusy, on: { click: () => setup(pid) } },
            job.running ? h('span', { class: 'spinner' }) : icon('layers'), t('dashboard.setup'))),
        lb.el), h('div', { class: 'dash__pad' }, askAgent())];
    }
    const apps = st.apps || [];
    if (stage === 'running') {
      return [h('div', { class: 'dash__bar' },
        h('div', { class: 'row wrap gap-2 grow' },
          h('span', { class: 'badge badge--green' }, h('span', { class: 'badge__dot' }), t('dashboard.running')),
          h('span', { class: 'mono small truncate dash__url', title: st.url, text: st.url })),
        h('div', { class: 'row wrap gap-1' },
          h('button', { class: 'btn btn--sm btn--danger', type: 'button', disabled: isBusy, on: { click: () => stop(pid) } }, icon('stop'), t('dashboard.stop')),
          h('button', { class: 'btn btn--sm', type: 'button', on: { click: () => { const f = frames.get(pid); if (f) f.frame.src = f.url; } } }, icon('refresh'), t('dashboard.reload')),
          h('button', { class: 'btn btn--sm', type: 'button', on: { click: () => { window.open(st.url, '_blank'); } } }, icon('external'), t('dashboard.openBrowser')),
          h('button', { class: 'btn btn--sm', type: 'button', on: { click: () => copyUrl(st.url) } }, icon('copy'), t('dashboard.copyUrl'))))];
    }
    // ready
    if (!apps.length) {
      return [card('dashboard.noAppsTitle', 'dashboard.noAppsText', h('div', null, askAgent()))];
    }
    const cur = apps.includes(selected.get(pid)) ? selected.get(pid) : (apps.includes(st.app) ? st.app : apps[0]);
    selected.set(pid, cur);
    const sel = h('select', { class: 'select grow', id: 'dash-app', attrs: { 'aria-label': t('dashboard.app') } }, ...apps.map((a) => h('option', { value: a, text: a })));
    sel.value = cur;
    sel.addEventListener('change', () => selected.set(pid, sel.value));
    return [h('div', { class: 'card dash__card' },
      h('div', { class: 'card__title', text: t('dashboard.readyTitle') }),
      h('div', { class: 'field' }, h('label', { class: 'field__label', for: 'dash-app', text: t('dashboard.app') }), h('div', { class: 'row' }, sel,
        h('button', { class: 'btn btn--primary', type: 'button', disabled: isBusy, on: { click: () => start(pid, sel.value) } },
          isBusy ? h('span', { class: 'spinner' }) : icon('play'), t('dashboard.start')))),
      h('div', null, askAgent()))];
  }

  function syncFrames(p) {
    const st = p ? stat(p.id) : null;
    const running = !!(p && dashboardStage(st) === 'running');
    for (const [pid, f] of frames) {
      const s2 = stat(pid);
      if (!(s2 && s2.running && s2.url) || (s2.url !== f.url)) { f.host.remove(); frames.delete(pid); }
    }
    if (running && !frames.has(p.id)) {
      const frame = h('iframe', {
        class: 'dash__frame', title: t('dashboard.frameTitle', { name: p.name }), src: st.url,
        sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups',
      });
      const host = h('div', { class: 'dash__host' }, frame);
      framesEl.append(host);
      frames.set(p.id, { url: st.url, host, frame });
    }
    for (const [pid, f] of frames) f.host.hidden = !(p && pid === p.id);
    framesEl.hidden = !running;
  }

  function render() {
    const p = activeProject(store.get());
    if (!p) {
      head.replaceChildren(h('div', { class: 'empty-state' },
        h('div', { class: 'empty-state__icon' }, icon('layers', 'icon--lg')),
        h('div', { class: 'empty-state__title', text: t('files.noProject') })));
      syncFrames(null);
      return;
    }
    if (p.id !== shown) { shown = p.id; if (!stat(p.id)) actions.refreshDashboard(p.id); }
    const focusId = document.activeElement && head.contains(document.activeElement) ? document.activeElement.id : '';
    head.replaceChildren(...buildHead(p));
    if (focusId) { const f = head.querySelector('#' + focusId); if (f) f.focus(); }
    syncFrames(p);
    el.classList.toggle('is-running', dashboardStage(stat(p.id)) === 'running');
  }

  let pyRunning = false;
  installJobs.subscribe((id) => {
    if (id !== 'python') return;
    const r = installJobs.get('python').running;
    if (r !== pyRunning) { pyRunning = r; render(); }
  });
  return { render, update: render, refresh: render };
}
