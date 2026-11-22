// Artifacts "Activity" tab: timeline of the active project's current (or last) turn, files changed and commands run.
// Reads the same reducer state as the chat (no IPC of its own).
import { h, icon } from '../lib/dom.js';
import { t, getLanguage } from '../lib/i18n.js';
import { activeProject } from '../lib/store.js';
import { createFrameRenderer } from '../lib/markdown.js';
import {
  turnMessages, turnStats, buildTimeline, commandList, changeOf, formatDuration, formatCount,
} from '../lib/activity.js';
import { createDiffView } from './diff-view.js';

const KIND_ICONS = { command: 'terminal', edit: 'edit', write: 'edit', read: 'file', search: 'search', list: 'folder', other: 'tool' };

export function mountActivityTab(el, { store, actions }) {
  const root = h('div', { class: 'act' });
  el.append(root);
  const openDiffs = new Set(); // file paths whose inline diff is expanded
  let shownKey = '';
  const render = createFrameRenderer(paint);

  function stateRow(status, exitCode) {
    if (status === 'running') return h('span', { class: 'spinner', attrs: { 'aria-hidden': 'true' } });
    const bad = status === 'error' || (typeof exitCode === 'number' && exitCode !== 0);
    return h('span', { class: 'act__state ' + (bad ? 'is-bad' : 'is-ok'), attrs: { 'aria-hidden': 'true' } }, icon(bad ? 'x' : 'check'));
  }

  function timelineRow(r, chat) {
    const loc = getLanguage();
    let ic = 'sparkles';
    let label = '';
    if (r.type === 'thinking') {
      label = r.tokens ? t('act.thoughtTokens', { tokens: formatCount(r.tokens, loc) }) : t('act.tab.thinking');
    } else if (r.type === 'answer') { ic = 'message'; label = t('act.tab.answer'); }
    else {
      ic = KIND_ICONS[r.toolKind] || 'tool';
      label = r.title ? t(r.title.key, r.title.vars) : String(r.name || 'tool');
    }
    const clickable = r.type === 'tool' || r.type === 'answer';
    const content = [
      h('span', { class: 'act__time mono faint', text: r.offsetMs != null ? t('act.tab.offset', { time: formatDuration(r.offsetMs) }) : '' }),
      h('span', { class: 'act__ic' }, icon(ic)),
      h('span', { class: 'act__label truncate', text: label, title: label }),
      h('span', { class: 'act__dur faint small', text: r.durationMs ? formatDuration(r.durationMs) : '' }),
      r.type === 'tool' ? stateRow(r.status, r.exitCode) : null,
    ];
    if (!clickable) return h('li', { class: 'act__row' }, h('div', { class: 'act__rowin' }, ...content));
    return h('li', { class: 'act__row' }, h('button', { class: 'act__rowin act__rowbtn', type: 'button', title: t('act.tab.jump'), on: { click: () => actions.revealCard(r.id) } }, ...content));
  }

  function filesSection(stats, msgs) {
    const sec = h('section', { class: 'act__sec', attrs: { 'aria-label': t('act.tab.files') } }, h('h3', { class: 'act__h', text: t('act.tab.files') }));
    if (!stats.files.length) { sec.append(h('div', { class: 'faint small', text: t('act.tab.noFiles') })); return sec; }
    const ul = h('ul', { class: 'act__list' });
    for (const f of stats.files) {
      const open = openDiffs.has(f.path);
      const line = h('div', { class: 'act__file' },
        h('button', {
          class: 'act__filebtn', type: 'button', attrs: { 'aria-expanded': String(open) }, title: open ? t('act.tab.hideDiff') : t('act.tab.showDiff'),
          on: { click: () => { if (open) openDiffs.delete(f.path); else openDiffs.add(f.path); paint(); } },
        }, icon('chevron', 'act__chev' + (open ? ' is-open' : '')), h('span', { class: 'truncate mono', text: f.path })),
        h('span', { class: 'tc-delta' }, f.added ? h('span', { class: 'tc-add', text: '+' + f.added }) : null, f.removed ? h('span', { class: 'tc-del', text: '-' + f.removed }) : null),
        f.op === 'delete' ? null : h('button', {
          class: 'btn btn--ghost btn--icon btn--sm', type: 'button', title: t('act.tab.openFile'), attrs: { 'aria-label': t('act.tab.openFile') + ': ' + f.path },
          on: { click: () => actions.openFile(f.path) },
        }, icon('external')));
      const li = h('li', { class: 'act__fileitem' }, line);
      if (open) {
        const m = msgs.find((x) => x.id === f.ids[f.ids.length - 1]);
        const ch = m ? changeOf(m) : null;
        if (ch && ch.diff) li.append(createDiffView({ diff: ch.diff, path: f.path, hideNumbers: !!ch.derived && ch.op !== 'create' }).el);
      }
      ul.append(li);
    }
    sec.append(ul);
    return sec;
  }

  function commandsSection(msgs) {
    const cmds = commandList(msgs);
    const sec = h('section', { class: 'act__sec', attrs: { 'aria-label': t('act.tab.commands') } }, h('h3', { class: 'act__h', text: t('act.tab.commands') }));
    if (!cmds.length) { sec.append(h('div', { class: 'faint small', text: t('act.tab.noCommands') })); return sec; }
    sec.append(h('ul', { class: 'act__list' }, ...cmds.map((c) => h('li', { class: 'act__cmditem' },
      h('button', { class: 'act__cmd', type: 'button', title: t('act.tab.jump'), on: { click: () => actions.revealCard(c.id) } },
        icon('terminal'), h('span', { class: 'truncate mono', text: c.command }),
        c.status === 'running' ? h('span', { class: 'spinner' })
          : typeof c.exitCode === 'number' ? h('span', { class: 'badge ' + (c.exitCode === 0 ? 'badge--green' : 'badge--red'), text: t('act.exitCode', { code: c.exitCode }) })
            : h('span', { class: 'badge ' + (c.status === 'error' ? 'badge--red' : 'badge--green'), text: c.status === 'error' ? t('chat.toolError') : t('chat.toolDone') }))))));
    return sec;
  }

  function paint() {
    if (el.hidden) return;
    const s = store.get();
    const p = activeProject(s);
    const chat = p ? s.chats[p.id] : null;
    const key = p ? p.id + ':' + (chat ? chat.turn.id : 0) : '';
    if (key !== shownKey) { shownKey = key; openDiffs.clear(); }
    if (!p || !chat || !chat.turn.id) {
      root.replaceChildren(h('div', { class: 'empty-state' },
        h('div', { class: 'empty-state__icon' }, icon('clock', 'icon--lg')),
        h('div', { class: 'empty-state__title', text: t('act.tab.empty') }),
        h('div', { class: 'empty-state__text', text: t('act.tab.emptyText') })));
      return;
    }
    const msgs = turnMessages(chat.messages, chat.turn.id).filter((m) => m.role !== 'summary');
    const stats = turnStats(msgs, p.path);
    const rows = buildTimeline(msgs, chat.turn, p.path);
    const head = h('div', { class: 'act__head row between' },
      h('strong', { text: t('artifacts.activity') }),
      chat.running
        ? h('span', { class: 'badge badge--accent' }, h('span', { class: 'spinner' }), t('act.tab.working'))
        : h('span', { class: 'badge badge--muted', text: t('act.tab.lastTurn') }));
    const timeline = h('section', { class: 'act__sec', attrs: { 'aria-label': t('act.tab.timeline') } },
      h('h3', { class: 'act__h', text: t('act.tab.timeline') }),
      rows.length ? h('ol', { class: 'act__tl' }, ...rows.map((r) => timelineRow(r, chat))) : h('div', { class: 'faint small', text: t('act.live.thinking') }));
    root.replaceChildren(head, timeline, filesSection(stats, msgs), commandsSection(msgs));
  }

  store.subscribe((s, prev) => {
    if (s.chats !== prev.chats || s.activeProjectId !== prev.activeProjectId) render();
  });
  paint();
  return { render: paint, update: paint };
}
