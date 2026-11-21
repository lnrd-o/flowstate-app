// Message list: user bubbles, streamed markdown, tool cards, permission cards, errors, thinking dots.
import { h, icon, clear } from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import { renderMarkdown, attachLinkHandler, createFrameRenderer } from '../lib/markdown.js';
import { resolvePermission } from '../lib/events.js';
import { activeProject } from '../lib/store.js';

const TOOL_ICONS = { bash: 'terminal', shell: 'terminal', edit: 'edit', write: 'edit', multiedit: 'edit', read: 'file', grep: 'search', glob: 'search' };

function agentName(project) {
  return project ? t('agent.' + project.agent) : t('chat.assistant');
}

function formatToolBody(m) {
  const parts = [];
  const i = m.input;
  if (i && typeof i === 'object') {
    if (typeof i.command === 'string') parts.push('$ ' + i.command);
    else if (typeof i.old_string === 'string' && typeof i.new_string === 'string') {
      parts.push((i.file_path ? i.file_path + '\n' : '') + i.old_string.split('\n').map((l) => '- ' + l).join('\n') + '\n' + i.new_string.split('\n').map((l) => '+ ' + l).join('\n'));
    } else {
      let s = '';
      try { s = JSON.stringify(i, null, 2); } catch { s = String(i); }
      parts.push(s.length > 4000 ? s.slice(0, 4000) + '\n...' : s);
    }
  }
  if (m.output) parts.push(m.output);
  return parts.join('\n\n');
}

function buildToolCard() {
  const ic = h('span', { class: 'tool-card__icon-wrap' });
  const name = h('span', { class: 'tool-card__name' });
  const summary = h('span', { class: 'tool-card__summary' });
  const badge = h('span', { class: 'badge' });
  const spinner = h('span', { class: 'spinner' });
  const chevron = icon('chevron', 'tool-card__chevron');
  const header = h('button', { class: 'tool-card__header', type: 'button', attrs: { 'aria-expanded': 'false' } }, ic, name, summary, spinner, badge, chevron);
  const body = h('div', { class: 'tool-card__body' });
  const card = h('div', { class: 'tool-card' }, header, body);
  header.addEventListener('click', () => {
    const open = card.classList.toggle('is-open');
    header.setAttribute('aria-expanded', String(open));
  });
  let iconName = '';
  return {
    el: card,
    update(m) {
      const nm = String(m.name || 'tool');
      const want = TOOL_ICONS[nm.toLowerCase()] || 'tool';
      if (want !== iconName) { iconName = want; ic.replaceChildren(icon(want, 'tool-card__icon')); }
      name.textContent = nm;
      summary.textContent = m.summary || '';
      summary.title = m.summary || '';
      card.classList.toggle('tool-card--running', m.status === 'running');
      card.classList.toggle('tool-card--error', m.status === 'error');
      spinner.hidden = m.status !== 'running';
      badge.className = 'badge ' + (m.status === 'running' ? 'badge--purple' : m.status === 'error' ? 'badge--red' : 'badge--green');
      badge.textContent = m.status === 'running' ? t('chat.toolRunning') : m.status === 'error' ? t('chat.toolError') : t('chat.toolDone');
      body.textContent = formatToolBody(m);
    },
  };
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
  let dotsEl = null;
  let stick = true;

  scroll.addEventListener('scroll', () => {
    stick = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;
    jump.hidden = stick || !entries.size;
  });
  jump.addEventListener('click', () => { stick = true; scroll.scrollTop = scroll.scrollHeight; jump.hidden = true; });

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
          meta.textContent = agentName(activeProject(store.get()));
          if (x.text !== lastText || x.open !== lastOpen) {
            lastText = x.text; lastOpen = x.open;
            body.replaceChildren(renderMarkdown(x.text, { streaming: x.open }));
          }
        },
      };
    }
    if (m.role === 'tool') return buildToolCard();
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
        const lines = [t('chat.permissionText', { agent: agentName(proj), tool: m.tool })];
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
      emptyEl = null; dotsEl = null;
      stick = true;
    }
    const messages = chat ? chat.messages : [];
    const order = [];
    for (const m of messages) {
      let e = entries.get(m.id);
      if (!e) { e = build(m); e.msg = null; entries.set(m.id, e); }
      if (e.msg !== m) { e.update(m); e.msg = m; }
      order.push(e.el);
    }
    const keep = new Set(messages.map((m) => m.id));
    for (const [id, e] of entries) if (!keep.has(id)) { e.el.remove(); entries.delete(id); }

    const last = messages[messages.length - 1];
    const running = !!(chat && chat.running);
    const showDots = running && !(last && last.role === 'assistant' && last.open && last.text) && !(last && last.role === 'tool' && last.status === 'running');
    if (showDots) {
      if (!dotsEl) {
        dotsEl = h('div', { class: 'msg msg--assistant thinking', attrs: { role: 'status' } },
          h('span', { class: 'thinking-dots', attrs: { 'aria-hidden': 'true' } }, h('span'), h('span'), h('span')),
          h('span', { class: 'sr-only', text: t('chat.thinking') }));
      }
      order.push(dotsEl);
    } else dotsEl = null;
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
  };
}
