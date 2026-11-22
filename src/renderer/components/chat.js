// Message list: user bubbles, streamed markdown, tool cards, permission cards, errors, thinking dots.
import { h, icon, clear } from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import { renderMarkdown, attachLinkHandler, createFrameRenderer } from '../lib/markdown.js';
import { resolvePermission } from '../lib/events.js';
import { activeProject } from '../lib/store.js';
import { turnMessages, turnStats, livePhase } from '../lib/activity.js';
import { buildToolCard } from './tool-card.js';
import { buildThinkingRow, buildSummaryCard, createLiveStatus } from './activity-rows.js';

/** Label of the agent that produced a message (recorded per turn), else the project's current agent. */
function agentName(project, m) {
  const a = (m && m.agent) || (project && project.agent);
  return a ? t('agent.' + a) : t('chat.assistant');
}


export function mountChat(root, { store, api, actions }) {
  const inner = h('div', { class: 'chat-scroll__inner', attrs: { role: 'log', 'aria-live': 'polite', 'aria-relevant': 'additions text' } });
  const scroll = h('div', { class: 'chat-scroll' }, inner);
  const jump = h('button', { class: 'btn btn--sm jump-latest', type: 'button', hidden: true }, icon('arrowDown'));
  const jumpText = h('span');
  jump.append(jumpText);
  root.append(scroll, jump);
  attachLinkHandler(inner);

  const entries = new Map(); // message id -> { el, msg, update }
  let shownProject = null;
  let emptyEl = null;
  let live = null;
  let curMessages = [];
  let stick = true;

  scroll.addEventListener('scroll', () => {
    stick = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;
    jump.hidden = stick || !entries.size;
  });
  jump.addEventListener('click', () => { stick = true; scroll.scrollTop = scroll.scrollHeight; jump.hidden = true; });


  const cardCtx = {
    root: '',
    openFile: (rel) => actions.openFile(rel),
    reveal: (id) => reveal(id),
    stats: (turnId) => turnStats(turnMessages(curMessages, turnId), cardCtx.root),
    setTurnOpen(turnId, open) {
      for (const m of curMessages) {
        if (m.turn !== turnId || m.role !== 'tool') continue;
        const e = entries.get(m.id);
        if (e && e.setOpen) e.setOpen(open);
      }
    },
  };

  function reveal(id) {
    const e = entries.get(id);
    if (!e) return;
    if (e.setOpen) e.setOpen(true);
    stick = false;
    e.el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    e.el.classList.add('is-flash');
    setTimeout(() => e.el.classList.remove('is-flash'), 1600);
    const hd = e.el.querySelector('.tool-card__header');
    if (hd) hd.focus({ preventScroll: true });
  }

  function build(m) {
    if (m.role === 'user') {
      const body = h('div', { class: 'msg__body' });
      const el = h('div', { class: 'msg msg--user' }, body);
      return { el, update: (x) => { body.textContent = x.text; } };
    }
    if (m.role === 'assistant') {
      const meta = h('div', { class: 'msg__meta' });
      const body = h('div', { class: 'msg__body md' });
      const el = h('div', { class: 'msg msg--assistant' }, meta, body);
      let lastText = null;
      let lastOpen = null;
      return {
        el,
        update(x) {
          meta.textContent = agentName(activeProject(store.get()), x);
          if (x.text !== lastText || x.open !== lastOpen) {
            lastText = x.text; lastOpen = x.open;
            body.replaceChildren(renderMarkdown(x.text, { streaming: x.open }));
          }
        },
      };
    }
    if (m.role === 'tool') return buildToolCard();
    if (m.role === 'thinking') return buildThinkingRow();
    if (m.role === 'summary') return buildSummaryCard();
    if (m.role === 'permission') return buildPermission(m);
    if (m.role === 'error') {
      const text = h('div', { class: 'msg__body' });
      const el = h('div', { class: 'msg msg--error', attrs: { role: 'alert' } }, text);
      return {
        el,
        update(x) {
          const parts = [x.message || t('errors.generic')];
          if (x.kind === 'auth') parts.push(t('banner.notLoggedIn'));
          text.replaceChildren(icon('alert'), ' ', parts.join(' '));
          if (x.stderr) text.append(h('pre', { class: 'mono small err-stderr', text: x.stderr }));
        },
      };
    }
    const el = h('div', { class: 'msg msg--system' });
    return { el, update: (x) => { el.textContent = x.key ? t(x.key) : x.text || ''; } };
  }

  function buildPermission(m0) {
    const title = h('div', { class: 'permission-card__title' });
    const detail = h('div', { class: 'permission-card__detail' });
    const actionsEl = h('div', { class: 'permission-card__actions' });
    const el = h('div', { class: 'permission-card', attrs: { role: 'group' } }, title, detail, actionsEl);
    return {
      el,
      update(m) {
        const proj = activeProject(store.get());
        const resolved = m.status !== 'pending';
        el.classList.toggle('is-resolved', resolved);
        title.replaceChildren(icon('shield'), t('chat.permissionTitle'));
        const lines = [t('chat.permissionText', { agent: agentName(proj, m), tool: m.tool })];
        if (m.message) lines.push(m.message);
        else if (m.reason) lines.push(m.reason);
        detail.textContent = lines.join('\n');
        actionsEl.replaceChildren();
        if (resolved) {
          actionsEl.append(h('span', { class: 'small muted', text: m.status === 'approved' ? t('chat.approved') : t('chat.denied') }));
          return;
        }
        actionsEl.append(
          h('button', { class: 'btn btn--sm', type: 'button', text: t('chat.deny'), on: { click: () => {
            store.updateChat(store.get().activeProjectId, (s) => resolvePermission(s, m.id, 'denied'));
          } } }),
          h('button', { class: 'btn btn--primary btn--sm', type: 'button', text: t('chat.approveRetry'), on: { click: () => actions.approveAndRetry(m.id) } }),
        );
      },
    };
  }

  function renderEmpty(project) {
    if (!emptyEl) {
      emptyEl = h('div', { class: 'empty-state' });
    }
    emptyEl.replaceChildren(...[
      h('div', { class: 'empty-state__icon' }, icon('sparkles', 'icon--lg')),
      h('div', { class: 'empty-state__title', text: t('chat.emptyTitle') }),
      h('div', { class: 'empty-state__text', text: t('chat.emptyText') }),
      project ? h('span', { class: 'chip-path', text: project.path }) : null,
      project && project.sessionId ? h('span', { class: 'badge badge--muted', text: t('chat.resumed') }) : null,
    ].filter(Boolean));
    return emptyEl;
  }

  function render() {
    const s = store.get();
    const project = activeProject(s);
    const chat = project ? s.chats[project.id] : null;
    if (!project || project.id !== shownProject) {
      shownProject = project ? project.id : null;
      entries.clear();
      clear(inner);
      emptyEl = null; if (live) { live.stop(); live = null; }
      stick = true;
    }
    const messages = chat ? chat.messages : [];
    curMessages = messages;
    const projectRoot = project ? project.path : '';
    const rootChanged = cardCtx.root !== projectRoot;
    cardCtx.root = projectRoot;
    const order = [];
    for (const m of messages) {
      let e = entries.get(m.id);
      if (!e) { e = build(m); e.msg = null; entries.set(m.id, e); }
      if (e.msg !== m || rootChanged || m.role === 'summary') { e.update(m, cardCtx); e.msg = m; }
      order.push(e.el);
    }
    const keep = new Set(messages.map((m) => m.id));
    for (const [id, e] of entries) if (!keep.has(id)) { e.el.remove(); entries.delete(id); }

    const running = !!(chat && chat.running);
    if (running) {
      if (!live) live = createLiveStatus();
      live.update(livePhase(chat, projectRoot), projectRoot);
      order.push(live.el);
    } else if (live) { live.stop(); live = null; }
    if (!messages.length && !running) order.unshift(renderEmpty(project));
    else emptyEl = null;

    // Reconcile order with minimal DOM moves.
    order.forEach((el, i) => { if (inner.children[i] !== el) inner.insertBefore(el, inner.children[i] || null); });
    while (inner.children.length > order.length) inner.lastElementChild.remove();

    jumpText.textContent = t('chat.scrollToBottom');
    if (stick) scroll.scrollTop = scroll.scrollHeight;
    else jump.hidden = !messages.length;
  }

  const schedule = createFrameRenderer(render);
  store.subscribe((s, prev) => {
    if (s.chats !== prev.chats || s.activeProjectId !== prev.activeProjectId || s.projects !== prev.projects) schedule();
  });
  render();
  return {
    update() {
      // Language change: force every message to rebuild its translated text.
      for (const e of entries.values()) e.msg = null;
      render();
    },
    stickToBottom() { stick = true; schedule(); },
    reveal,
  };
}
