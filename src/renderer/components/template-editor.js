// Template editor dialog: id, EN/ES texts, tags, body with {{var}} detection and per-variable settings.
import { h } from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import { slugify, isValidId, parseTags, syncVars, buildTemplate, duplicateId } from '../lib/templates.js';
import { openDialog, toast } from './modal.js';

const TYPES = ['text', 'textarea', 'select'];

export function openTemplateEditor({ template, edit = false, templates, api, onSaved }) {
  const dup = template && template.__duplicateOf ? template.__duplicateOf : null;
  const takenIds = templates.map((x) => x.id);
  const draft = {
    id: edit ? template.id : dup ? duplicateId(dup, takenIds) : '',
    name: { en: template ? template.name.en || '' : '', es: template ? template.name.es || '' : '' },
    description: { en: template ? template.description.en || '' : '', es: template ? template.description.es || '' : '' },
    tags: template ? (template.tags || []).join(', ') : '',
    body: template ? template.body || '' : '',
    vars: template ? JSON.parse(JSON.stringify(template.vars || [])) : [],
  };
  let idTouched = edit || !!dup;

  const mkInput = (id, value, extra = {}) => h('input', { class: 'input', type: 'text', id, value, autocomplete: 'off', spellcheck: false, ...extra });
  const idIn = mkInput('te-id', draft.id, { readOnly: edit, class: 'input mono' });
  const nameEn = mkInput('te-name-en', draft.name.en);
  const nameEs = mkInput('te-name-es', draft.name.es);
  const descEn = mkInput('te-desc-en', draft.description.en);
  const descEs = mkInput('te-desc-es', draft.description.es);
  const tagsIn = mkInput('te-tags', draft.tags);
  const bodyIn = h('textarea', { class: 'textarea mono te-body', id: 'te-body', rows: 9, value: draft.body, spellcheck: false });
  const varsBox = h('div', { class: 'te-vars' });
  const errBox = {};
  const err = (key) => { errBox[key] = h('div', { class: 'field__error', hidden: true, attrs: { role: 'alert' } }); return errBox[key]; };
  const fieldOf = (label, control, key, hint) => h('div', { class: 'field' },
    h('label', { class: 'field__label', for: control.id, text: label }), control,
    hint ? h('div', { class: 'field__hint', text: hint }) : null, err(key));

  idIn.addEventListener('input', () => { idTouched = true; });
  nameEn.addEventListener('input', () => { if (!idTouched && !edit) idIn.value = slugify(nameEn.value); });

  function renderVars() {
    draft.body = bodyIn.value;
    draft.vars = syncVars(draft.body, draft.vars);
    if (!draft.vars.length) { varsBox.replaceChildren(h('div', { class: 'faint small', text: t('prompts.varsNone') })); return; }
    varsBox.replaceChildren(...draft.vars.map((v, i) => {
      const sel = h('select', { class: 'select', id: 'te-v' + i + '-type' }, ...TYPES.map((ty) => h('option', { value: ty, text: t('prompts.type.' + ty) })));
      sel.value = v.type || 'text';
      const labEn = mkInput('te-v' + i + '-len', v.label?.en || '');
      const labEs = mkInput('te-v' + i + '-les', v.label?.es || '');
      const def = mkInput('te-v' + i + '-def', v.default || '');
      const opts = mkInput('te-v' + i + '-opt', (v.options || []).join(', '));
      const req = h('input', { type: 'checkbox', id: 'te-v' + i + '-req', checked: !!v.required });
      const optsField = h('div', { class: 'field', hidden: sel.value !== 'select' },
        h('label', { class: 'field__label', for: opts.id, text: t('prompts.varOptions') }), opts);
      sel.addEventListener('change', () => { v.type = sel.value; optsField.hidden = sel.value !== 'select'; });
      labEn.addEventListener('input', () => { v.label = { ...(v.label || {}), en: labEn.value }; });
      labEs.addEventListener('input', () => { v.label = { ...(v.label || {}), es: labEs.value }; });
      def.addEventListener('input', () => { v.default = def.value; });
      opts.addEventListener('input', () => { v.options = opts.value.split(',').map((x) => x.trim()).filter(Boolean); });
      req.addEventListener('change', () => { v.required = req.checked; });
      return h('div', { class: 'card te-var' },
        h('div', { class: 'te-var__key mono strong', text: '{{' + v.key + '}}' }),
        h('div', { class: 'te-grid' },
          h('div', { class: 'field' }, h('label', { class: 'field__label', for: labEn.id, text: t('prompts.varLabelEn') }), labEn),
          h('div', { class: 'field' }, h('label', { class: 'field__label', for: labEs.id, text: t('prompts.varLabelEs') }), labEs),
          h('div', { class: 'field' }, h('label', { class: 'field__label', for: sel.id, text: t('prompts.varType') }), sel),
          h('div', { class: 'field' }, h('label', { class: 'field__label', for: def.id, text: t('prompts.varDefault') }), def)),
        optsField,
        h('label', { class: 'toggle', for: req.id }, req, h('span', { class: 'toggle__track' }), h('span', { text: t('prompts.varRequired') })));
    }));
  }
  bodyIn.addEventListener('input', renderVars);
  renderVars();

  const cancel = h('button', { class: 'btn', type: 'button', text: t('common.cancel') });
  const save = h('button', { class: 'btn btn--primary', type: 'button', text: t('prompts.save') });
  const dlg = openDialog({
    title: edit ? t('prompts.editorEditTitle') : t('prompts.editorNewTitle'), size: 'lg', footer: [cancel, save],
    body: h('div', { class: 'te' },
      fieldOf(t('prompts.id'), idIn, 'id', t('prompts.idHint')),
      h('div', { class: 'te-grid' }, fieldOf(t('prompts.nameEn'), nameEn, 'name'), fieldOf(t('prompts.nameEs'), nameEs, 'nameEs')),
      h('div', { class: 'te-grid' }, fieldOf(t('prompts.descEn'), descEn, 'descEn'), fieldOf(t('prompts.descEs'), descEs, 'descEs')),
      fieldOf(t('prompts.tags'), tagsIn, 'tags', t('prompts.tagsHint')),
      fieldOf(t('prompts.body'), bodyIn, 'body', t('prompts.bodyHint')),
      h('div', { class: 'field' }, h('div', { class: 'field__label', text: t('prompts.variables') }), varsBox)),
  });
  cancel.addEventListener('click', () => dlg.close('cancel'));

  function showErr(key, msg) { errBox[key].hidden = !msg; errBox[key].textContent = msg || ''; }

  save.addEventListener('click', async () => {
    draft.body = bodyIn.value;
    const id = idIn.value.trim();
    let ok = true;
    const bad = (key, msg, ctl) => { showErr(key, msg); if (ok && ctl) ctl.focus(); ok = false; };
    for (const k of Object.keys(errBox)) showErr(k, '');
    if (!isValidId(id)) bad('id', t('prompts.idInvalid'), idIn);
    else if (!edit && takenIds.includes(id)) bad('id', t('prompts.idTaken'), idIn);
    if (!nameEn.value.trim()) bad('name', t('prompts.nameRequired'), nameEn);
    if (!draft.body.trim()) bad('body', t('prompts.bodyRequired'), bodyIn);
    if (!ok) return;
    const tpl = buildTemplate({
      id, name: { en: nameEn.value.trim(), es: nameEs.value.trim() }, description: { en: descEn.value.trim(), es: descEs.value.trim() },
      tags: parseTags(tagsIn.value), body: draft.body, vars: draft.vars,
    });
    save.disabled = true;
    try {
      const saved = await api.prompts.save(tpl);
      toast(t('prompts.saved'), 'success');
      dlg.close('saved');
      if (onSaved) onSaved(saved || tpl);
    } catch (e) {
      save.disabled = false;
      toast((e && e.message) || t('errors.saveFailed'), 'error');
    }
  });
  return dlg;
}
