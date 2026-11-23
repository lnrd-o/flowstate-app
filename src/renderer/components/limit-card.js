// Usage-limit card shown in the chat when a 'limit' event arrives.
//  rejected: prominent card (title by window, the CLI/model's OWN message quoted verbatim, reset countdown, switch agent / open usage).
//  warning:  a soft amber note ("You have used 90% of your 5-hour window").
// The countdown is aria-hidden and refreshes every 30 s (screen readers get the static reset clock once; the card is announced once on insertion).
import { h, icon } from '../lib/dom.js';
import { t, getLanguage } from '../lib/i18n.js';
import { limitCardModel, resetClock, resetLine } from '../lib/usage.js';
import { tick } from '../lib/ticker.js';
import { agentIcon } from './agent-icon.js';

/** Common "reset" text for a model: live line + static clock for assistive tech. */
export function resetTexts(model, now = Date.now()) {
  const lang = getLanguage();
  return {
    live: resetLine(model.resetsAt == null ? undefined : model.resetsAt, now, lang),
    clock: model.resetsAt == null ? '' : resetClock(model.resetsAt, now, lang),
  };
}

/** buildLimitCard({ store, actions }) -> { el, update(msg) } for chat message { role:'limit', ... }. */
export function buildLimitCard({ store, actions }) {
  let msg = null;
  const el = h('div', { class: 'limit-card', attrs: { role: 'group' } });
  const countdown = h('span', { class: 'limit-card__countdown', attrs: { 'aria-hidden': 'true' } });
  const srReset = h('span', { class: 'sr-only' });

  function paintCountdown() {
    if (!msg) return;
    const m = limitCardModel(msg, msg.agent, Date.now());
    const r = resetTexts(m);
    countdown.textContent = r.live;
    srReset.textContent = r.clock ? t('usage.resetsAt', { clock: r.clock }) : '';
    el.classList.toggle('is-expired', m.severity === 'rejected' && !m.active);
  }

  function update(x) {
    msg = x;
    const m = limitCardModel(x, x.agent, Date.now());
    const name = t('agent.' + m.agent);
    el.className = 'limit-card limit-card--' + m.severity;
    if (m.severity === 'warning') {
      el.className = 'limit-note';
      el.replaceChildren(icon('alert', 'limit-note__icon'), h('span', { class: 'limit-note__text', text: m.warnText }), ' ', countdown, srReset);
      paintCountdown();
      return;
    }
    const head = h('div', { class: 'limit-card__head' },
      h('span', { class: 'limit-card__ic' }, icon('alert')),
      h('div', { class: 'limit-card__titles' }, h('div', { class: 'limit-card__title', text: m.title }), h('div', { class: 'limit-card__sub small' }, countdown, srReset)),
      h('span', { class: 'limit-card__agent', title: name }, agentIcon(m.agent, { size: 16 })));
    const quote = m.message ? h('blockquote', { class: 'limit-card__quote' },
      h('p', { class: 'limit-card__msg', text: m.message }), h('footer', { class: 'limit-card__cite xs', text: t('usage.limit.from', { agent: name }) })) : null;
    const acts = h('div', { class: 'limit-card__actions' },
      h('button', { class: 'btn btn--primary btn--sm', type: 'button', text: t('usage.limit.switchTo', { agent: t('agent.' + m.switchTo) }), on: { click: () => actions.switchAgent(m.switchTo) } }),
      h('button', { class: 'btn btn--sm', type: 'button', text: t('work.msg.otherModel'), on: { click: () => actions.openResend() } }),
      h('button', { class: 'btn btn--sm', type: 'button', text: t('usage.limit.openUsage'), on: { click: () => actions.openUsage() } }),
      h('span', { class: 'limit-card__help faint small', text: t('usage.limit.help') }));
    el.replaceChildren(...[head, quote, acts].filter(Boolean));
    paintCountdown();
  }

  tick(el, paintCountdown, 30000);
  return { el, update };
}
