// Composer: autosize textarea, agent switch, mode select, send/stop, disabled hints.
import { h, icon, radioKeys } from '../lib/dom.js';
import { t, getLanguage } from '../lib/i18n.js';
import { pickLang, filterTemplates, render as renderTemplate, defaultValues } from '../lib/templates.js';
import { activeProject, isDev } from '../lib/store.js';
import { agentIcon, setIconState } from './agent-icon.js';
import { createAttachments } from './attachments.js';
import { mountModelPicker } from './model-picker.js';
import { suggestionChips } from '../lib/images.js';
import { toast } from './modal.js';

const MODES = ['default', 'acceptEdits', 'plan', 'auto'];
import { disabledSourceOf, enabledAgents } from '../../shared/sources.js';
const AGENTS = ['claude', 'agy', 'opencode'];
/** Agents offered in the switch: opencode only when detected (or already this project's agent). */
export function visibleAgents(project, health) {
  return AGENTS.filter((a) => a !== 'opencode' || (health && health.opencode && health.opencode.found) || (project && project.agent === 'opencode'));
}

/** Why sending is blocked, as an i18n key + vars (or null). Pure; exported for tests of the logic. */
export function sendBlockReason(project, health, signedIn, settings) {
  if (!project) return { key: 'composer.disabledNoProject' };
  const off = settings ? disabledSourceOf(settings, project) : null;
  if (off) return { key: 'composer.disabledSource', vars: { source: t('sources.name.' + off) } };
  if (!health) return null;
  if (health.vpn && health.vpn.active) return { key: 'composer.disabledVpn' };
  const a = health[project.agent];
  if (a && !a.found) return { key: 'composer.disabledMissing', vars: { agent: t('agent.' + project.agent) } };
  const known = signedIn && typeof signedIn[project.agent] === 'boolean' ? signedIn[project.agent] : (a ? a.loggedIn : null);
  if (known === false && project.agent === 'opencode') return { key: 'composer.disabledLoginOpencode' };
  if (known === false) return { key: project.agent === 'agy' ? 'composer.disabledLoginAgy' : 'composer.disabledLogin', signIn: true };
  return null;
}

