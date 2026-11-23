// Usage ring (composer): a small circle showing how much of the plan's 5-hour window is used; click for the plan limits (5-hour and
// weekly bars with reset times) and "See all" for the full usage dialog. Claude shows plan windows; Antigravity / OpenCode / DeepSeek
// show today's token total instead (they have no fixed windows).
import { h, icon } from '../lib/dom.js';
import { t, getLanguage } from '../lib/i18n.js';
import { activeProject } from '../lib/store.js';
import { percent, windowTone, resetLine, windowLabel, compactNumber } from '../lib/usage.js';

const R = 8; // ring radius in a 20x20 viewBox
const C = 2 * Math.PI * R;

export function mountUsageRing({ store, actions }) {
  const svgNS = 'http://www.w3.org/2000/svg';
  const mk = (tag, attrs) => { const e = document.createElementNS(svgNS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); return e; };
  const svg = mk('svg', { viewBox: '0 0 20 20', width: 20, height: 20, 'aria-hidden': 'true' });
  const track = mk('circle', { cx: 10, cy: 10, r: R, fill: 'none', 'stroke-width': 2.5, class: 'usage-ring__track' });
  const arc = mk('circle', { cx: 10, cy: 10, r: R, fill: 'none', 'stroke-width': 2.5, 'stroke-linecap': 'round', transform: 'rotate(-90 10 10)', 'stroke-dasharray': C, 'stroke-dashoffset': C, class: 'usage-ring__arc' });
  svg.append(track, arc);
  const btn = h('button', { class: 'usage-ring', type: 'button', attrs: { 'aria-haspopup': 'dialog', 'aria-expanded': 'false' } }, svg);
  const pop = h('div', { class: 'usage-pop', hidden: true, attrs: { role: 'dialog' } });
  const el = h('span', { class: 'usage-ring__wrap' }, btn, pop);

  const bar = (label, w) => {
    const pct = percent(w.utilization);
    return h('div', { class: 'usage-pop__row' },
      h('div', { class: 'usage-pop__line' }, h('span', { text: label }), h('span', { class: 'faint small', text: resetLine(w.resetsAt, Date.now(), getLanguage()) }), h('strong', { text: pct + '%' })),
      h('div', { class: 'gauge gauge--' + windowTone(w) }, h('div', { class: 'gauge__bar', style: 'width:' + pct + '%' })));
  };

  function render() {
    const s = store.get();
    const p = activeProject(s);
    const u = s.usage;
    if (!p || !u) { el.hidden = true; return; }
    el.hidden = false;
    const wins = u.claude && u.claude.windows;
    let tone = 'ok'; let frac = 0; let title = '';
    const rows = [];
    if (p.agent === 'claude' && wins && (wins.five_hour || wins.seven_day)) {
      const main = wins.five_hour || wins.seven_day;
      frac = Math.min(1, Math.max(0, main.utilization));
      tone = windowTone(main);
      title = t('ring.plan', { percent: percent(main.utilization) });
      rows.push(h('div', { class: 'usage-pop__title' }, h('span', { text: t('ring.title') }), h('button', { class: 'btn btn--ghost btn--sm', type: 'button', text: t('ring.seeAll'), on: { click: () => { pop.hidden = true; actions.openUsage(); } } })));
      if (wins.five_hour) rows.push(bar(windowLabel('five_hour'), wins.five_hour));
      if (wins.seven_day) rows.push(bar(windowLabel('seven_day'), wins.seven_day));
    } else {
      const day = (u[p.agent] && u[p.agent].today) || (p.model && /^deepseek/i.test(p.model) ? u.deepseek && u.deepseek.today : null);
      const tok = day ? (day.inputTokens || 0) + (day.outputTokens || 0) : 0;
      frac = 0;
      title = t('ring.tokens', { tokens: compactNumber(tok) });
      rows.push(h('div', { class: 'usage-pop__title' }, h('span', { text: t('ring.titleToday') }), h('button', { class: 'btn btn--ghost btn--sm', type: 'button', text: t('ring.seeAll'), on: { click: () => { pop.hidden = true; actions.openUsage(); } } })),
        h('div', { class: 'usage-pop__line' }, h('span', { text: t('ring.tokensLabel') }), h('strong', { text: compactNumber(tok) })),
        h('p', { class: 'xs faint', text: t('ring.noWindows') }));
    }
    arc.setAttribute('stroke-dashoffset', String(C * (1 - frac)));
    el.className = 'usage-ring__wrap usage-ring--' + tone;
    btn.title = title;
    btn.setAttribute('aria-label', title);
    pop.replaceChildren(...rows);
  }

  btn.addEventListener('click', (e) => { e.stopPropagation(); pop.hidden = !pop.hidden; btn.setAttribute('aria-expanded', String(!pop.hidden)); });
  document.addEventListener('mousedown', (e) => { if (!pop.hidden && !el.contains(e.target)) { pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); } });
  store.subscribe((s, prev) => { if (s.usage !== prev.usage || s.activeProjectId !== prev.activeProjectId || s.projects !== prev.projects) render(); });
  render();
  return { el, render };
}
