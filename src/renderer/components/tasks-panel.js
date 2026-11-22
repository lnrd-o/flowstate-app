// Tasks / Agent manager: running agents, background tasks, agent task lists (todos) and subagents. Data: tasks.list + onTasks (store.tasks).
// Simple mode uses plain wording and hides pids / technical ids. Elapsed timers tick every second without re-rendering.
import { h, icon } from '../lib/dom.js';
import { t, getLanguage } from '../lib/i18n.js';
import { isDev } from '../lib/store.js';
import { agentElapsed, elapsedText, groupTasks, serviceTitle, stateBadge } from '../lib/tasks.js';
import { agentIcon } from './agent-icon.js';
import { copyText } from '../lib/clipboard.js';
import { toast } from './modal.js';

const KIND_ICON = { dashboard: 'grid', remote: 'link', methodology: 'layers', login: 'lock', install: 'download', watcher: 'search', daemon: 'terminal' };
const TODO_ICON = { pending: 'circle', in_progress: 'half', completed: 'checkCircle' };

export function mountTasksPanel(host, { store, actions }) {
  host.classList.add('tasks');
  let timers = []; // [{ node, agent }]

  const stateBadgeEl = (state, simple) => {
    const b = stateBadge(state);
    const text = simple && state === 'running' ? t('tasks.thinking') : t(b.key);
    return h('span', { class: 'badge badge--' + b.tone }, h('span', { class: 'badge__dot' }), text);
  };

  const stopBtn = (name, item) => h('button', {
    class: 'btn btn--sm tasks__stop', type: 'button', attrs: { 'aria-label': t('tasks.stopAria', { name }) }, on: { click: (e) => { e.currentTarget.disabled = true; actions.stopTask(item); } },
  }, icon('stop'), t('tasks.stop'));

  function section(id, title, count, children, emptyKey) {
    return h('section', { class: 'card tasks__sec', attrs: { 'aria-labelledby': 'tasks-h-' + id } },
      h('div', { class: 'tasks__head' }, h('h3', { class: 'tasks__title', id: 'tasks-h-' + id, text: title }), count ? h('span', { class: 'badge badge--muted', text: String(count) }) : null),
      children.length ? h('ul', { class: 'tasks__list' }, ...children) : h('div', { class: 'tasks__empty faint small', text: t(emptyKey) }));
  }

  function agentRow(a, dev) {
    const timer = h('span', { class: 'tasks__elapsed mono small muted', attrs: { 'aria-hidden': 'true' } });
    timers.push({ node: timer, agent: a });
    const sub = [a.projectName];
    return h('li', { class: 'tasks__row' },
      h('span', { class: 'tasks__ic' }, agentIcon(a.agent, { size: 20, state: 'running' })),
      h('div', { class: 'tasks__main' },
        h('div', { class: 'tasks__name' }, h('strong', { class: 'truncate', text: a.projectName }), h('span', { class: 'faint small', text: t('agent.' + a.agent) })),
        h('div', { class: 'tasks__meta small' }, stateBadgeEl(a.state, !dev), timer, dev && a.pid ? h('span', { class: 'faint mono xs', text: 'pid ' + a.pid }) : null)),
      stopBtn(a.projectName, { kind: 'agent', id: a.projectId, name: a.projectName, project: sub[0] }));
  }

  function serviceRow(svc, dev) {
    const title = serviceTitle(svc, dev);
    return h('li', { class: 'tasks__row' },
      h('span', { class: 'tasks__ic tasks__ic--svc' }, icon(KIND_ICON[svc.kind] || 'terminal')),
      h('div', { class: 'tasks__main' },
        h('div', { class: 'tasks__name' }, h('strong', { class: 'truncate', text: title }), dev ? h('span', { class: 'faint small', text: t('tasks.kind.' + svc.kind) }) : null),
        h('div', { class: 'tasks__meta small' }, stateBadgeEl(svc.state, false), svc.projectName ? h('span', { class: 'faint', text: svc.projectName }) : null)),
      h('div', { class: 'tasks__acts' },
        svc.url ? h('button', { class: 'btn btn--sm', type: 'button', on: { click: () => window.open(svc.url, '_blank') } }, icon('external'), t('tasks.openUrl')) : null,
        svc.url && dev ? h('button', { class: 'btn btn--sm btn--ghost', type: 'button', on: { click: async () => toast((await copyText(svc.url)) ? t('prompts.copied') : t('errors.generic'), 'success') } }, icon('copy'), t('tasks.copyUrl')) : null,
        svc.stoppable ? stopBtn(title, { kind: svc.kind, id: svc.id, name: title, project: svc.projectName }) : null));
  }

  function todoCard(list) {
    const pct = list.percent;
    return h('li', { class: 'tasks__todo' },
      h('div', { class: 'tasks__todo-head' }, h('strong', { class: 'truncate', text: list.projectName }), h('span', { class: 'small muted', text: t('tasks.progress', { done: list.done, total: list.total }) })),
      h('div', {
        class: 'progress tasks__bar', attrs: { role: 'progressbar', 'aria-label': t('tasks.progress', { done: list.done, total: list.total }) + ' - ' + list.projectName, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct) },
      }, h('div', { class: 'progress__bar', style: 'width:' + pct + '%' })),
      h('ul', { class: 'tasks__items' }, ...list.items.map((it) => h('li', { class: 'tasks__item tasks__item--' + it.status },
        h('span', { class: 'tasks__st', attrs: { 'aria-hidden': 'true' } }, icon(TODO_ICON[it.status] || 'circle')),
        h('span', { class: 'sr-only', text: t('tasks.todo.' + (TODO_ICON[it.status] ? it.status : 'pending')) + ': ' }),
        h('span', { class: 'tasks__item-text', text: it.content })))));
  }

  function subRow(sa, dev) {
    const tone = sa.state === 'error' ? 'red' : sa.state === 'running' ? 'green' : 'muted';
    return h('li', { class: 'tasks__row' },
      h('span', { class: 'tasks__ic tasks__ic--svc' }, icon('sparkles')),
      h('div', { class: 'tasks__main' },
        h('div', { class: 'tasks__name' }, h('strong', { class: 'truncate', text: sa.name }), h('span', { class: 'faint small truncate', text: sa.projectName })),
        sa.description ? h('div', { class: 'tasks__desc small muted', text: sa.description }) : null),
      h('span', { class: 'badge badge--' + tone }, h('span', { class: 'badge__dot' }), t('tasks.sub.' + sa.state)),
      dev && sa.id ? h('span', { class: 'sr-only', text: sa.id }) : null);
  }

  function render() {
    const s = store.get();
    const dev = isDev(s);
    const g = groupTasks(s.tasks, s.projects);
    timers = [];
    host.replaceChildren(h('div', { class: 'tasks__inner' },
      h('div', { class: 'tasks__intro' }, h('h2', { class: 'tasks__h1', text: t('tasks.title') }), h('p', { class: 'muted small', text: t('tasks.intro') })),
      section('agents', dev ? t('tasks.agents') : t('tasks.agentsPlain'), g.agents.length, g.agents.map((a) => agentRow(a, dev)), 'tasks.empty.agents'),
      section('services', dev ? t('tasks.services') : t('tasks.servicesPlain'), g.services.length, g.services.map((x) => serviceRow(x, dev)), 'tasks.empty.services'),
      h('section', { class: 'card tasks__sec', attrs: { 'aria-labelledby': 'tasks-h-todos' } },
        h('div', { class: 'tasks__head' }, h('h3', { class: 'tasks__title', id: 'tasks-h-todos', text: dev ? t('tasks.todos') : t('tasks.todosPlain') }), g.todos.length ? h('span', { class: 'badge badge--muted', text: String(g.todos.length) }) : null),
        g.todos.length ? h('ul', { class: 'tasks__todos' }, ...g.todos.map(todoCard)) : h('div', { class: 'tasks__empty faint small', text: t('tasks.empty.todos') })),
      section('subagents', dev ? t('tasks.subagents') : t('tasks.subagentsPlain'), g.subagents.length, g.subagents.map((x) => subRow(x, dev)), 'tasks.empty.subagents')));
    paintTimers();
  }

  function paintTimers() {
    const now = Date.now();
    for (const x of timers) x.node.textContent = t('tasks.elapsed', { time: elapsedText(agentElapsed(x.agent, now)) });
  }
  setInterval(() => { if (host.isConnected && !document.hidden) paintTimers(); }, 1000);

  store.subscribe((s, prev) => {
    if (s.view !== 'tasks' || !host.isConnected) return;
    if (s.tasks !== prev.tasks || s.projects !== prev.projects || isDev(s) !== isDev(prev) || s.view !== prev.view) render();
  });
  return { render, lang: getLanguage };
}
