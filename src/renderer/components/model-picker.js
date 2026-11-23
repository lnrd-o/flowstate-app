// Composer toolbar: model dropdown (menu button + panel) and effort select.
// Developer mode: model names with their ids and all five effort levels. Simple mode: friendly names only, "Speed vs quality" Fast / Balanced / Thorough.
import { h, icon, nextId } from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import { activeProject, isDev } from '../lib/store.js';
import { filterModelsBySource } from '../../shared/sources.js';
import { currentModelLabel, displayEffort, effortValues, groupModelOptions, modelOptions, modelToStore, modelsNeedSignIn } from '../lib/models.js';

export function mountModelPicker({ store, actions }) {
  const panelId = nextId('mp-panel');
  const label = h('span', { class: 'mp__label truncate' });
  const btn = h('button', { class: 'btn btn--sm mp__btn', type: 'button', attrs: { 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': panelId } },
    icon('sparkles'), label, icon('chevron', 'mp__chev'));
  const panel = h('div', { class: 'menu mp__panel', id: panelId, hidden: true, attrs: { role: 'menu' } });
  const effort = h('select', { class: 'select select--sm mp__effort', id: 'composer-effort', style: 'width:auto' });
  const el = h('div', { class: 'mp' }, btn, panel);
  let open = false;
  let items = [];

  function setOpen(v, restore = true) {
    if (open === v) return;
    open = v;
    panel.hidden = !v;
    btn.setAttribute('aria-expanded', String(v));
    if (v) {
      const s = store.get();
      const p = activeProject(s);
      if (p) actions.loadModels(p.agent, { force: !!(s.models[p.agent] && s.models[p.agent].error) });
      paintPanel();
      const first = items.find((b) => b.getAttribute('aria-checked') === 'true') || items[0] || panel.querySelector('button:not([disabled])');
      if (first) first.focus();
      document.addEventListener('pointerdown', onDoc, true);
    } else {
      document.removeEventListener('pointerdown', onDoc, true);
      if (restore) btn.focus();
    }
  }
  const onDoc = (e) => { if (!el.contains(e.target)) setOpen(false, false); };

  btn.addEventListener('click', () => setOpen(!open));
  btn.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setOpen(true); } });
  panel.addEventListener('keydown', (e) => {
    const all = [...panel.querySelectorAll('button:not([disabled])')];
    const i = all.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); }
    else if (e.key === 'Tab') setOpen(false, false);
    else if (e.key === 'ArrowDown') { e.preventDefault(); all[(i + 1) % all.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); all[(i - 1 + all.length) % all.length].focus(); }
    else if (e.key === 'Home') { e.preventDefault(); all[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); all[all.length - 1].focus(); }
  });

  effort.addEventListener('change', () => {
    const p = activeProject(store.get());
    if (p) actions.updateProject(p.id, { effort: effort.value });
  });

  function paintPanel() {
    const s = store.get();
    const p = activeProject(s);
    if (!p) return;
    const dev = isDev(s);
    const list = s.models[p.agent];
    const loading = !!s.modelsLoading[p.agent];
    items = [];
    const hadFocus = panel.contains(document.activeElement);
    const refresh = h('button', {
      class: 'btn btn--ghost btn--icon btn--sm', type: 'button', disabled: loading,
      attrs: { role: 'menuitem', 'aria-label': t('model.refresh'), title: t('model.refresh') }, on: { click: () => actions.loadModels(p.agent, { force: true }) },
    }, icon('refresh'));
    const head = h('div', { class: 'mp__head' }, h('span', { class: 'mp__title', text: t('model.pick') }),
      list && !loading ? h('span', { class: 'faint xs', text: list.source === 'live' ? t('model.live') : t('model.builtin') }) : null, h('span', { class: 'grow' }), refresh);
    const body = [];
    if (loading && !(list && list.models && list.models.length)) {
      body.push(h('div', { class: 'mp__state muted', attrs: { role: 'status' } }, h('span', { class: 'spinner' }), t('model.loading')));
    } else if (list && list.error) {
      const need = modelsNeedSignIn(list);
      body.push(h('div', { class: 'mp__state mp__state--error', attrs: { role: 'status' } },
        h('span', { text: need ? t('model.notSignedIn', { agent: t('agent.' + p.agent) }) : t('model.error', { error: list.error }) }),
        need ? h('button', { class: 'btn btn--sm btn--primary', type: 'button', text: t('model.signIn'), on: { click: () => { setOpen(false); actions.openLogin(p.agent); } } }) : null));
    }
    if (loading && list && list.models && list.models.length) body.push(h('div', { class: 'mp__state muted', attrs: { role: 'status' } }, h('span', { class: 'spinner' }), t('model.loading')));
    const opts = filterModelsBySource(modelOptions(list, p, dev), s.settings);
    if (!opts.length && !loading && !(list && list.error)) body.push(h('div', { class: 'mp__state muted', text: t('model.none') }));
    const groups = groupModelOptions(opts);
    const showHeads = groups.length > 1 || (groups[0] && groups[0].kind === 'opencode');
    // Estimated usage per model: FlowState's own records of finished turns on this PC (tokens, turns, cost when reported).
    const weekUse = (s.usage && s.usage.models && s.usage.models.week) || {};
    const todayUse = (s.usage && s.usage.models && s.usage.models.today) || {};
    const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n));
    const useLine = (o) => {
      const key = p.agent + '|' + (modelToStore(o.id, list) || 'default');
      const w = weekUse[key];
      if (!w || !w.turns) return null;
      const d = todayUse[key];
      const tok = (w.inputTokens || 0) + (w.outputTokens || 0);
      const parts = [t('model.use.week', { tokens: fmt(tok), turns: w.turns })];
      if (d && d.turns) parts.push(t('model.use.today', { tokens: fmt((d.inputTokens || 0) + (d.outputTokens || 0)) }));
      if (w.costUsd) parts.push('USD ' + w.costUsd.toFixed(2));
      return h('span', { class: 'mp__item-use xs faint truncate', text: parts.join(' - ') });
    };
    const creds = (list && Array.isArray(list.credentials)) ? list.credentials : null;
    const PLAN = (id) => (creds ? (creds.includes(id) ? t('model.plan.yours') : t('model.plan.none')) : '');
    const PROVIDERS = { opencode: 'OpenCode Zen - ' + t('model.plan.payg'), 'opencode-go': 'OpenCode Go' + (creds ? ' - ' + PLAN('opencode-go') : ''), anthropic: 'Anthropic', google: 'Google', openai: 'OpenAI', deepseek: 'DeepSeek', openrouter: 'OpenRouter' };
    for (const g of groups) {
      if (showHeads && g.group) body.push(h('div', { class: 'mp__group', attrs: { role: 'presentation' }, text: g.provider ? (PROVIDERS[g.provider] || g.provider) : t('model.group.' + g.kind) }));
      for (const o of g.options) {
      const b = h('button', {
        class: 'menu__item mp__item' + (o.current ? ' is-current' : ''), type: 'button', disabled: o.disabled, attrs: { role: 'menuitemradio', 'aria-checked': String(o.current), tabindex: '-1' },
        on: { click: () => { if (o.disabled) return; setOpen(false); actions.updateProject(p.id, { model: modelToStore(o.id, list) }); } },
      },
      h('span', { class: 'menu__check', attrs: { 'aria-hidden': 'true' }, text: o.current ? '\u2713' : '' }),
      h('span', { class: 'mp__item-main' },
        h('span', { class: 'mp__item-name truncate', text: o.label }),
        o.sub && o.sub !== o.label ? h('span', { class: 'mp__item-id mono truncate', text: o.sub }) : null,
        o.needsKey ? h('span', { class: 'mp__item-need truncate', text: t('model.addKey') }) : null,
        o.description ? h('span', { class: 'mp__item-desc truncate', text: o.description }) : null,
        useLine(o)),
      o.isDefault ? h('span', { class: 'badge badge--muted mp__badge', text: t('model.recommended') }) : null);
      items.push(b);
      body.push(b);
      }
    }
    panel.setAttribute('aria-label', t('model.label'));
    if (Object.keys(weekUse).length) body.push(h('div', { class: 'mp__use-note xs faint', text: t('model.use.note') }));
    panel.replaceChildren(head, ...body);
    if (hadFocus) {
      const f = items.find((b) => b.getAttribute('aria-checked') === 'true') || panel.querySelector('button:not([disabled])');
      if (f) f.focus();
    }
  }

  function render() {
    const s = store.get();
    const p = activeProject(s);
    const dev = isDev(s);
    const running = !!(p && s.chats[p.id] && s.chats[p.id].running);
    el.hidden = !p;
    effort.hidden = !p;
    if (!p) return;
    if (p.agent === 'opencode' || /^deepseek/i.test(p.model || '')) effort.hidden = true; // effort levels are Anthropic/AGY concepts
    const list = s.models[p.agent];
    const name = currentModelLabel(list, p, dev, t('model.defaultName'));
    label.textContent = name;
    btn.setAttribute('aria-label', t('model.button', { name }));
    btn.title = t('model.button', { name });
    btn.disabled = running;
    if (running && open) setOpen(false, false);
    const vals = effortValues(dev);
    const want = vals.join();
    if (effort.dataset.vals !== want + '|' + dev) {
      effort.dataset.vals = want + '|' + dev;
      effort.replaceChildren(...vals.map((v) => h('option', { value: v, text: dev ? t('model.effortName.' + v) : t('model.speedName.' + v) })));
    } else {
      [...effort.options].forEach((o) => { o.textContent = dev ? t('model.effortName.' + o.value) : t('model.speedName.' + o.value); });
    }
    effort.value = displayEffort(p.effort, dev);
    effort.disabled = running;
    const eff = dev ? t('model.effort') : t('model.speed');
    effort.setAttribute('aria-label', eff);
    effort.title = eff;
    if (open) paintPanel();
  }

  return { el, effort, render, close: () => setOpen(false, false) };
}
