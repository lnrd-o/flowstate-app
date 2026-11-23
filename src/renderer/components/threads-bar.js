// Conversations bar (above the chat): switch between the project's conversations, start a new one, rename / delete, and open the
// markdown context notes the agents use to continue the work (works across providers). State: store.threads[projectId].
import { h, icon } from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import { activeProject } from '../lib/store.js';
import { agentIcon } from './agent-icon.js';

export function mountThreadsBar(host, { store, actions }) {
  let renaming = false;
  let sig = '';

  function render() {
    const s = store.get();
    const p = activeProject(s);
    const info = p && s.threads && s.threads[p.id];
    const running = !!(p && s.chats[p.id] && s.chats[p.id].running);
    const nextSig = JSON.stringify([p && p.id, info, running, renaming, t('threads.new'), p && p.agent]);
    if (nextSig === sig) return;
    sig = nextSig;
    host.hidden = !p || !info;
    if (host.hidden) { host.replaceChildren(); return; }
    const cur = info.threads.find((x) => x.id === info.active) || info.threads[0];

    let main;
    if (renaming) {
      const input = h('input', { class: 'input input--sm threads-bar__input', type: 'text', value: cur.title, attrs: { maxlength: '60', 'aria-label': t('threads.rename') } });
      const done = (ok) => { renaming = false; sig = ''; if (ok && input.value.trim() && input.value.trim() !== cur.title) actions.renameThread(p.id, cur.id, input.value.trim()); else render(); };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); done(true); } else if (e.key === 'Escape') { e.preventDefault(); done(false); } });
      input.addEventListener('blur', () => done(true));
      main = input;
      setTimeout(() => { input.focus(); input.select(); }, 0);
    } else {
      const sel = h('select', { class: 'select select--sm threads-bar__select', id: 'threads-select', attrs: { 'aria-label': t('threads.label') } },
        ...info.threads.map((x) => h('option', { value: x.id, text: (x.main ? t('threads.main') : x.title) + ' - ' + t('agent.' + x.agent) + (x.turns ? ' (' + x.turns + ')' : '') })));
      sel.value = cur.id;
      sel.disabled = running;
      sel.addEventListener('change', () => actions.switchThread(p.id, sel.value));
      main = sel;
    }
    const btn = (ic, label, on, extra = {}) => h('button', { class: 'btn btn--ghost btn--sm' + (extra.icon === false ? '' : ' btn--icon'), type: 'button', title: label, attrs: { 'aria-label': label }, disabled: !!extra.disabled, on: { click: on } }, icon(ic), extra.text || '');
    host.replaceChildren(...[
      h('div', { class: 'threads-bar__label' }, agentIcon(cur.agent, { size: 14 }), h('span', { class: 'xs faint', text: t('threads.label') })),
      main,
      btn('plus', t('threads.new'), () => actions.createThread(p.id), { disabled: running, icon: false, text: ' ' + t('threads.new') }),
      cur.main ? null : btn('edit', t('threads.rename'), () => { renaming = true; sig = ''; render(); }, { disabled: running }),
      cur.main ? null : btn('trash', t('threads.delete'), () => actions.removeThread(p.id, cur.id), { disabled: running }),
      btn('file', t('threads.context'), () => actions.openContext(p.id), { icon: false, text: ' ' + t('threads.context') })].filter(Boolean));
  }

  host.className = 'threads-bar';
  host.hidden = true;
  store.subscribe(render);
  render();
  return { render };
}
