// Resend a message with another model, and the queue of messages typed while the agent works.
import { h, icon } from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import { activeProject } from '../lib/store.js';
import { openDialog } from './modal.js';

/** True when the chat's last turn finished without an error, usage limit, approval request or user stop (so a queued message may go next). */
export function turnEndedClean(chat) {
  if (!chat || chat.running || !chat.turn || !chat.turn.endedAt) return false;
  const msgs = (chat.messages || []).filter((m) => m.turn === chat.turn.id);
  return !msgs.some((m) => m.role === 'error' || (m.role === 'limit' && m.status === 'rejected') || m.role === 'approval' || (m.role === 'system' && m.key === 'chat.stopped')); // a usage WARNING does not block the queue
}

const PROVIDER_NAMES = { opencode: 'OpenCode Zen', 'opencode-go': 'OpenCode Go', anthropic: 'Anthropic', google: 'Google', openai: 'OpenAI', deepseek: 'DeepSeek', openrouter: 'OpenRouter' };

/** Option-group label for a model group ("opencode:opencode-go" -> "OpenCode Go - your plan"). creds = detected providers or null. */
export function groupLabel(group, creds) {
  const prov = group.includes(':') ? group.slice(group.indexOf(':') + 1) : '';
  if (!prov) return group ? t('model.group.' + group) : '';
  let label = PROVIDER_NAMES[prov] || prov;
  if (creds && (prov === 'opencode-go' || prov === 'opencode')) {
    label += ' - ' + (creds.includes(prov) ? t('model.plan.yours') : t('model.plan.none'));
    if (prov === 'opencode') label += ' / ' + t('model.plan.payg');
  }
  return label;
}

export function openResendDialog({ store, actions, text }) {
  const p = activeProject(store.get());
  if (!p) return;
  const body = h('div', { class: 'resend' });
  const cancel = h('button', { class: 'btn', type: 'button', text: t('common.cancel') });
  const go = h('button', { class: 'btn btn--primary', type: 'button', text: t('work.resend.go') });
  const dlg = openDialog({ title: t('work.resend.title'), body, footer: [cancel, go], isDirty: () => false });
  cancel.addEventListener('click', () => dlg.close('cancel'));
  const sel = h('select', { class: 'select', id: 'resend-model', attrs: { 'aria-label': t('work.resend.model') } });
  const paint = () => {
    const list = store.get().models[p.agent];
    const models = list && Array.isArray(list.models) ? list.models : [];
    const creds = list && Array.isArray(list.credentials) ? list.credentials : null;
    const groups = new Map();
    for (const m of models) { const g = m.group || ''; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(m); }
    const cur = store.get().projects.find((x) => x.id === p.id) || p;
    sel.replaceChildren(h('option', { value: '', text: t('work.resend.default') }));
    const order = [...groups.keys()].sort((a, b) => Number(b.endsWith(':opencode-go')) - Number(a.endsWith(':opencode-go')));
    for (const g of order) {
      const og = h('optgroup', { attrs: { label: groupLabel(g, creds) } });
      for (const m of groups.get(g)) og.append(h('option', { value: m.id, text: m.name || m.id, disabled: !!m.disabled }));
      sel.append(og);
    }
    sel.value = cur.model || '';
  };
  paint();
  const unsub = store.subscribe((s, prev) => { if (s.models !== prev.models) paint(); });
  const origClose = dlg.close;
  dlg.close = (r) => { unsub(); origClose(r); };
  body.append(
    h('p', { class: 'small muted resend__text', text: text.length > 240 ? text.slice(0, 240) + '...' : text }),
    h('div', { class: 'field' }, h('label', { class: 'field__label', for: 'resend-model', text: t('work.resend.model') }), sel),
    h('p', { class: 'xs faint', text: t('work.resend.hint') }));
  go.addEventListener('click', () => { const m = sel.value; dlg.close('done'); actions.resendWithModel(text, m); });
}

/** Queue of messages typed while the agent works (above the composer). */
export function mountQueueBar(host, { store, actions }) {
  let sig = '';
  host.className = 'queue-bar';
  function render() {
    const s = store.get();
    const p = activeProject(s);
    const q = (p && s.queue && s.queue[p.id]) || [];
    const chat = p && s.chats[p.id];
    const running = !!(chat && chat.running);
    const nextSig = JSON.stringify([q, running, s.settings && s.settings.language]);
    if (nextSig === sig) return;
    sig = nextSig;
    host.hidden = !q.length;
    if (!q.length) { host.replaceChildren(); return; }
    host.replaceChildren(
      h('div', { class: 'queue-bar__head small muted', text: running ? t('work.queue.waiting', { n: q.length }) : t('work.queue.paused', { n: q.length }) }),
      ...q.map((it) => h('div', { class: 'queue-bar__item' },
        h('span', { class: 'queue-bar__text truncate', text: it.text, title: it.text }),
        h('button', { class: 'btn btn--sm btn--primary', type: 'button', text: t('work.queue.sendNow'), on: { click: () => actions.sendNow(it.id) } }),
        h('button', { class: 'btn btn--ghost btn--icon btn--sm', type: 'button', title: t('work.queue.remove'), attrs: { 'aria-label': t('work.queue.remove') }, on: { click: () => actions.dequeue(it.id) } }, icon('x')))));
  }
  store.subscribe(render);
  render();
}
