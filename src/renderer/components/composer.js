// Composer: autosize textarea, agent switch, mode select, send/stop, disabled hints.
import { h, icon, radioKeys } from '../lib/dom.js';
import { t, getLanguage } from '../lib/i18n.js';
import { pickLang, filterTemplates, render as renderTemplate, defaultValues } from '../lib/templates.js';
import { activeProject, isDev } from '../lib/store.js';
import { agentIcon, setIconState } from './agent-icon.js';

const MODES = ['default', 'acceptEdits', 'plan'];
const AGENTS = ['claude', 'agy'];

/** Why sending is blocked, as an i18n key + vars (or null). Pure; exported for tests of the logic. */
export function sendBlockReason(project, health, signedIn) {
  if (!project) return { key: 'composer.disabledNoProject' };
  if (!health) return null;
  if (health.vpn && health.vpn.active) return { key: 'composer.disabledVpn' };
  const a = health[project.agent];
  if (a && !a.found) return { key: 'composer.disabledMissing', vars: { agent: t('agent.' + project.agent) } };
  const known = signedIn && typeof signedIn[project.agent] === 'boolean' ? signedIn[project.agent] : (a ? a.loggedIn : null);
  if (known === false) return { key: project.agent === 'agy' ? 'composer.disabledLoginAgy' : 'composer.disabledLogin', signIn: true };
  return null;
}

export function mountComposer(root, { store, api, actions }) {
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
    if (p) actions.updateProject(p.id, { mode: modeSelect.value });
  });
  const send = h('button', { class: 'composer__send', type: 'button' });
  const composer = h('div', { class: 'composer' },
    input,
    h('div', { class: 'composer__toolbar' }, segmented, modeSelect, h('span', { class: 'composer__spacer' }), send));
  const hint = h('div', { class: 'composer__hint', attrs: { role: 'status' } });
  const hintText = h('span', { class: 'composer__hint-text' });
  const hintBtn = h('button', { class: 'btn btn--sm composer__signin', type: 'button', hidden: true });
  hintBtn.addEventListener('click', () => { const p = activeProject(store.get()); if (p) actions.openLogin(p.agent); });
  hint.append(hintText, hintBtn);
  const slash = h('div', { class: 'menu slash-menu', id: 'slash-menu', hidden: true, attrs: { role: 'listbox', 'aria-label': t('composer.promptPicker') } });
  root.append(h('div', { class: 'composer-wrap__inner' }, slash, composer, hint));
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
    const text = input.value.trim();
    if (!p || !text || (chat && chat.running) || sendBlockReason(p, s.health, s.signedIn)) return;
    input.value = '';
    drafts.delete(p.id);
    autosize();
    actions.send(text);
  }

  input.addEventListener('input', () => { autosize(); updateSlash(); });
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
    }
    const block = sendBlockReason(p, s.health, s.signedIn);
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
    });
    segmented.setAttribute('aria-label', t('agent.switch'));
    const dev = isDev(s);
    [...modeSelect.options].forEach((o) => { o.textContent = t((dev ? 'mode.' : 'mode.friendly.') + o.value); });
    composer.dataset.agent = p ? p.agent : '';
    composer.classList.toggle('is-running', running);
    modeSelect.value = p ? p.mode : 'default';
    modeSelect.disabled = !p || running;
    modeSelect.setAttribute('aria-label', t('mode.label'));
    send.replaceChildren(icon(running ? 'stop' : 'send'));
    send.classList.toggle('composer__send--stop', running);
    const label = running ? t('composer.stop') : t('composer.send');
    send.setAttribute('aria-label', label);
    send.title = label;
    send.disabled = !running && !!block;
    hint.classList.toggle('is-warn', !!block && !!p);
    hintText.textContent = block ? t(block.key, block.vars) : t('composer.hint');
    hintBtn.hidden = !(block && block.signIn);
    hintBtn.textContent = t('banner.signIn');
  }

  const isRunning = (st) => !!(st.chats[st.activeProjectId] && st.chats[st.activeProjectId].running);
  store.subscribe((s, prev) => {
    if (s.projects !== prev.projects || s.activeProjectId !== prev.activeProjectId || s.health !== prev.health || s.signedIn !== prev.signedIn
      || isRunning(s) !== isRunning(prev) || s.settings.developerMode !== prev.settings.developerMode) render();
  });
  render();
  return {
    update: render,
    focus: () => input.focus(),
    setText(text) {
      input.value = text; autosize(); input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      closeSlash();
    },
  };
}