export function mountComposer(root, { store, api, actions, thumbs }) {
  const drafts = new Map();
  let shownProject = null;

  const input = h('textarea', { class: 'composer__input', rows: 1, id: 'composer-input' });
  const segmented = h('div', { class: 'segmented seg-agent', attrs: { role: 'radiogroup' } });
  const segButtons = AGENTS.map((a) => {
    const b = h('button', { class: 'segmented__item seg-agent__item seg-agent__item--' + a, type: 'button', attrs: { role: 'radio', 'aria-checked': 'false' } },
      agentIcon(a, { size: 14 }), h('span', { class: 'seg-agent__label', text: t('agent.' + a) }));
    b.addEventListener('click', () => {
      const p = activeProject(store.get());
      if (p && p.agent !== a) actions.updateProject(p.id, { agent: a });
    });
    segmented.appendChild(b);
    return b;
  });
  radioKeys(segmented);
  const modeSelect = h('select', { class: 'select select--sm', style: 'width:auto', id: 'composer-mode' },
    ...MODES.map((m) => h('option', { value: m, text: t('mode.' + m) })));
  modeSelect.addEventListener('change', () => {
    const p = activeProject(store.get());
    if (!p) return;
    const want = modeSelect.value;
    // setMode may ask for confirmation ('auto'); whatever the outcome, repaint from the stored project.
    Promise.resolve(actions.setMode ? actions.setMode(p.id, want) : actions.updateProject(p.id, { mode: want })).finally(() => render());
  });
  const autoBadge = h('span', { class: 'badge badge--amber composer__auto-badge', hidden: true, attrs: { role: 'status' } });
  const send = h('button', { class: 'composer__send', type: 'button' });
  const att = createAttachments({
    api, getProjectId: () => store.get().activeProjectId, notify: (m, k, ms) => toast(m, k, ms), onChange: () => render(),
  });
  const picker = mountModelPicker({ store, actions });
  // "Plan first": the next message only proposes a plan (plan mode); the answer becomes a checklist with "Run plan".
  const planBtn = h('button', { class: 'btn btn--ghost btn--sm composer__plan', type: 'button', attrs: { 'aria-pressed': 'false' } }, icon('list'), h('span', { class: 'composer__plan-t' }));
  planBtn.addEventListener('click', () => actions.setPlanFirst && actions.setPlanFirst(!store.get().planFirst));
  const attachBtn = h('button', { class: 'btn btn--ghost btn--icon btn--sm composer__attach', type: 'button' }, icon('image'));
  attachBtn.addEventListener('click', () => att.pick());
  const chipsEl = h('div', { class: 'chips', attrs: { role: 'group' }, hidden: true });
  const agyHint = h('div', { class: 'att-hint faint xs', hidden: true });
  const composer = h('div', { class: 'composer' },
    att.strip, agyHint,
    input,
    h('div', { class: 'composer__toolbar' }, h('div', { class: 'composer__tools' }, segmented, picker.el, picker.effort, modeSelect, planBtn, autoBadge, att.input), h('div', { class: 'composer__actions' }, attachBtn, send)));
  const hint = h('div', { class: 'composer__hint', attrs: { role: 'status' } });
  const hintText = h('span', { class: 'composer__hint-text' });
  const hintBtn = h('button', { class: 'btn btn--sm composer__signin', type: 'button', hidden: true });
  hintBtn.addEventListener('click', () => { const p = activeProject(store.get()); if (p) actions.openLogin(p.agent); });
  hint.append(hintText, hintBtn);
  const slash = h('div', { class: 'menu slash-menu', id: 'slash-menu', hidden: true, attrs: { role: 'listbox', 'aria-label': t('composer.promptPicker') } });
  root.append(h('div', { class: 'composer-wrap__inner' }, slash, chipsEl, composer, hint));
  if (root.parentElement) att.bindDrop(root.parentElement);
  input.setAttribute('aria-controls', 'slash-menu');
  input.setAttribute('aria-expanded', 'false');

  // '/' shortcut: first char opens a template picker.
  let slashItems = [];
  let slashIndex = 0;
  const slashOpen = () => !slash.hidden;
  function closeSlash() {
    slash.hidden = true; slashItems = [];
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }
  function paintSlash() {
    slash.replaceChildren(...slashItems.map((tpl, i) => h('div', {
      class: 'menu__item slash-item' + (i === slashIndex ? ' is-active' : ''), id: 'slash-opt-' + i,
      attrs: { role: 'option', 'aria-selected': String(i === slashIndex) },
      on: { mousedown: (e) => { e.preventDefault(); chooseSlash(tpl); }, mouseenter: () => { slashIndex = i; paintSlash(); } },
    }, h('span', { class: 'slash-item__name truncate', text: pickLang(tpl.name, getLanguage()) || tpl.id }),
    h('span', { class: 'slash-item__hint faint xs', text: (tpl.vars || []).length ? t('composer.slashForm') : t('composer.slashInsert') }))));
    input.setAttribute('aria-activedescendant', 'slash-opt-' + slashIndex);
    const act = slash.querySelector('.is-active');
    if (act) act.scrollIntoView({ block: 'nearest' });
  }
  function updateSlash() {
    const v = input.value;
    if (!v.startsWith('/') || v.includes('\n') || input.disabled) { if (slashOpen()) closeSlash(); return; }
    slashItems = filterTemplates(store.get().templates, v.slice(1).trim(), getLanguage()).slice(0, 8);
    slashIndex = Math.min(slashIndex, Math.max(0, slashItems.length - 1));
    slash.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    if (!slashItems.length) { slash.replaceChildren(h('div', { class: 'faint small slash-empty', text: t('composer.slashNone') })); return; }
    paintSlash();
  }
  function chooseSlash(tpl) {
    closeSlash();
    if ((tpl.vars || []).length) { input.value = ''; autosize(); actions.openTemplate(tpl.id); return; }
    input.value = renderTemplate(tpl.body, defaultValues(tpl.vars), tpl.vars);
    autosize(); input.focus();
  }


  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 240) + 'px';
  }

  function submit() {
    const s = store.get();
    const p = activeProject(s);
    const chat = p && s.chats[p.id];
    const refs = p ? att.refs(p.id) : [];
    const text = input.value.trim() || (refs.length ? t('images.sugg.describe') : '');
    if (!p || !text || (chat && chat.running) || sendBlockReason(p, s.health, s.signedIn, s.settings) || att.busy(p.id)) return;
    input.value = '';
    drafts.delete(p.id);
    if (actions.draftChanged) actions.draftChanged(p.id, '');
    autosize();
    if (refs.length && thumbs) for (const [rel, url] of att.thumbs(p.id)) thumbs.put(p.id, rel, url);
    att.clear(p.id);
    const o = refs.length ? { images: refs } : undefined;
    if (s.planFirst && actions.sendPlan) actions.sendPlan(text, o); else actions.send(text, o);
  }

  /** Insert a suggestion chip's prompt (never sends). */
  function insertPrompt(text) {
    input.value = input.value.trim() ? input.value.replace(/\s+$/, '') + '\n' + text : text;
    autosize();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    if (actions.draftChanged) { const p = activeProject(store.get()); if (p) actions.draftChanged(p.id, input.value); }
  }

  function renderChips(p, chat, dev) {
    const empty = !!p && !(chat && chat.messages.length) && !(chat && chat.running);
    const list = p ? suggestionChips({ imageCount: att.count(p.id), chatEmpty: empty }, t) : [];
    chipsEl.hidden = !list.length;
    chipsEl.setAttribute('aria-label', t('images.chips'));
    chipsEl.replaceChildren(...list.map((c) => h('button', { class: 'chip', type: 'button', text: c.text, on: { click: () => insertPrompt(c.text) } })));
    const n = p ? att.count(p.id) : 0;
    agyHint.hidden = !(p && p.agent === 'agy' && n > 0);
    agyHint.textContent = t('images.agyHint');
  }

  input.addEventListener('input', () => {
    autosize(); updateSlash();
    if (actions.draftChanged) { const p = activeProject(store.get()); if (p) actions.draftChanged(p.id, input.value); }
  });
  input.addEventListener('paste', (e) => { if (att.handlePaste(e)) e.preventDefault(); });
  input.addEventListener('blur', () => { if (slashOpen()) closeSlash(); });
  input.addEventListener('keydown', (e) => {
    if (slashOpen() && slashItems.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); slashIndex = (slashIndex + (e.key === 'ArrowDown' ? 1 : slashItems.length - 1)) % slashItems.length; paintSlash(); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); chooseSlash(slashItems[slashIndex]); return; }
    }
    if (e.key === 'Escape' && slashOpen()) { e.preventDefault(); closeSlash(); return; }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });
  send.addEventListener('click', () => {
    const s = store.get();
    const chat = s.chats[s.activeProjectId];
    if (chat && chat.running) actions.stop();
    else submit();
  });

  function render() {
    const s = store.get();
    const p = activeProject(s);
    const chat = p && s.chats[p.id];
    const running = !!(chat && chat.running);
    if ((p ? p.id : null) !== shownProject) {
      if (shownProject) drafts.set(shownProject, input.value);
      shownProject = p ? p.id : null;
      input.value = (p && drafts.get(p.id)) || '';
      autosize();
      att.repaint();
    }
    const block = sendBlockReason(p, s.health, s.signedIn, s.settings);
    const shown = enabledAgents(s.settings);
    input.placeholder = t('composer.placeholder', { agent: p ? t('agent.' + p.agent) : t('app.name') });
    input.setAttribute('aria-label', input.placeholder);
    input.disabled = !p;
    AGENTS.forEach((a, i) => {
      const on = !!p && p.agent === a;
      segButtons[i].lastChild.textContent = t('agent.' + a);
      setIconState(segButtons[i].firstChild, on && running ? 'running' : 'idle');
      segButtons[i].classList.toggle('is-active', on);
      segButtons[i].setAttribute('aria-checked', String(on));
      segButtons[i].tabIndex = on || (!p && i === 0) ? 0 : -1;
      segButtons[i].disabled = !p || running;
      segButtons[i].hidden = !(shown.includes(a) || on);
    });
    segmented.setAttribute('aria-label', t('agent.switch'));
    const dev = isDev(s);
    [...modeSelect.options].forEach((o) => { o.textContent = t((dev ? 'mode.' : 'mode.friendly.') + o.value); });
    composer.dataset.agent = p ? p.agent : '';
    composer.classList.toggle('is-running', running);
    modeSelect.value = p ? p.mode : 'default';
    const isAuto = !!p && p.mode === 'auto';
    autoBadge.hidden = !isAuto;
    autoBadge.replaceChildren(icon('alert'), ' ' + t('mode.autoBadge'));
    autoBadge.title = t('mode.autoBadgeTitle');
    composer.classList.toggle('is-auto', isAuto);
    modeSelect.disabled = !p || running;
    const pf = !!s.planFirst;
    planBtn.classList.toggle('is-active', pf);
    planBtn.setAttribute('aria-pressed', String(pf));
    planBtn.lastChild.textContent = t('work.plan.toggle');
    planBtn.title = t('work.plan.toggleTitle');
    planBtn.disabled = !p || running;
    modeSelect.setAttribute('aria-label', t('mode.label'));
    send.replaceChildren(icon(running ? 'stop' : 'send'));
    send.classList.toggle('composer__send--stop', running);
    const label = running ? t('composer.stop') : t('composer.send');
    send.setAttribute('aria-label', label);
    send.title = label;
    const uploading = !!p && att.busy(p.id);
    send.disabled = !running && (!!block || uploading);
    attachBtn.setAttribute('aria-label', t('images.attach'));
    attachBtn.title = t('images.attach') + ' (' + t('images.attached', { count: p ? att.count(p.id) : 0, max: 5 }) + ')';
    attachBtn.disabled = !p || running;
    att.relabel();
    renderChips(p, chat, dev);
    picker.render();
    hint.classList.toggle('is-warn', !!block && !!p);
    hintText.textContent = block ? t(block.key, block.vars) : t('composer.hint');
    hintBtn.hidden = !(block && block.signIn);
    hintBtn.textContent = t('banner.signIn');
  }

  const isRunning = (st) => !!(st.chats[st.activeProjectId] && st.chats[st.activeProjectId].running);
  const isEmpty = (st) => !(st.chats[st.activeProjectId] && st.chats[st.activeProjectId].messages.length);
  store.subscribe((s, prev) => {
    if (s.projects !== prev.projects || s.activeProjectId !== prev.activeProjectId || s.health !== prev.health || s.signedIn !== prev.signedIn
      || isRunning(s) !== isRunning(prev) || isEmpty(s) !== isEmpty(prev) || s.models !== prev.models || s.modelsLoading !== prev.modelsLoading || s.settings !== prev.settings || s.planFirst !== prev.planFirst) render();
  });
  render();
  return {
    update: render,
    focus: () => input.focus(),
    openPicker: () => att.pick(),
    addFiles: (files) => att.addFiles(files),
    /** Restore a saved draft for a project (boot / project switch). Never overwrites what the user already typed. */
    setDraft(pid, text) {
      if (!pid || !text) return;
      if (pid === shownProject) { if (!input.value) { input.value = text; autosize(); } } else if (!drafts.get(pid)) drafts.set(pid, text);
    },
    setText(text) {
      input.value = text; autosize(); input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      closeSlash();
    },
  };
}
