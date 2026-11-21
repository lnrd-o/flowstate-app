// Composer: autosize textarea, agent switch, mode select, send/stop, disabled hints.
import { h, icon, radioKeys } from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import { activeProject } from '../lib/store.js';

const MODES = ['default', 'acceptEdits', 'plan'];
const AGENTS = ['claude', 'agy'];

/** Why sending is blocked, as an i18n key + vars (or null). Pure; exported for tests of the logic. */
export function sendBlockReason(project, health) {
  if (!project) return { key: 'composer.disabledNoProject' };
  if (!health) return null;
  if (health.vpn && health.vpn.active) return { key: 'composer.disabledVpn' };
  const a = health[project.agent];
  if (a && !a.found) return { key: 'composer.disabledMissing', vars: { agent: t('agent.' + project.agent) } };
  if (project.agent === 'claude' && a && a.loggedIn === false) return { key: 'composer.disabledLogin' };
  return null;
}

export function mountComposer(root, { store, api, actions }) {
  const drafts = new Map();
  let shownProject = null;

  const input = h('textarea', { class: 'composer__input', rows: 1, id: 'composer-input' });
  const segmented = h('div', { class: 'segmented', attrs: { role: 'radiogroup' } });
  const segButtons = AGENTS.map((a) => {
    const b = h('button', { class: 'segmented__item', type: 'button', attrs: { role: 'radio', 'aria-checked': 'false' }, text: t('agent.' + a) });
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
  root.append(h('div', { class: 'composer-wrap__inner' }, composer, hint));

  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 240) + 'px';
  }

  function submit() {
    const s = store.get();
    const p = activeProject(s);
    const chat = p && s.chats[p.id];
    const text = input.value.trim();
    if (!p || !text || (chat && chat.running) || sendBlockReason(p, s.health)) return;
    input.value = '';
    drafts.delete(p.id);
    autosize();
    actions.send(text);
  }

  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
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
    const block = sendBlockReason(p, s.health);
    input.placeholder = t('composer.placeholder', { agent: p ? t('agent.' + p.agent) : t('app.name') });
    input.setAttribute('aria-label', input.placeholder);
    input.disabled = !p;
    AGENTS.forEach((a, i) => {
      const on = !!p && p.agent === a;
      segButtons[i].textContent = t('agent.' + a);
      segButtons[i].classList.toggle('is-active', on);
      segButtons[i].setAttribute('aria-checked', String(on));
      segButtons[i].tabIndex = on || (!p && i === 0) ? 0 : -1;
      segButtons[i].disabled = !p || running;
    });
    segmented.setAttribute('aria-label', t('agent.switch'));
    [...modeSelect.options].forEach((o) => { o.textContent = t('mode.' + o.value); });
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
    hint.textContent = block ? t(block.key, block.vars) : t('composer.hint');
  }

  const isRunning = (st) => !!(st.chats[st.activeProjectId] && st.chats[st.activeProjectId].running);
  store.subscribe((s, prev) => {
    if (s.projects !== prev.projects || s.activeProjectId !== prev.activeProjectId || s.health !== prev.health
      || isRunning(s) !== isRunning(prev)) render();
  });
  render();
  return { update: render, focus: () => input.focus() };
}
