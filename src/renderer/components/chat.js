// Message list: user bubbles, streamed markdown, tool cards, permission cards, errors, thinking dots.
import { h, icon, clear } from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import { renderMarkdown, attachLinkHandler, createFrameRenderer } from '../lib/markdown.js';
import { activeProject, isDev } from '../lib/store.js';
import { turnMessages, turnStats, livePhase } from '../lib/activity.js';
import { blockedItems, stripRetryNote } from '../lib/approvals.js';
import { buildToolCard } from './tool-card.js';
import { buildThinkingRow, buildSummaryCard, createLiveStatus } from './activity-rows.js';
import { buildApprovalCard } from './approval-card.js';
import { buildPlainSteps, buildPlainSummary } from './plain-view.js';
import { agentIcon } from './agent-icon.js';

/** Simple mode: fold every markdown code block under a "Show code" disclosure. */
function collapseCode(body) {
  for (const block of [...body.querySelectorAll('.code-block')]) {
    const det = h('details', { class: 'show-code' }, h('summary', { class: 'show-code__sum', text: t('plain.showCode') }));
    block.replaceWith(det);
    det.append(block);
  }
}

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
  let curChat = null;
  let curProject = null;
  let shownDev = null;
  const detailTurns = new Set(); // Simple mode: turns whose technical cards are expanded ("Show details")
  let stick = true;

  scroll.addEventListener('scroll', () => {
    stick = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;
    jump.hidden = stick || !entries.size;
  });
  jump.addEventListener('click', () => { stick = true; scroll.scrollTop = scroll.scrollHeight; jump.hidden = true; });


  const cardCtx = {
    root: '',
    dev: true,
    detailTurns,
    agent: 'claude',
    agentName: '',
    messages: () => curMessages,
    toggleDetails(turnId) { if (detailTurns.has(turnId)) detailTurns.delete(turnId); else detailTurns.add(turnId); render(); },
    approvalItems: (turnId) => blockedItems(curMessages, turnId),
    isActionable: (m) => !!curChat && !curChat.running && m.turn === curChat.turn.id,
    approve: {
      once: (id, rules) => actions.allowOnce(id, rules),
      project: (id) => actions.allowForProject(id),
      dismiss: (id) => actions.dismissApproval(id),
    },
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
      const tag = h('div', { class: 'msg__tag small muted', hidden: true });
      const el = h('div', { class: 'msg msg--user' }, body, tag);
      return {
        el,
        update(x) {
          // A retry after "Allow this once" carries a fixed note for the agent: show it as a small tag instead.
          const shown = stripRetryNote(x.text);
          body.textContent = shown;
          tag.hidden = shown === x.text;
          tag.textContent = t('approval.retryTag');
        },
      };
    }
    if (m.role === 'assistant') {
      const icoHost = h('span', { class: 'msg__avatar' });
      const nameEl = h('span', { class: 'msg__name' });
      const meta = h('div', { class: 'msg__meta' }, icoHost, nameEl);
      const body = h('div', { class: 'msg__body md' });
      const el = h('div', { class: 'msg msg--assistant' }, meta, body);
      let lastText = null;
      let lastOpen = null;
      let lastAgent = null;
      return {
        el,
        update(x) {
          const proj = activeProject(store.get());
          nameEl.textContent = agentName(proj, x);
          const ag = x.agent || (proj && proj.agent) || null;
          if (ag !== lastAgent) { lastAgent = ag; icoHost.replaceChildren(agentIcon(ag, { size: 16 })); }
          if (x.text !== lastText || x.open !== lastOpen) {
            lastText = x.text; lastOpen = x.open;
            body.replaceChildren(renderMarkdown(x.text, { streaming: x.open }));
            if (!cardCtx.dev) collapseCode(body);
          }
        },
      };
    }
    if (m.role === 'tool') return buildToolCard();
    if (m.role === 'thinking') return buildThinkingRow();
    if (m.role === 'summary') return cardCtx.dev ? buildSummaryCard() : buildPlainSummary();
    if (m.role === 'approval') return buildApprovalCard();
    if (m.role === 'permission') return { el: h('div', { class: 'msg-hidden', hidden: true }), update() {} };
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
    const dev = isDev(s);
    if (shownDev !== null && dev !== shownDev) { entries.clear(); clear(inner); detailTurns.clear(); }
    shownDev = dev;
    const projectRoot = project ? project.path : '';
    const rootChanged = cardCtx.root !== projectRoot;
    cardCtx.root = projectRoot;
    cardCtx.dev = dev;
    cardCtx.agent = project ? project.agent : 'claude';
    cardCtx.agentName = t('agent.' + cardCtx.agent);
    curChat = chat;
    curProject = project;
    const order = [];
    const keep = new Set();
    const stepsSeen = new Set();
    for (const m of messages) {
      if (!dev && m.role === 'tool' && !stepsSeen.has(m.turn)) {
        stepsSeen.add(m.turn);
        const key = 'steps:' + m.turn;
        let se = entries.get(key);
        if (!se) { se = buildPlainSteps(); entries.set(key, se); }
        se.update(m.turn, cardCtx);
        keep.add(key);
        order.push(se.el);
      }
      let e = entries.get(m.id);
      if (!e) { e = build(m); e.msg = null; entries.set(m.id, e); }
      if (e.msg !== m || rootChanged || m.role === 'summary' || m.role === 'approval') { e.update(m, cardCtx); e.msg = m; }
      if (m.role === 'tool') e.el.hidden = !dev && !detailTurns.has(m.turn);
      else if (m.role === 'thinking') e.el.hidden = !dev;
      keep.add(m.id);
      order.push(e.el);
    }
    for (const [id, e] of entries) if (!keep.has(id)) { e.el.remove(); entries.delete(id); }

    const running = !!(chat && chat.running);
    if (running) {
      if (!live) live = createLiveStatus();
      live.update(livePhase(chat, projectRoot), projectRoot, { agent: cardCtx.agent, simple: !dev });
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
    if (s.chats !== prev.chats || s.activeProjectId !== prev.activeProjectId || s.projects !== prev.projects || s.settings.developerMode !== prev.settings.developerMode) schedule();
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
