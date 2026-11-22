// "Project data" dialog: what FlowState keeps inside <project>/.flowstate (store.status), with Save now / Clear history / Delete all / Reveal folder.
import { h, icon } from '../lib/dom.js';
import { t, onChange, getLanguage } from '../lib/i18n.js';
import { sizeText } from '../lib/images.js';
import { openDialog } from './modal.js';

const stamp = (ms) => {
  try { return new Intl.DateTimeFormat(getLanguage() === 'es' ? 'es' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms)); } catch { return ''; }
};

/** Rows of the file list from a StoreStatus. Pure; exported for tests. */
export function fileRows(st) {
  const s = st || {};
  return [
    { id: 'project', key: 'pdata.fileProject', present: !!s.hasProject, size: null, shared: true },
    { id: 'state', key: 'pdata.fileState', present: !!s.hasState, size: null, shared: false },
    { id: 'history', key: 'pdata.fileHistory', present: (s.historyBytes || 0) > 0, size: s.historyBytes || 0, shared: false },
    { id: 'attachments', key: 'pdata.fileAttachments', present: (s.attachmentsBytes || 0) > 0, size: s.attachmentsBytes || 0, shared: false },
  ];
}

export function openProjectDataDialog({ store, api, actions, projectId }) {
  const project = store.get().projects.find((p) => p.id === projectId);
  if (!project) return null;
  const body = h('div', { class: 'pdata' });
  const closeBtn = h('button', { class: 'btn btn--primary', type: 'button', text: t('common.close') });
  let unsub = () => {};
  const dlg = openDialog({ title: t('pdata.title'), body, footer: [closeBtn], size: 'lg', onClose: () => unsub() });
  closeBtn.addEventListener('click', () => dlg.close('done'));
  let busy = false;

  async function load() {
    await actions.refreshStoreStatus(projectId);
    render();
  }
  async function run(fn) {
    if (busy) return;
    busy = true; render();
    try { await fn(); } finally { busy = false; await actions.refreshStoreStatus(projectId); render(); }
  }

  function render() {
    const st = store.get().storeStatus[projectId];
    dlg.setTitle(t('pdata.title') + ' - ' + project.name);
    closeBtn.textContent = t('common.close');
    const rows = st ? fileRows(st).map((r) => h('li', { class: 'pdata__file' },
      h('span', { class: 'pdata__file-name', text: t(r.key) }),
      h('span', { class: 'pdata__file-meta' },
        r.size != null && r.present ? h('span', { class: 'faint small', text: sizeText(r.size) }) : null,
        h('span', { class: 'badge ' + (r.present ? 'badge--green' : 'badge--muted') }, h('span', { class: 'badge__dot' }), r.present ? t('pdata.present') : t('pdata.absent')),
        r.present ? h('span', { class: 'badge ' + (r.shared ? 'badge--accent' : (st.gitignored ? 'badge--muted' : 'badge--amber')), text: r.shared ? t('pdata.shareable') : (st.gitignored ? t('pdata.gitignored') : t('pdata.notIgnored')) }) : null))) : [];
    body.replaceChildren(
      h('p', { class: 'pdata__explain', text: t('pdata.explain') }),
      !st ? h('div', { class: 'row muted' }, h('span', { class: 'spinner' }), t('pdata.loading')) : h('div', { class: 'pdata__body' },
        h('div', { class: 'field' }, h('div', { class: 'field__label', text: t('pdata.folder') }), h('div', { class: 'pdata__path mono small', title: st.dir, text: st.dir }),
          h('div', { class: 'row gap-2 wrap' }, h('span', { class: 'badge ' + (st.exists ? 'badge--green' : 'badge--amber') }, h('span', { class: 'badge__dot' }), st.exists ? t('pdata.exists') : t('pdata.missing')),
            h('span', { class: 'faint small', text: st.lastSavedAt ? t('pdata.lastSaved', { time: stamp(st.lastSavedAt) }) : t('pdata.neverSaved') }))),
        h('div', { class: 'field' }, h('div', { class: 'field__label', text: t('pdata.files') }), h('ul', { class: 'pdata__files card card--flush' }, ...rows))),
      h('div', { class: 'pdata__actions' },
        h('button', { class: 'btn', type: 'button', disabled: busy || !st, on: { click: () => run(() => actions.saveProjectNow(projectId)) } }, icon('check'), t('pdata.saveNow')),
        h('button', { class: 'btn', type: 'button', disabled: busy || !st, on: { click: () => run(() => actions.clearHistory(projectId)) } }, icon('trash'), t('pdata.clearHistory')),
        h('button', { class: 'btn', type: 'button', disabled: busy || !st, on: { click: () => actions.revealStore(projectId) } }, icon('folder'), t('pdata.reveal')),
        h('button', { class: 'btn btn--danger', type: 'button', disabled: busy || !st, on: { click: () => run(async () => { if (await actions.deleteProjectData(projectId)) dlg.close('deleted'); }) } }, icon('trash'), t('pdata.deleteAll'))));
  }

  render();
  load();
  unsub = onChange(() => render());
  return dlg;
}
