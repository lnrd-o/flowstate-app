// Progress dialog for a prerequisite install: streaming log (aria-live off) + one polite status line.
import { h } from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import { installJobs } from '../lib/install-state.js';
import { createLogBox } from './log-box.js';
import { openDialog } from './modal.js';

export function openInstallDialog(id) {
  const log = createLogBox(installJobs, id, { lines: 10 });
  log.el.hidden = false;
  const status = h('p', { class: 'row install-status', attrs: { role: 'status', 'aria-live': 'polite' } });
  const close = h('button', { class: 'btn btn--primary', type: 'button', text: t('common.close') });
  const dlg = openDialog({
    title: t('prereq.installTitle', { name: t('health.' + id) }), body: [status, log.el], footer: [close],
    onClose: () => { off(); log.destroy(); },
  });
  close.addEventListener('click', () => dlg.close('done'));
  function paint() {
    const job = installJobs.get(id);
    status.replaceChildren(...(job.running
      ? [h('span', { class: 'spinner' }), h('span', { text: t('prereq.installing') })]
      : [h('span', { class: 'badge ' + (job.error ? 'badge--red' : 'badge--green') }, h('span', { class: 'badge__dot' }), job.error ? t('prereq.failed') : t('prereq.done')),
        job.error ? h('span', { class: 'muted small', text: job.error }) : null].filter(Boolean)));
  }
  const off = installJobs.subscribe((jid) => { if (jid === id) paint(); });
  paint();
  return dlg;
}
