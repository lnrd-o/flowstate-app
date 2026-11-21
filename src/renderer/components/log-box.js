// Streaming log box bound to a job in lib/install-state.js. Log text is aria-live off (too chatty);
// a separate polite status line announces only start / done / error.
import { h } from '../lib/dom.js';
import { t } from '../lib/i18n.js';

export function createLogBox(jobs, id, { lines = 8 } = {}) {
  const pre = h('pre', { class: 'log-box mono', attrs: { role: 'log', 'aria-live': 'off', tabindex: '0', 'aria-label': t('log.label') } });
  const status = h('div', { class: 'sr-only', attrs: { role: 'status', 'aria-live': 'polite' } });
  const el = h('div', { class: 'log-wrap' }, pre, status);
  pre.style.setProperty('--log-lines', String(lines));
  let last = '';
  function paint() {
    const job = jobs.get(id);
    pre.textContent = job.lines.length ? job.lines.join('\n') : (job.running ? t('log.waiting') : '');
    pre.scrollTop = pre.scrollHeight;
    el.hidden = !job.running && !job.lines.length && !job.error;
    const state = job.running ? 'running' : job.error ? 'error' : job.done ? 'done' : 'idle';
    if (state !== last) {
      last = state;
      status.textContent = state === 'running' ? t('log.started') : state === 'done' ? t('log.done') : state === 'error' ? t('log.failed') : '';
    }
  }
  const off = jobs.subscribe((jid) => { if (jid === id) paint(); });
  paint();
  return { el, repaint: paint, destroy: off };
}
