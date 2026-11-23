// "Needs your OK" UI: the pay-as-you-go model dialog, the approval bar above the composer (Accept all / Review) and the policy chip.
import { h, icon } from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import { activeProject } from '../lib/store.js';
import { blockedItems } from '../lib/approvals.js';
import { policyOf } from '../lib/policy.js';
import { openDialog } from './modal.js';

/** Ask before using a pay-as-you-go model. -> Promise<'one'|'all'|null> */
export function openAcceptModelDialog({ model, kind }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const cancel = h('button', { class: 'btn', type: 'button', text: t('common.cancel') });
    const one = h('button', { class: 'btn btn--primary', type: 'button', text: t('accept.model.one') });
    const all = h('button', { class: 'btn', type: 'button', text: t('accept.model.all') });
    const body = h('div', { class: 'accept-model' },
      h('p', { class: 'mono strong', text: model }),
      h('p', { text: t('accept.model.' + (kind === 'deepseek' ? 'bodyDeepseek' : 'bodyZen')) }),
      h('p', { class: 'small muted', text: t('accept.model.hint') }));
    const dlg = openDialog({ title: t('accept.model.title'), body, footer: [cancel, all, one], isDirty: () => false, onClose: () => done(null) });
    cancel.addEventListener('click', () => dlg.close('cancel'));
    one.addEventListener('click', () => { done('one'); dlg.close('ok'); });
    all.addEventListener('click', () => { done('all'); dlg.close('ok'); });
    one.focus();
  });
}

/** Bar above the composer while the last turn waits for the user's OK: what is blocked + Accept all / Review. */
export function mountApprovalBar(host, { store }) {
  let sig = '';
  host.className = 'approval-bar';
  function pending(s) {
    const p = activeProject(s);
    const chat = p && s.chats[p.id];
    if (!chat || chat.running) return null;
    const msgs = chat.messages || [];
    const card = [...msgs].reverse().find((m) => m.role === 'approval' && m.status === 'pending' && m.turn === chat.turn.id);
    if (!card) return null;
    return { p, card, items: blockedItems(msgs, chat.turn.id) };
  }
  function render() {
    const s = store.get();
    const pd = pending(s);
    const nextSig = JSON.stringify([pd && [pd.card.id, pd.items.length], s.settings && s.settings.language]);
    if (nextSig === sig) return;
    sig = nextSig;
    host.hidden = !pd;
    if (!pd) { host.replaceChildren(); return; }
    const n = Math.max(1, pd.items.length);
    host.replaceChildren(
      icon('lock', 'approval-bar__ic'),
      h('span', { class: 'approval-bar__text', text: t(n === 1 ? 'accept.bar.one' : 'accept.bar.many', { agent: t('agent.' + pd.p.agent), n }) }),
      h('button', { class: 'btn btn--primary btn--sm', type: 'button', text: t('accept.bar.all'), title: t('accept.bar.allTitle'), attrs: { 'data-accept-all': '1' },
        on: { click: () => { const b = document.querySelector('.approval-card .btn--primary:not([disabled])'); if (b) b.click(); } } }),
      h('button', { class: 'btn btn--sm', type: 'button', text: t('accept.bar.review'), on: { click: () => { const c = document.querySelector('.approval-card'); if (c) { c.scrollIntoView({ block: 'center', behavior: 'smooth' }); c.classList.add('is-flash'); setTimeout(() => c.classList.remove('is-flash'), 1600); } } } }));
  }
  store.subscribe(render);
  render();
}

/** Small chip next to the mode select: what this agent + mode asks about. Returns { el, render(project) }. */
export function createPolicyChip({ onClick }) {
  const label = h('span', { class: 'policy-chip__t' });
  const el = h('button', { class: 'policy-chip', type: 'button', attrs: { 'aria-live': 'polite' } }, icon('shield'), label);
  if (onClick) el.addEventListener('click', onClick);
  return {
    el,
    render(project) {
      if (!project) { el.hidden = true; return; }
      const pol = policyOf(project.agent, project.mode);
      el.hidden = false;
      el.className = 'policy-chip policy-chip--' + pol.tone;
      label.textContent = t('policy.' + pol.key);
      el.title = t('policy.' + pol.key + 'Title', { agent: t('agent.' + project.agent) });
      el.setAttribute('aria-label', el.title);
    },
  };
}
