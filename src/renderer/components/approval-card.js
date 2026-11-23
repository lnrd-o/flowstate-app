// Approval card: one per turn that ended with blocked actions. Plain sentence + reason + the exact code
// (Developer mode: inline; Simple mode: collapsed under "See exactly what it will do").
// Buttons: Allow this once (per-turn allow rule) / Allow for this project / Don't allow. See lib/approvals.js.
import { h, icon, nextId } from '../lib/dom.js';
import { t, getLanguage } from '../lib/i18n.js';
import { allowPlan, describeItem, whyKey, itemCommand, webTarget, projectModeFor, protectionOf } from '../lib/approvals.js';
import { diffFromInput } from '../lib/diff.js';
import { createDiffView } from './diff-view.js';
import { agentIcon } from './agent-icon.js';

const KIND_ICON = { command: 'terminal', write: 'file', edit: 'edit', read: 'file', web: 'globe', other: 'tool' };

/** The exact code of one blocked item: a terminal block for commands, a diff / new-file view for edits. */
export function codeBlock(item) {
  if (item.kind === 'command') {
    const cmd = itemCommand(item);
    return h('pre', { class: 'tc-term__pre approval-term', attrs: { tabindex: '0', role: 'region', 'aria-label': t('approval.codeLabel') } },
      h('span', { class: 'tc-term__cmd', text: '$ ' + (cmd || item.tool) }));
  }
  if (item.kind === 'web') {
    const target = webTarget(item);
    return h('pre', { class: 'tc-term__pre approval-term', attrs: { tabindex: '0', role: 'region', 'aria-label': t('approval.codeLabel') } },
      h('span', { class: 'tc-term__cmd', text: (item.tool === 'WebSearch' ? t('approval.searchPrefix') + ' ' : '') + (target || item.tool) }));
  }
  if (item.kind === 'read') {
    const p = item.input && typeof item.input === 'object' ? (item.input.file_path || item.input.path || '') : '';
    return h('pre', { class: 'tc-term__pre approval-term', attrs: { tabindex: '0', role: 'region', 'aria-label': t('approval.codeLabel') } },
      h('span', { class: 'tc-term__cmd', text: String(p || item.tool) }));
  }
  const ch = (item.kind === 'write' || item.kind === 'edit') ? diffFromInput(item.kind, item.input) : null;
  if (ch && ch.diff) return h('div', { class: 'approval-diff' }, createDiffView({ diff: ch.diff, path: ch.path, hideNumbers: ch.op !== 'create' }).el);
  let raw = '';
  try { raw = item.input ? JSON.stringify(item.input, null, 2) : ''; } catch { raw = String(item.input); }
  return h('pre', { class: 'tc-preview approval-raw', text: raw.length > 3000 ? raw.slice(0, 3000) + '\n...' : raw || t('approval.noCode'), attrs: { tabindex: '0', role: 'region', 'aria-label': t('approval.codeLabel') } });
}

