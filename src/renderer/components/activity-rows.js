// Chat rows besides tool cards: thinking rows, the per-turn summary card and the live status line.
import { h, icon, nextId } from '../lib/dom.js';
import { t, getLanguage } from '../lib/i18n.js';
import { formatDuration, formatCount, elapsedSeconds, hasActivity } from '../lib/activity.js';

/** Collapsed single line "Thought for 17.3 s - 1,600 tokens"; expandable only when the agent sent reasoning text (claude). */
export function buildThinkingRow() {
  const label = h('span', { class: 'think-row__label' });
  const bodyId = nextId('think');
  const body = h('div', { class: 'think-row__text', id: bodyId, hidden: true });
  const chevron = icon('chevron', 'tool-card__chevron');
  const head = h('button', { class: 'think-row__head', type: 'button', attrs: { 'aria-expanded': 'false', 'aria-controls': bodyId } }, icon('sparkles', 'think-row__icon'), label, chevron);
  const plain = h('div', { class: 'think-row__head think-row__head--plain' }, icon('sparkles', 'think-row__icon'));
  const plainLabel = h('span', { class: 'think-row__label' });
  plain.append(plainLabel);
  const el = h('div', { class: 'think-row' });
  let open = false;
  head.addEventListener('click', () => {
    open = !open;
    head.setAttribute('aria-expanded', String(open));
    body.hidden = !open;
    el.classList.toggle('is-open', open);
  });
  return {
    el,
    update(m) {
      const loc = getLanguage();
      const time = m.durationMs > 0 ? formatDuration(m.durationMs) : '';
      const tokens = formatCount(m.tokens || 0, loc);
      const text = time && m.tokens ? t('act.thoughtForTokens', { time, tokens })
        : time ? t('act.thoughtFor', { time }) : m.tokens ? t('act.thoughtTokens', { tokens }) : t('act.thought');
      if (m.text) {
        label.textContent = text;
        body.textContent = m.text;
        el.replaceChildren(head, body);
      } else {
        plainLabel.textContent = text;
        el.replaceChildren(plain);
      }
    },
  };
}

/** "N files changed (+A -D), M commands, thinking T s" with the changed files and an Expand all / Collapse all control. */
export function buildSummaryCard() {
  const el = h('div', { class: 'turn-summary', attrs: { role: 'group' } });
  let allOpen = false;
  let sig = '';
  return {
    el,
    update(m, ctx) {
      const stats = ctx.stats(m.turn);
      el.hidden = !hasActivity(stats);
      const nextSig = JSON.stringify([stats, allOpen, getLanguage(), ctx.root]);
      if (nextSig === sig) return;
      sig = nextSig;
      el.setAttribute('aria-label', t('act.summary.label'));
      const loc = getLanguage();
      const bits = [];
      if (stats.files.length) {
        bits.push(h('span', { class: 'turn-summary__bit' },
          stats.files.length === 1 ? t('act.summary.filesOne') : t('act.summary.filesMany', { count: stats.files.length }), ' ',
          h('span', { class: 'tc-add', text: '+' + formatCount(stats.added, loc) }), ' ', h('span', { class: 'tc-del', text: '-' + formatCount(stats.removed, loc) })));
      }
      if (stats.commands) {
        bits.push(h('span', { class: 'turn-summary__bit' },
          stats.commands === 1 ? t('act.summary.commandsOne') : t('act.summary.commandsMany', { count: stats.commands }),
          stats.failed ? h('span', { class: 'tc-del', text: ' (' + t('act.summary.commandsFailed', { count: stats.failed }) + ')' }) : null));
      }
      if (stats.thinkingMs) bits.push(h('span', { class: 'turn-summary__bit', text: t('act.summary.thinking', { time: formatDuration(stats.thinkingMs) }) }));
      const head = h('div', { class: 'turn-summary__head' }, icon('layers', 'turn-summary__icon'),
        h('div', { class: 'turn-summary__stats' }, ...bits.flatMap((b, i) => (i ? [h('span', { class: 'turn-summary__sep', text: ',', attrs: { 'aria-hidden': 'true' } }), ' ', b] : [b]))),
        h('button', {
          class: 'btn btn--ghost btn--sm', type: 'button', text: allOpen ? t('act.summary.collapseAll') : t('act.summary.expandAll'),
          on: { click: () => { allOpen = !allOpen; ctx.setTurnOpen(m.turn, allOpen); sig = ''; this.update(m, ctx); } },
        }));
      const files = stats.files.length ? h('ul', { class: 'turn-summary__files' }, ...stats.files.map((f) => h('li', { class: 'turn-summary__file' },
        h('button', { class: 'turn-summary__path', type: 'button', title: t('act.summary.goToCard'), on: { click: () => ctx.reveal(f.ids[0]) } },
          icon('file'), h('span', { class: 'truncate mono', text: f.path })),
        h('span', { class: 'tc-delta' }, f.added ? h('span', { class: 'tc-add', text: '+' + f.added }) : null, f.removed ? h('span', { class: 'tc-del', text: '-' + f.removed }) : null),
        f.op === 'delete' ? null : h('button', {
          class: 'btn btn--ghost btn--icon btn--sm', type: 'button', title: t('act.openFileTitle', { file: f.path }),
          attrs: { 'aria-label': t('act.openFileTitle', { file: f.path }) }, on: { click: () => ctx.openFile(f.path) },
        }, icon('external')))) ) : null;
      el.replaceChildren(head, ...(files ? [files] : []));
    },
  };
}

/** Live status line while the agent works: Thinking... / Running <title>... / Writing the answer..., with an elapsed counter. */
export function createLiveStatus() {
  const text = h('span', { class: 'live-status__text' });
  const secs = h('span', { class: 'live-status__secs faint' });
  const sr = h('span', { class: 'sr-only', attrs: { role: 'status', 'aria-live': 'polite' } });
  const visible = h('span', { class: 'live-status__visible', attrs: { 'aria-hidden': 'true' } },
    h('span', { class: 'thinking-dots' }, h('span'), h('span'), h('span')), text, secs);
  const el = h('div', { class: 'msg msg--assistant live-status' }, visible, sr);
  let timer = null;
  let since = null;
  let key = '';
  let phaseSince = null;
  const tick = () => {
    const base = since != null ? since : phaseSince;
    secs.textContent = base != null ? t('act.live.elapsed', { seconds: elapsedSeconds(base, Date.now()) }) : '';
  };
  return {
    el,
    update(phase, root) {
      const title = phase.title ? t(phase.title.key, phase.title.vars) : String(phase.name || '');
      const label = phase.key === 'tool' ? (phase.cmd ? t('act.live.running', { title: phase.cmd }) : title + '...') : phase.key === 'writing' ? t('act.live.writing') : t('act.live.thinking');
      const k = phase.key + ':' + (phase.id || '');
      if (k !== key) { key = k; phaseSince = Date.now(); sr.textContent = label; } // announce phase changes only
      since = phase.since;
      text.textContent = label;
      tick();
      if (!timer) timer = setInterval(tick, 1000);
    },
    stop() { if (timer) { clearInterval(timer); timer = null; } key = ''; },
  };
}
