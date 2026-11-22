// Simple mode rows: the "What I did" list (plain-language steps) and the friendly summary with Open file buttons.
// Built from the same chat events as the technical cards (lib/plain.js); never shows code, commands or tool names.
import { h, icon } from '../lib/dom.js';
import { t, getLanguage } from '../lib/i18n.js';
import { plainSteps, stepsState, summaryParts, openableFiles } from '../lib/plain.js';
import { turnMessages, turnStats, hasActivity } from '../lib/activity.js';
import { agentIcon } from './agent-icon.js';

function stateIcon(state) {
  if (state === 'running') return h('span', { class: 'spinner', attrs: { 'aria-hidden': 'true' } });
  return icon(state === 'failed' ? 'x' : state === 'blocked' ? 'lock' : 'check');
}

/** "What I did" card for one turn; the "Show details" link expands that turn's technical cards only. */
export function buildPlainSteps() {
  const el = h('div', { class: 'plain-steps', attrs: { role: 'group' } });
  let sig = '';
  return {
    el,
    update(turnId, ctx) {
      const msgs = ctx.messages();
      const steps = plainSteps(msgs, turnId, ctx.root);
      const detail = ctx.detailTurns.has(turnId);
      const state = stepsState(steps);
      const agent = (msgs.find((m) => m.turn === turnId && m.agent) || {}).agent || ctx.agent;
      const nextSig = JSON.stringify([steps.map((s) => [s.id, s.key, s.vars, s.state]), detail, getLanguage(), agent, state]);
      if (nextSig === sig) return;
      sig = nextSig;
      el.className = 'plain-steps is-' + state;
      el.setAttribute('aria-label', t('plain.whatIDid'));
      const title = state === 'running' ? t('plain.working') : t('plain.whatIDid');
      const head = h('div', { class: 'plain-steps__head' }, agentIcon(agent, { size: 16, state: state === 'running' ? 'running' : 'idle' }), h('strong', { text: title }));
      const list = h('ul', { class: 'plain-steps__list' }, ...steps.map((s) => h('li', { class: 'plain-step is-' + s.state },
        h('span', { class: 'plain-step__ic' }, stateIcon(s.state)), h('span', { class: 'plain-step__text', text: t(s.key, s.vars) }))));
      const more = h('button', {
        class: 'btn btn--ghost btn--sm plain-steps__more', type: 'button', attrs: { 'aria-expanded': String(detail) },
        text: detail ? t('plain.hideDetails') : t('plain.showDetails'), on: { click: () => ctx.toggleDetails(turnId) },
      });
      el.replaceChildren(head, list, more);
    },
  };
}

/** "I created 1 file and changed 1 file." + one Open file button per file. Hidden when nothing worth saying. */
export function buildPlainSummary() {
  const el = h('div', { class: 'plain-summary', attrs: { role: 'group' } });
  let sig = '';
  return {
    el,
    update(m, ctx) {
      const stats = turnStats(turnMessages(ctx.messages(), m.turn), ctx.root);
      const parts = summaryParts(stats);
      el.hidden = !hasActivity(stats) || !parts.length;
      const files = openableFiles(stats);
      const nextSig = JSON.stringify([parts, files, getLanguage(), ctx.root]);
      if (nextSig === sig) return;
      sig = nextSig;
      if (!parts.length) { el.replaceChildren(); return; }
      const joined = parts.map((p) => t(p.key, p.vars)).join(t('plain.sum.and'));
      el.setAttribute('aria-label', t('plain.summaryLabel'));
      const line = h('div', { class: 'plain-summary__line' }, icon('check', 'plain-summary__ic'), h('span', { text: t('plain.sum.sentence', { parts: joined }) }));
      const btns = files.length ? h('div', { class: 'plain-summary__files' }, ...files.map((f) => h('button', {
        class: 'btn btn--sm', type: 'button', title: t('act.openFileTitle', { file: f.path }), on: { click: () => ctx.openFile(f.path) },
      }, icon('external'), h('span', { text: t('plain.openFile') }), files.length > 1 ? h('span', { class: 'mono faint plain-summary__name', text: f.path }) : null))) : null;
      el.replaceChildren(line, ...(btns ? [btns] : []));
    },
  };
}
