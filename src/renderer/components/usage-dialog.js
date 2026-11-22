// Usage dialog: Claude (two gauges: 5-hour session and 7-day week + today), AGY (today + last limit), DeepSeek (balance, only when enabled).
// Gauges are role=progressbar; the reset countdown refreshes every 30 s without re-building the dialog.
import { h } from '../lib/dom.js';
import { t, onChange, getLanguage } from '../lib/i18n.js';
import { openDialog } from './modal.js';
import { agentIcon } from './agent-icon.js';
import { compactNumber, costText, isLimitActive, limitCardModel, percent, resetLine, windowLabel, windowTone, WINDOW_KINDS } from '../lib/usage.js';
import { tick } from '../lib/ticker.js';
import { balanceText, deepseekError } from '../lib/deepseek.js';

const timeText = (ms) => {
  try { return new Intl.DateTimeFormat(getLanguage() === 'es' ? 'es' : 'en-US', { hour: 'numeric', minute: '2-digit' }).format(new Date(ms)); } catch { return ''; }
};

export function openUsageDialog({ store, actions }) {
  const body = h('div', { class: 'usage' });
  const closeBtn = h('button', { class: 'btn btn--primary', type: 'button', text: t('usage.dialog.close') });
  let unsubs = [];
  const dlg = openDialog({ title: t('usage.dialog.title'), body, footer: [closeBtn], size: 'lg', onClose: () => unsubs.forEach((u) => u()) });
  closeBtn.addEventListener('click', () => dlg.close('done'));
  let resets = []; // [{ node, gauge, w }]

  const stat = (label, value) => h('div', { class: 'usage__stat' }, h('div', { class: 'usage__stat-v', text: value }), h('div', { class: 'usage__stat-l xs', text: label }));

  function gauge(kind, w) {
    const pct = percent(w.utilization);
    const tone = windowTone(w);
    const name = windowLabel(kind);
    const resetNode = h('span', { class: 'usage__reset small muted' });
    const bar = h('div', {
      class: 'gauge gauge--' + tone, attrs: { role: 'progressbar', 'aria-label': name, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct) },
    }, h('div', { class: 'gauge__bar', style: 'width:' + pct + '%' }));
    const g = { node: resetNode, bar, w, name, pct };
    resets.push(g);
    return h('div', { class: 'usage__gauge' },
      h('div', { class: 'usage__gauge-head' }, h('span', { class: 'usage__gauge-name', text: name }), h('span', { class: 'usage__gauge-pct gauge-pct--' + tone, text: pct + '%' })),
      bar,
      h('div', { class: 'usage__gauge-foot' }, resetNode, h('span', { class: 'badge usage__status usage__status--' + tone, text: t('usage.status.' + tone) })));
  }

  function paintResets() {
    const now = Date.now();
    for (const g of resets) {
      const line = resetLine(g.w.resetsAt, now, getLanguage());
      g.node.textContent = line;
      g.bar.setAttribute('aria-valuetext', t('usage.gauge', { window: g.name, percent: g.pct + '%' }) + '. ' + line);
    }
  }

  function lastLimit(side, agent) {
    const l = side && side.lastLimit;
    if (!l) return h('div', { class: 'usage__limit faint small', text: t('usage.noLimit') });
    const m = limitCardModel({ ...l, agent }, agent);
    const active = isLimitActive(l, Date.now());
    return h('div', { class: 'usage__limit' },
      h('div', { class: 'usage__limit-head small' }, h('strong', { text: t('usage.lastLimit') + ': ' + m.title }), ' ',
        h('span', { class: 'badge ' + (active ? 'badge--red' : 'badge--muted'), text: active ? t('usage.status.red') : timeText(l.at) })),
      m.message ? h('blockquote', { class: 'limit-card__quote usage__quote' }, h('p', { class: 'limit-card__msg', text: m.message })) : null);
  }

  function claudeCard(u) {
    const c = u && u.claude;
    const wins = c && c.windows;
    const any = wins && WINDOW_KINDS.some((k) => wins[k]);
    const today = c && c.today;
    return h('section', { class: 'card usage__card', attrs: { 'aria-label': t('usage.claude') } },
      h('div', { class: 'usage__card-head' }, agentIcon('claude', { size: 18 }), h('h3', { class: 'usage__card-title', text: t('usage.claude') })),
      any ? h('div', { class: 'usage__gauges' }, ...WINDOW_KINDS.filter((k) => wins[k]).map((k) => gauge(k, wins[k])))
        : h('div', { class: 'usage__empty muted small', text: t('usage.noData') }),
      today ? h('div', { class: 'usage__today' }, h('div', { class: 'usage__sub small muted', text: t('usage.today') }),
        h('div', { class: 'usage__stats' }, stat(t('usage.cost'), costText(today.costUsd)),
          stat(t('usage.tokens'), compactNumber((today.inputTokens || 0) + (today.outputTokens || 0))), stat(t('usage.turns'), String(today.turns || 0)))) : null,
      c ? lastLimit(c, 'claude') : null);
  }

  function agyCard(u) {
    const a = u && u.agy;
    const today = a && a.today;
    return h('section', { class: 'card usage__card', attrs: { 'aria-label': t('usage.agy') } },
      h('div', { class: 'usage__card-head' }, agentIcon('agy', { size: 18 }), h('h3', { class: 'usage__card-title', text: t('usage.agy') })),
      today ? h('div', { class: 'usage__today' }, h('div', { class: 'usage__sub small muted', text: t('usage.today') }),
        h('div', { class: 'usage__stats' }, stat(t('usage.input'), compactNumber(today.inputTokens)), stat(t('usage.output'), compactNumber(today.outputTokens)),
          stat(t('usage.thinking'), compactNumber(today.thinkingTokens)), stat(t('usage.turns'), String(today.turns || 0))))
        : h('div', { class: 'usage__empty muted small', text: t('usage.noData') }),
      a ? lastLimit(a, 'agy') : null,
      h('div', { class: 'faint xs', text: t('usage.agyNote') }));
  }

  function deepseekCard(s) {
    const ds = s.deepseek;
    const u = s.usage && s.usage.deepseek;
    const bal = (ds && ds.balance) || (u && u.balance);
    const configured = (ds ? ds.configured : u && u.configured);
    const refresh = h('button', { class: 'btn btn--sm', type: 'button', text: t('usage.refresh'), on: { click: async (e) => { e.currentTarget.disabled = true; e.currentTarget.textContent = t('usage.refreshing'); await actions.refreshDeepseek(true); } } });
    let inner;
    if (!configured) {
      inner = [h('div', { class: 'usage__empty muted small', text: t('usage.notConfigured') }), h('div', null, h('button', { class: 'btn btn--sm', type: 'button', text: t('usage.setup'), on: { click: () => { dlg.close('settings'); actions.openSettings(); } } }))];
    } else if (ds && ds.error && !bal) {
      const e = deepseekError(ds.error);
      inner = [h('div', { class: 'field__error small', text: t(e.key, e.vars) }), refresh];
    } else {
      inner = [h('div', { class: 'usage__stats' },
        stat(t('usage.balance'), balanceText(bal)),
        stat(t('deepseek.availability'), bal ? (bal.available ? t('usage.available') : t('usage.unavailable')) : '-'),
        stat(t('deepseek.models'), ds && ds.models ? t('usage.models', { n: ds.models.length }) : '-')), refresh];
    }
    return h('section', { class: 'card usage__card', attrs: { 'aria-label': t('usage.deepseek') } },
      h('div', { class: 'usage__card-head' }, h('span', { class: 'usage__ds-dot', attrs: { 'aria-hidden': 'true' } }), h('h3', { class: 'usage__card-title', text: t('usage.deepseek') })), ...inner);
  }

  function render() {
    const s = store.get();
    resets = [];
    dlg.setTitle(t('usage.dialog.title'));
    closeBtn.textContent = t('usage.dialog.close');
    const u = s.usage;
    const stamps = [u && u.claude && u.claude.updatedAt, u && u.agy && u.agy.updatedAt, s.deepseek && s.deepseek.updatedAt].filter(Boolean);
    const last = stamps.length ? Math.max(...stamps) : null;
    body.replaceChildren(...[
      claudeCard(u), agyCard(u), s.settings.deepseekEnabled ? deepseekCard(s) : null,
      h('div', { class: 'usage__foot small faint', attrs: { role: 'status' } },
        h('div', { text: last ? t('usage.updated', { time: timeText(last) }) : t('usage.neverUpdated') }), h('div', { text: t('usage.note') }))].filter(Boolean));
    paintResets();
  }

  render();
  actions.refreshUsage();
  if (store.get().settings.deepseekEnabled) actions.refreshDeepseek(false);
  unsubs = [
    onChange(() => render()),
    store.subscribe((s, prev) => { if (s.usage !== prev.usage || s.deepseek !== prev.deepseek || s.settings.deepseekEnabled !== prev.settings.deepseekEnabled) render(); }),
  ];
  tick(body, paintResets, 30000);
  return dlg;
}
