// Run panel docked above the chat: live read-only graph, step list, interactive waiting cards, summary.
import { pickText } from '../../shared/methodology.js';
import { h, icon } from '../lib/dom.js';
import { t, getLanguage } from '../lib/i18n.js';
import { activeProject } from '../lib/store.js';
import { runSteps, formatDuration, countStates, isActiveRun } from '../lib/method-utils.js';
import { createGraph } from './graph.js';
import { agentIcon } from './agent-icon.js';

const STATUS_TONE = { running: 'badge--accent', waiting: 'badge--amber', done: 'badge--green', error: 'badge--red', stopped: 'badge--muted' };
const STEP_TONE = { running: 'badge--accent', waiting: 'badge--amber', done: 'badge--green', error: 'badge--red', warn: 'badge--amber', skipped: 'badge--muted', pending: 'badge--muted' };
const clock = (ms) => (ms ? new Date(ms).toLocaleTimeString(getLanguage(), { hour12: false }) : '');
const quote = (a) => (/[\s"]/.test(a) || a === '' ? JSON.stringify(a) : a);

export function mountRunPanel(el, { store, api, actions }) {
  const dismissed = new Set();
  let collapsed = false;
  let shownRunId = null;
  let waitKey = '';
  let tick = null;
  let loadingFor = null;
  let lastCurrent = null;

  const statusBadge = h('span', { class: 'badge' });
  const title = h('strong', { class: 'rp__title truncate' });
  const elapsed = h('span', { class: 'faint small mono rp__elapsed' });
  const btnStop = h('button', { class: 'btn btn--sm btn--danger', type: 'button', on: { click: () => { const s = cur(); if (s) actions.stopRun(s); } } }, icon('stop'), h('span'));
  const btnFold = h('button', { class: 'btn btn--ghost btn--icon btn--sm', type: 'button', on: { click: () => { collapsed = !collapsed; render(); } } });
  const btnClose = h('button', { class: 'btn btn--ghost btn--icon btn--sm', type: 'button', on: { click: () => { const s = cur(); if (s) { dismissed.add(s.runId); render(); } } } }, icon('x'));
  const agentHost = h('span', { class: 'rp__agent' });
  const head = h('div', { class: 'rp__head' }, agentHost, title, statusBadge, elapsed, h('span', { class: 'grow' }), btnStop, btnFold, btnClose);
  const waitHost = h('div', { class: 'rp__wait' });
  const summaryHost = h('div', { class: 'rp__summary' });
  const graph = createGraph({ editable: false });
  const canvas = h('div', { class: 'rp__graph' }, graph.el);
  const steps = h('ol', { class: 'rp__steps', attrs: { 'aria-label': '' } });
  const stepsWrap = h('div', { class: 'rp__stepswrap' }, h('div', { class: 'rp__stepshead small strong' }), steps);
  const live = h('div', { class: 'sr-only', attrs: { role: 'status', 'aria-live': 'polite' } });
  const bodyEl = h('div', { class: 'rp__body' }, canvas, stepsWrap);
  const root = h('section', { class: 'rp', hidden: true }, head, summaryHost, waitHost, bodyEl, live);
  el.replaceChildren(root);

  const cur = () => { const s = store.get(); const p = activeProject(s); return p ? s.runs[p.id] || null : null; };
  const methodOf = (st) => store.get().methodCache[st.methodologyId] || null;
  const nodeTitle = (st, id) => { const m = methodOf(st); const n = m && m.nodes.find((q) => q.id === id); return n ? (pickText(n.title, getLanguage()) || id) : id; };

  function ensureMethod(st) {
    if (methodOf(st) || loadingFor === st.methodologyId) return;
    loadingFor = st.methodologyId;
    api.method.get(st.methodologyId).then((m) => { store.set((s) => ({ methodCache: { ...s.methodCache, [m.id]: m } })); }).catch(() => {}).finally(() => { loadingFor = null; });
  }

  function waitingCard(st) {
    const w = st.waiting;
    const card = h('div', { class: 'rp__card', attrs: { role: 'group', 'aria-label': t('method.run.waitingFor', { name: nodeTitle(st, w.nodeId) }) } });
    const send = (response) => actions.respondRun(st, w.nodeId, response);
    const label = t('method.run.wait.' + w.kind, { name: nodeTitle(st, w.nodeId) });
    card.append(h('div', { class: 'row gap-2' }, h('span', { class: 'badge badge--amber' }, icon(w.kind === 'ask-user' ? 'question' : w.kind === 'checkpoint' ? 'flag' : 'terminal'), label)));
    if (w.text) card.append(h('div', { class: 'rp__text', text: w.text }));
    if (w.kind === 'ask-user') {
      const inp = h('input', { class: 'input', type: 'text', autocomplete: 'off', attrs: { 'aria-label': t('method.run.answer') }, placeholder: t('method.run.answer') });
      const go = () => { if (!inp.value.trim()) { inp.focus(); return; } send({ answer: inp.value }); };
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
      card.append(h('div', { class: 'row gap-2' }, inp, h('button', { class: 'btn btn--primary', type: 'button', text: t('method.run.submit'), on: { click: go } })));
    } else {
      if (w.kind === 'command-confirm' && w.command) {
        card.append(h('pre', { class: 'rp__cmd mono', tabindex: '0', attrs: { 'aria-label': t('method.run.commandLabel') }, text: [w.command.exe, ...(w.command.args || []).map(quote)].join(' ') }));
      }
      const yes = w.kind === 'checkpoint' ? t('method.run.approve') : t('method.run.runCommand');
      const no = w.kind === 'checkpoint' ? t('method.run.reject') : t('method.run.deny');
      card.append(h('div', { class: 'row gap-2' },
        h('button', { class: 'btn btn--primary', type: 'button', text: yes, on: { click: () => send({ approve: true }) } }),
        h('button', { class: 'btn', type: 'button', text: no, on: { click: () => send({ approve: false }) } })));
    }
    return card;
  }

  function summary(st) {
    const counts = countStates(st);
    const dur = formatDuration((st.endedAt || Date.now()) - st.startedAt);
    const bits = ['done', 'warn', 'error', 'skipped'].filter((k) => counts[k]).map((k) => `${counts[k]} ${t('method.state.' + k).toLowerCase()}`);
    return h('div', { class: 'rp__sum' + (st.status === 'error' ? ' is-error' : '') },
      h('div', { class: 'row gap-2 wrap' }, h('strong', { text: t('method.run.summary.' + st.status) }), h('span', { class: 'muted small', text: t('method.run.duration', { time: dur }) }), bits.length ? h('span', { class: 'muted small', text: bits.join(' \u00b7 ') }) : null),
      st.error ? h('div', { class: 'rp__err', attrs: { role: 'alert' } }, icon('alert'), h('span', { text: st.error })) : null,
      h('div', { class: 'row gap-2 wrap' },
        h('button', { class: 'btn btn--sm', type: 'button', on: { click: () => actions.openMethodEditorById(st.methodologyId) } }, icon('edit'), t('method.run.openEditor')),
        h('button', { class: 'btn btn--sm', type: 'button', on: { click: () => actions.runMethod(st.methodologyId, st.projectId) } }, icon('play'), t('method.run.again')),
        h('button', { class: 'btn btn--ghost btn--sm', type: 'button', text: t('method.run.dismiss'), on: { click: () => { dismissed.add(st.runId); render(); } } })));
  }

  function renderSteps(st) {
    const list = runSteps(st);
    steps.setAttribute('aria-label', t('method.run.steps'));
    stepsWrap.querySelector('.rp__stepshead').textContent = t('method.run.steps');
    steps.replaceChildren(...list.map((s) => h('li', { class: 'rp__step rp__step--' + s.state },
      h('div', { class: 'row gap-2' }, h('span', { class: 'badge ' + STEP_TONE[s.state] }, h('span', { class: 'badge__dot' }), t('method.state.' + s.state)),
        h('span', { class: 'rp__step-name truncate', text: nodeTitle(st, s.id) })),
      h('div', { class: 'faint xs mono' }, [clock(s.startedAt), s.durationMs != null ? formatDuration(s.durationMs) : ''].filter(Boolean).join('  \u00b7  ')),
      s.message ? h('div', { class: 'small muted rp__msg', text: s.message }) : null)));
    if (!list.length) steps.append(h('li', { class: 'faint small', text: t('method.run.noSteps') }));
  }

  function render() {
    const st = cur();
    if (!st || dismissed.has(st.runId)) { root.hidden = true; stopTick(); return; }
    root.hidden = false;
    ensureMethod(st);
    const m = methodOf(st);
    const active = isActiveRun(st);
    title.textContent = m ? pickText(m.name, getLanguage()) : st.methodologyId;
    const proj = activeProject(store.get());
    agentHost.replaceChildren(agentIcon(proj ? proj.agent : null, { size: 18, state: st.status === 'running' ? 'running' : 'idle' }));
    root.dataset.agent = proj ? proj.agent : '';
    statusBadge.className = 'badge ' + STATUS_TONE[st.status];
    statusBadge.replaceChildren(h('span', { class: 'badge__dot' }), t('method.run.status.' + st.status));
    btnStop.hidden = !active;
    btnStop.querySelector('span').textContent = t('method.run.stop');
    btnClose.hidden = active;
    btnClose.setAttribute('aria-label', t('method.run.dismiss')); btnClose.title = t('method.run.dismiss');
    btnFold.replaceChildren(icon(collapsed ? 'chevron' : 'arrowDown'));
    btnFold.setAttribute('aria-label', collapsed ? t('method.run.expand') : t('method.run.collapse'));
    btnFold.title = btnFold.getAttribute('aria-label');
    btnFold.setAttribute('aria-expanded', String(!collapsed));
    bodyEl.hidden = collapsed;
    if (active) startTick(st); else stopTick();
    elapsed.textContent = formatDuration((st.endedAt || Date.now()) - st.startedAt);

    const key = st.waiting ? `${st.runId}:${st.waiting.nodeId}:${st.waiting.kind}` : '';
    if (key !== waitKey) {
      waitKey = key;
      waitHost.replaceChildren(...(st.waiting ? [waitingCard(st)] : []));
      if (st.waiting) {
        live.textContent = t('method.run.waitingFor', { name: nodeTitle(st, st.waiting.nodeId) });
        const first = waitHost.querySelector('input, button');
        if (first && !root.contains(document.activeElement) && !document.querySelector('.modal')) first.focus({ preventScroll: true });
      }
    }
    waitHost.hidden = !st.waiting;
    summaryHost.replaceChildren(...(active ? [] : [summary(st)]));
    if (m) {
      if (shownRunId !== st.runId || graph.__mid !== m.id) { graph.setMethodology(m, { keepView: false }); graph.__mid = m.id; shownRunId = st.runId; lastCurrent = null; }
      graph.setRunState(st);
      if (st.current && st.current !== lastCurrent) { lastCurrent = st.current; graph.reveal(st.current); }
    }
    renderSteps(st);
  }

  function startTick(st) { if (tick) return; tick = setInterval(() => { const s = cur(); if (s && isActiveRun(s)) elapsed.textContent = formatDuration(Date.now() - s.startedAt); }, 1000); }
  function stopTick() { if (tick) { clearInterval(tick); tick = null; } }

  store.subscribe((s, prev) => {
    if (s.runs !== prev.runs || s.activeProjectId !== prev.activeProjectId || s.methodCache !== prev.methodCache) render();
  });
  render();
  return { update: render, undismiss(runId) { dismissed.delete(runId); render(); } };
}
