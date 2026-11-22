// Store actions for methodologies and runs. Merged into the app `actions` object (see app.js).
import { pickText } from '../../shared/methodology.js';
import { t, tIn, getLanguage } from './i18n.js';
import { uniqueId, newMethodology } from './graph-state.js';
import { duplicateOf, isActiveRun } from './method-utils.js';
import { confirmDialog, toast, openDialog } from '../components/modal.js';
import { openRunDialog } from '../components/run-dialog.js';
import { h } from './dom.js';
import { activeProject } from './store.js';

export function createMethodActions({ store, api, actions }) {
  const errText = (e) => (e && e.message ? String(e.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : t('errors.generic'));
  let token = 0;
  const ids = () => store.get().methods.map((m) => m.id);

  const self = {
    toastError(e) { toast(errText(e), 'error', 7000); },

    async loadMethods({ quiet = false } = {}) {
      try { const list = await api.method.list(store.get().activeProjectId || undefined); store.set({ methods: Array.isArray(list) ? list : [] }); } catch (e) { if (!quiet) toast(t('method.loadFailed', { message: errText(e) }), 'error'); }
    },

    /** Open a methodology object in the editor (view switches to the methodologies page). */
    openMethodEditor(draft, { isNew = false } = {}) {
      token += 1;
      store.set({ view: 'methodologies', editing: { draft, isNew, token } });
    },
    async openMethodEditorById(id) {
      try { self.openMethodEditor(await api.method.get(id, store.get().activeProjectId || undefined)); } catch (e) { self.toastError(e); }
    },
    newMethod() {
      const draft = newMethodology({
        id: uniqueId('new-methodology', ids()),
        name: { en: tIn('en', 'method.newName'), es: tIn('es', 'method.newName') },
        title: { en: tIn('en', 'method.type.prompt'), es: tIn('es', 'method.type.prompt') },
      });
      self.openMethodEditor(draft, { isNew: true });
    },
    async importMethod() {
      try {
        const m = await api.method.import();
        if (!m) return;
        self.openMethodEditor({ ...m, id: uniqueId(m.id, ids()) }, { isNew: true });
        toast(t('method.imported'), 'success');
      } catch (e) { toast(t('method.importFailed', { message: errText(e) }), 'error', 7000); }
    },
    async exportMethod(id) {
      try {
        const r = await api.method.export(id);
        if (r && r.path) toast(t('method.exported', { path: r.path }), 'success', 6000);
      } catch (e) { toast(t('method.exportFailed', { message: errText(e) }), 'error', 7000); }
    },
    async duplicateMethod(id) {
      try {
        const m = await api.method.get(id, store.get().activeProjectId || undefined);
        const copy = duplicateOf(m, uniqueId(id + '-copy', ids()), { en: tIn('en', 'method.copySuffix'), es: tIn('es', 'method.copySuffix') });
        const saved = await api.method.save(copy);
        await self.loadMethods();
        toast(t('method.duplicated', { name: pickText(saved.name, getLanguage()) }), 'success');
      } catch (e) { self.toastError(e); }
    },
    async deleteMethod(id) {
      const sum = store.get().methods.find((m) => m.id === id);
      if (!sum || sum.source === 'bundled') return;
      const ok = await confirmDialog({ title: t('method.delete'), message: t('method.deleteConfirm', { name: pickText(sum.name, getLanguage()) }), confirmLabel: t('common.delete'), danger: true });
      if (!ok) return;
      try { await api.method.delete(id); await self.loadMethods(); toast(t('method.deleted'), 'success'); } catch (e) { self.toastError(e); }
    },

    /** Dialog: name + optional "last N turns", then method.record -> draft in the editor. */
    async recordMethod() {
      const p = activeProject(store.get());
      if (!p) { toast(t('method.record.needProject'), 'warn', 6000); return; }
      let recs = [];
      try { recs = (await api.history.get(p.id)) || []; } catch { recs = []; }
      const users = recs.filter((r) => r && r.t === 'user');
      if (!users.length) { toast(t('method.record.noHistory', { name: p.name }), 'warn', 6000); return; }
      const name = h('input', { class: 'input', id: 'rec-name', type: 'text', value: t('method.record.defaultName', { name: p.name }), autocomplete: 'off' });
      const all = h('input', { type: 'radio', name: 'rec-range', id: 'rec-all', checked: true });
      const last = h('input', { type: 'radio', name: 'rec-range', id: 'rec-last' });
      const n = h('input', { class: 'input rec__n', id: 'rec-n', type: 'number', min: 1, max: users.length, value: Math.min(3, users.length), attrs: { 'aria-label': t('method.record.turns') } });
      n.addEventListener('focus', () => { last.checked = true; });
      const err = h('div', { class: 'field__error', hidden: true, attrs: { role: 'alert' } });
      const cancel = h('button', { class: 'btn', type: 'button', text: t('common.cancel') });
      const go = h('button', { class: 'btn btn--primary', type: 'button', text: t('method.record.go') });
      const dlg = openDialog({
        title: t('method.record.title'), footer: [cancel, go],
        body: h('div', { class: 'col gap-3' }, h('p', { class: 'muted', text: t('method.record.text', { name: p.name, count: users.length }) }),
          h('div', { class: 'field' }, h('label', { class: 'field__label', for: 'rec-name', text: t('method.record.name') }), name),
          h('div', { class: 'field', attrs: { role: 'radiogroup', 'aria-label': t('method.record.range') } },
            h('div', { class: 'field__label', text: t('method.record.range') }),
            h('label', { class: 'row gap-2', for: 'rec-all' }, all, h('span', { text: t('method.record.all') })),
            h('div', { class: 'row gap-2' }, last, h('label', { for: 'rec-n', text: t('method.record.lastN') }), n)),
          err),
      });
      cancel.addEventListener('click', () => dlg.close('cancel'));
      go.addEventListener('click', async () => {
        const opts = { name: name.value.trim() || undefined };
        if (last.checked) {
          const k = Math.max(1, Math.min(users.length, parseInt(n.value, 10) || 1));
          opts.fromTs = users[users.length - k].ts;
        }
        go.disabled = true; err.hidden = true;
        try {
          const draft = await api.method.record(p.id, opts);
          dlg.close('ok');
          self.openMethodEditor(draft, { isNew: true });
          toast(t('method.record.done'), 'success');
        } catch (e) {
          err.textContent = errText(e); err.hidden = false; go.disabled = false;
        }
      });
    },

    // ---- runs ----
    runMethod(id, projectId) { return openRunDialog({ store, api, actions, methodologyId: id, projectId }); },
    async startRun(projectId, methodologyId, vars) {
      await api.method.run(projectId, methodologyId, vars);
      if (store.get().activeProjectId !== projectId || store.get().view !== 'project') await actions.selectProject(projectId);
      await self.refreshRun(projectId);
    },
    async refreshRun(projectId) {
      try {
        const st = await api.method.runState(projectId);
        if (st) self.setRun(projectId, st);
      } catch { /* backend not ready */ }
    },
    setRun(projectId, state) {
      const prev = store.get().runs[projectId];
      store.set((s) => ({ runs: { ...s.runs, [projectId]: state } }));
      const p = store.get().projects.find((x) => x.id === projectId);
      const away = store.get().activeProjectId !== projectId || store.get().view !== 'project';
      if (p && away && (!prev || prev.status !== state.status)) {
        if (state.status === 'waiting') toast(t('method.run.toastWaiting', { name: p.name }), 'warn', 8000);
        else if (['done', 'error', 'stopped'].includes(state.status)) toast(t('method.run.toast.' + state.status, { name: p.name }), state.status === 'done' ? 'success' : state.status === 'error' ? 'error' : undefined, 6000);
      }
    },
    async respondRun(state, nodeId, response) {
      try { await api.method.respond(state.runId, nodeId, response); } catch (e) { self.toastError(e); }
    },
    async stopRun(state) {
      try { await api.method.stop(state.runId); } catch (e) { self.toastError(e); }
    },
    isRunActive: (pid) => isActiveRun(store.get().runs[pid]),
  };
  return self;
}