export function buildApprovalCard() {
  const el = h('div', { class: 'approval-card', attrs: { role: 'group' } });
  let selected = new Set();
  let itemsKey = '';
  let sig = '';
  let focusedFor = '';
  let primaryBtn = null;
  let current = null;
  let currentCtx = null;

  function setSelected(next) { selected = next; sig = ''; if (current) update(current, currentCtx); }

  function itemRow(item, ctx, multi, interactive) {
    const d = describeItem(item, ctx.root);
    const agent = ctx.agentName;
    const what = t(d.key, { ...d.vars, agent });
    const cat = protectionOf(item, ctx);
    const why = t(whyKey(item.reason, cat));
    const head = h('div', { class: 'approval-item__what' }, icon(KIND_ICON[item.kind] || 'tool', 'approval-item__ic'), h('strong', { text: what }));
    const whyEl = h('div', { class: 'approval-item__why small muted' + (cat ? ' approval-item__why--protected' : ''), text: why });
    const code = codeBlock(item);
    let codeHost;
    if (ctx.dev) codeHost = h('div', { class: 'approval-item__code' }, code);
    else {
      codeHost = h('details', { class: 'approval-more' }, h('summary', { class: 'approval-more__sum', text: t('approval.seeExactly') }), h('div', { class: 'approval-item__code' }, code));
    }
    const body = h('div', { class: 'approval-item__body' }, head, whyEl, codeHost);
    if (!multi) return h('li', { class: 'approval-item' }, body);
    const id = nextId('appr');
    const cb = h('input', { type: 'checkbox', id, checked: selected.has(item.id), disabled: !interactive });
    cb.addEventListener('change', () => { const n = new Set(selected); if (cb.checked) n.add(item.id); else n.delete(item.id); setSelected(n); });
    return h('li', { class: 'approval-item approval-item--multi' },
      h('label', { class: 'approval-item__check', for: id, title: t('approval.selectOne') }, cb, h('span', { class: 'sr-only', text: what })), body);
  }

  function update(m, ctx) {
    current = m; currentCtx = ctx;
    const items = ctx.approvalItems(m.turn);
    const key = items.map((i) => i.id).join(',');
    if (key !== itemsKey) { itemsKey = key; selected = new Set(items.map((i) => i.id)); }
    const actionable = m.status === 'pending' && ctx.isActionable(m) && items.length > 0;
    const plan = allowPlan(items, selected, ctx.agent, { agent: ctx.agent, mode: ctx.mode, protections: ctx.protections, root: ctx.root });
    const projMode = projectModeFor(items, selected);
    const nextSig = JSON.stringify([m.status, actionable, ctx.dev, getLanguage(), key, [...selected], plan.mode, plan.rules, plan.unprotect, plan.protectedSelected, projMode, ctx.agent, ctx.root, ctx.mode, ctx.protections,
      items.map((i) => [i.reason, i.input && (i.input.command || i.input.file_path || i.input.url || i.input.query)])]);
    if (nextSig === sig) return;
    sig = nextSig;
    const multi = items.length > 1;
    el.className = 'approval-card' + (m.status !== 'pending' || !actionable ? ' is-resolved' : '');
    el.setAttribute('aria-label', t('approval.title'));

    const headTitle = t(multi ? 'approval.titleMany' : 'approval.title');
    const head = h('div', { class: 'approval-card__head' },
      h('span', { class: 'approval-card__lock' }, icon('lock')),
      h('div', { class: 'approval-card__titles' },
        h('div', { class: 'approval-card__title', text: headTitle }),
        h('div', { class: 'approval-card__sub small muted', text: multi ? t('approval.subMany', { agent: ctx.agentName, count: items.length }) : t('approval.sub', { agent: ctx.agentName }) })),
      agentIcon(ctx.agent, { size: 16 }));
    const list = h('ul', { class: 'approval-list' }, ...items.map((it) => itemRow(it, ctx, multi, actionable)));
    const parts = [head, list];

    if (m.status === 'allowed') {
      parts.push(h('div', { class: 'approval-card__status small', attrs: { role: 'status' } }, icon('check'), t('approval.statusAllowed')));
    } else if (m.status === 'dismissed') {
      parts.push(h('div', { class: 'approval-card__status small muted', attrs: { role: 'status' } }, icon('x'), t('approval.statusDismissed')));
    } else if (!actionable) {
      parts.push(h('div', { class: 'approval-card__status small muted', attrs: { role: 'status' } }, t('approval.statusStale')));
    } else {
      const actions = h('div', { class: 'approval-card__actions' });
      primaryBtn = null;
      if (plan.mode === 'once') {
        primaryBtn = h('button', { class: 'btn btn--primary', type: 'button', text: multi ? (selected.size === items.length ? t('approval.acceptAll', { n: items.length }) : t('approval.allowSelected')) : t('approval.allowOnce'), on: { click: () => ctx.approve.once(m.id, plan.rules, plan.unprotect) } });
        if (plan.protectedSelected) {
          // Protections stay on in Auto-accept: "for this project" would only be refused again, so only "once" is offered.
          parts.push(h('div', { class: 'approval-card__note small', attrs: { role: 'note' } }, icon('lock'), t('approval.protectedNote')));
          actions.append(primaryBtn);
        } else actions.append(primaryBtn,
          h('button', { class: 'btn', type: 'button', text: t(projMode === 'auto' ? 'approval.allowProjectAuto' : 'approval.allowProject'), title: t(projMode === 'auto' ? 'approval.allowProjectAutoTitle' : 'approval.allowProjectTitle'), on: { click: () => ctx.approve.project(m.id, projMode) } }));
      } else if (plan.protectedSelected) {
        parts.push(h('div', { class: 'approval-card__note small', attrs: { role: 'note' } }, icon('lock'), t('approval.noNarrowProtected')));
      } else {
        parts.push(h('div', { class: 'approval-card__note small', attrs: { role: 'note' } }, icon('info'),
          ctx.agent === 'claude' ? t('approval.noNarrowClaude') : t('approval.noNarrowAgy', { agent: ctx.agentName })));
        primaryBtn = h('button', { class: 'btn btn--primary', type: 'button', disabled: plan.mode === 'none', text: t(projMode === 'auto' ? 'approval.switchRetryAuto' : 'approval.switchRetry'), on: { click: () => ctx.approve.project(m.id, projMode) } });
        actions.append(primaryBtn);
      }
      actions.append(h('button', { class: 'btn btn--ghost', type: 'button', text: t('approval.dismiss'), on: { click: () => ctx.approve.dismiss(m.id) } }));
      if (ctx.dev) {
        actions.append(h('span', { class: 'approval-card__hint faint xs' }, h('span', { class: 'kbd', text: 'Enter' }), ' ', t('approval.hintAllow'), ' ', h('span', { class: 'kbd', text: 'Esc' }), ' ', t('approval.hintDismiss')));
      }
      parts.push(actions);
    }
    el.replaceChildren(...parts);
    if (actionable && focusedFor !== m.id && primaryBtn && !primaryBtn.disabled) {
      focusedFor = m.id;
      const a = document.activeElement;
      const typing = a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT') && a.value;
      if (!typing) primaryBtn.focus({ preventScroll: true });
    }
  }

  el.addEventListener('keydown', (e) => {
    if (!current || !currentCtx || !currentCtx.dev || current.status !== 'pending' || !currentCtx.isActionable(current)) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); currentCtx.approve.dismiss(current.id); return; }
    if (e.key === 'Enter' && !e.target.closest('button, input, summary, a')) {
      if (primaryBtn && !primaryBtn.disabled) { e.preventDefault(); primaryBtn.click(); }
    }
  });
  el.tabIndex = -1;
  return { el, update };
}
