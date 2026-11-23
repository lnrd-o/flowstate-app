// In-app sign-in dialog: Claude (CLI over pipes: URL + paste code) and AGY (interactive TUI in an xterm.js terminal backed by a PTY).
// State logic lives in lib/login-state.js (pure, tested); the main process implements login:* (see src/shared/ipc.js, Phase 4).
import { h, icon, radioKeys } from '../lib/dom.js';
import { t, onChange } from '../lib/i18n.js';
import { copyText } from '../lib/clipboard.js';
import { openDialog, toast } from './modal.js';
import {
  createLoginView, startLogin, startResult, cancelLogin, reduceLoginEvent, appendBuffer, statusChip, errorKey,
} from '../lib/login-state.js';

const KINDS = ['claudeai', 'console', 'sso'];
const AUTO_CLOSE_MS = 1500;
let current = null; // one dialog at a time

/** Read the terminal palette from the CSS tokens so xterm matches dark / light / gold. */
export function terminalTheme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
  return {
    background: v('--code-bg', '#121215'),
    foreground: v('--text', '#ececf1'),
    cursor: v('--accent-text', '#ffffff'),
    cursorAccent: v('--code-bg', '#121215'),
    selectionBackground: v('--selection', 'rgba(255,255,255,0.25)'),
    black: v('--bg-elev', '#26262c'),
    red: v('--red', '#ef5350'),
    green: v('--green', '#3ecf6e'),
    yellow: v('--amber', '#f5a524'),
    blue: v('--blue', '#4da3ff'),
    magenta: v('--text-2', '#a3a3a3'),
    cyan: v('--blue-text', '#78b9ff'),
    white: v('--text-2', '#9a9aa6'),
    brightBlack: v('--text-3', '#868693'),
    brightRed: v('--red-text', '#f47f7c'),
    brightGreen: v('--green-text', '#5fe08d'),
    brightYellow: v('--amber-text', '#f7b94f'),
    brightBlue: v('--blue-text', '#78b9ff'),
    brightMagenta: v('--text', '#ffffff'),
    brightCyan: v('--blue-text', '#78b9ff'),
    brightWhite: v('--text', '#ececf1'),
  };
}

export function openLoginDialog({ store, api, actions, agent = 'claude' }) {
  if (current) { current.setTab(agent); return current; }

  const PTY_AGENTS = ['agy', 'opencode']; // sign in through their own interactive terminal (PTY + xterm.js)
  const isPty = (a) => PTY_AGENTS.includes(a);
  const normTab = (a) => (a === 'agy' || a === 'opencode' ? a : 'claude');
  let tab = normTab(agent);
  let termOwner = isPty(tab) ? tab : 'agy'; // which PTY agent the (single) terminal belongs to
  const views = { claude: createLoginView(), agy: createLoginView(), opencode: createLoginView() };
  const opts = { kind: 'claudeai', email: '' };
  let codeBusy = false;
  let buf = '';
  let term = null; // { term, fit, ro, host }
  let mountPromise = null;
  let closeTimer = null;
  let closed = false;
  const subs = [];

  const body = h('div', { class: 'login' });
  const tabsEl = h('div', { class: 'pill-tabs login__tabs', attrs: { role: 'tablist' } });
  const panel = h('div', { class: 'login__panel', attrs: { role: 'tabpanel' } });
  const claudeBox = h('div', { class: 'login__pane' });
  const agyBox = h('div', { class: 'login__pane' });
  const termHost = h('div', { class: 'login-term', attrs: { 'aria-label': t('login.terminalLabel') } });
  panel.append(claudeBox, agyBox);
  body.append(tabsEl, panel);
  const footLeft = h('div', { class: 'login__foot-left' });
  const closeBtn = h('button', { class: 'btn', type: 'button' });
  const footer = h('div', { class: 'login__foot' }, footLeft, closeBtn);

  const dlg = openDialog({
    title: t('login.title'), body, footer: [footer], size: 'lg',
    onClose: () => teardown(),
  });
  dlg.el.classList.add('modal--login');
  closeBtn.addEventListener('click', () => { cancelAll(); dlg.close('close'); });

  const signedIn = (a) => store.get().signedIn[a];
  const isActive = (a) => views[a].phase === 'starting' || views[a].phase === 'waiting';

  // ---------- helpers ----------
  const errText = (e) => { const k = errorKey(e); return k ? t(k) : (e && !/^[a-z-]+$/.test(e) ? e : t('login.err.generic')); };

  function chip(a) {
    const c = statusChip(signedIn(a));
    return h('span', { class: 'badge badge--' + c.tone }, h('span', { class: 'badge__dot' }), t(c.key));
  }

  async function refreshStatus() {
    try { actions.applyLoginStatus(await api.login.status()); } catch { /* keep previous */ }
  }

  function cancelAll() {
    for (const a of ['claude', 'agy', 'opencode']) {
      if (isActive(a)) { try { Promise.resolve(api.login.cancel(a)).catch(() => {}); } catch { /* ignore */ } views[a] = cancelLogin(views[a]); }
    }
  }

  function disposeTerm() {
    if (!term) return;
    try { term.ro.disconnect(); } catch { /* ignore */ }
    try { term.term.dispose(); } catch { /* ignore */ }
    term = null;
    termHost.replaceChildren();
  }

  function teardown() {
    closed = true;
    current = null;
    clearTimeout(closeTimer);
    cancelAll();
    disposeTerm();
    subs.forEach((u) => { try { u(); } catch { /* ignore */ } });
  }

  const openUrl = (url) => window.open(url, '_blank', 'noopener');
  async function copyUrl(url) { toast((await copyText(url)) ? t('login.linkCopied') : t('errors.generic'), 'success'); }

  function urlBar(url, extraClass) {
    return h('div', { class: 'login-url ' + (extraClass || '') },
      h('input', { class: 'input mono login-url__field', type: 'text', readOnly: true, value: url, attrs: { 'aria-label': t('login.step1'), spellcheck: 'false' } }),
      h('div', { class: 'row wrap gap-2' },
        h('button', { class: 'btn btn--sm btn--primary', type: 'button', on: { click: () => openUrl(url) } }, icon('external'), t('login.openBrowser')),
        h('button', { class: 'btn btn--sm', type: 'button', on: { click: () => copyUrl(url) } }, icon('copy'), t('login.copyLink'))));
  }

  function successCard(a) {
    return h('div', { class: 'login-success', attrs: { role: 'status' } },
      h('span', { class: 'login-success__icon' }, icon('check')),
      h('div', { class: 'login-success__title', text: t('login.success', { agent: t('agent.' + a) }) }),
      h('div', { class: 'login-success__sub muted', text: t('login.successSub') }));
  }

  function errorBox(text) {
    return h('div', { class: 'login-error', attrs: { role: 'alert' } }, icon('alert', 'login-error__icon'),
      h('div', null, h('div', { class: 'login-error__title', text: t('login.failed') }), h('div', { class: 'login-error__text', text })));
  }

  // ---------- success ----------
  function onSuccess(a) {
    actions.recheckHealth();
    toast(t('login.success', { agent: t('agent.' + a) }), 'success');
    if (a === tab) {
      clearTimeout(closeTimer);
      closeTimer = setTimeout(() => { if (!closed) dlg.close('done'); }, AUTO_CLOSE_MS);
    }
  }

  // ---------- events ----------
  function onEvent(ev) {
    if (!ev || (ev.agent !== 'claude' && !isPty(ev.agent))) return;
    const a = ev.agent;
    if (ev.kind === 'data' && a === termOwner) {
      buf = appendBuffer(buf, ev.data);
      if (term) term.term.write(String(ev.data));
    }
    const prev = views[a];
    views[a] = reduceLoginEvent(prev, ev);
    if (ev.kind === 'error' || (ev.kind === 'done' && ev.ok === false)) codeBusy = false;
    if (ev.kind === 'status' || ev.kind === 'done') refreshStatus();
    if (prev.phase !== 'success' && views[a].phase === 'success') onSuccess(a);
    if (ev.kind === 'done' || ev.kind === 'error') { if (a === termOwner) disposeTermLater(); }
    if (ev.kind === 'data') { if (prev.phase === 'starting') render(); return; }
    render();
  }

  function disposeTermLater() {
    // keep the terminal visible after done so the user can read the final output only while not successful
    if (views[termOwner].phase === 'success' || views[termOwner].phase === 'error') disposeTerm();
  }

  // ---------- Claude ----------
  async function startClaude() {
    clearTimeout(closeTimer);
    views.claude = startLogin(views.claude);
    codeBusy = false;
    render();
    try {
      const o = { kind: opts.kind };
      if (opts.email.trim()) o.email = opts.email.trim();
      views.claude = startResult(views.claude, await api.login.start('claude', o));
    } catch (e) {
      views.claude = startResult(views.claude, { ok: false, error: (e && e.message) || '' });
    }
    render();
  }

  async function submitCode(code) {
    const c = code.trim();
    if (!c) return;
    codeBusy = true; render();
    try { await api.login.input('claude', c); } catch { codeBusy = false; }
    render();
  }

  function renderClaude() {
    const v = views.claude;
    const kids = [];
    if (v.phase === 'success') { claudeBox.replaceChildren(successCard('claude')); return; }
    if (v.phase === 'idle' || v.phase === 'error') {
      if (v.phase === 'error') kids.push(errorBox(errText(v.error)));
      kids.push(h('p', { class: 'login__intro', text: signedIn('claude') ? t('login.claudeSignedIn') : t('login.claudeIntro') }));
      const seg = h('div', { class: 'segmented', attrs: { role: 'radiogroup', 'aria-label': t('login.account') } });
      for (const k of KINDS) {
        seg.append(h('button', {
          class: 'segmented__item' + (opts.kind === k ? ' is-active' : ''), type: 'button',
          attrs: { role: 'radio', 'aria-checked': String(opts.kind === k), tabindex: opts.kind === k ? '0' : '-1' }, text: t('login.kind.' + k),
          on: { click: () => { opts.kind = k; render(); } },
        }));
      }
      radioKeys(seg);
      const email = h('input', { class: 'input', id: 'login-email', type: 'email', value: opts.email, placeholder: t('login.emailPlaceholder'), autocomplete: 'email', spellcheck: false });
      email.addEventListener('input', () => { opts.email = email.value; });
      email.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); startClaude(); } });
      kids.push(
        h('div', { class: 'field' }, h('div', { class: 'field__label', text: t('login.account') }), seg),
        h('div', { class: 'field' },
          h('label', { class: 'field__label', for: 'login-email', text: opts.kind === 'sso' ? t('login.emailSso') : t('login.email') }), email),
        h('div', { class: 'row wrap gap-3' },
          h('button', { class: 'btn btn--primary', type: 'button', text: v.phase === 'error' ? t('login.tryAgain') : t('login.signIn'), on: { click: startClaude } }),
          h('button', { class: 'btn btn--ghost btn--sm login__external', type: 'button', text: t('login.external'), on: { click: () => { actions.signInExternal('claude'); } } })));
    } else {
      // starting / waiting
      const waitingUrl = !v.url;
      kids.push(h('ol', { class: 'login-steps' },
        h('li', { class: 'login-step' + (v.url ? ' is-done' : ' is-active') },
          h('div', { class: 'login-step__title' }, h('span', { class: 'login-step__num', text: '1' }), t('login.step1')),
          waitingUrl ? h('div', { class: 'row muted' }, h('span', { class: 'spinner' }), t('login.waitingUrl')) : urlBar(v.url)),
        h('li', { class: 'login-step' + (v.url ? ' is-active' : ''), hidden: !v.url && !v.prompt },
          h('div', { class: 'login-step__title' }, h('span', { class: 'login-step__num', text: '2' }), t('login.step2')),
          codeRow())));
      kids.push(h('div', { class: 'faint small', text: t('login.waitBrowser') }));
    }
    claudeBox.replaceChildren(...kids);
  }

  function codeRow() {
    const input = h('input', { class: 'input mono', id: 'login-code', type: 'text', placeholder: t('login.codePlaceholder'), autocomplete: 'off', spellcheck: false, disabled: codeBusy, attrs: { 'aria-label': t('login.step2') } });
    const send = h('button', { class: 'btn btn--primary', type: 'button', disabled: codeBusy, text: t('login.submit') });
    send.addEventListener('click', () => submitCode(input.value));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitCode(input.value); } });
    return h('div', null,
      h('div', { class: 'row' }, input, send),
      codeBusy ? h('div', { class: 'row muted small login__busy' }, h('span', { class: 'spinner' }), t('login.checking')) : null);
  }

  // ---------- AGY ----------
  function mountTerm() {
    if (term) return Promise.resolve();
    if (!mountPromise) mountPromise = doMount().finally(() => { mountPromise = null; });
    return mountPromise;
  }

  async function doMount() {
    const [{ Terminal }, { FitAddon }] = await Promise.all([import('../vendor/xterm.js'), import('../vendor/xterm-addon-fit.js')]);
    if (closed) return;
    const cs = getComputedStyle(document.documentElement);
    const tm = new Terminal({
      cursorBlink: true, fontSize: 13, convertEol: false, scrollback: 2000,
      fontFamily: cs.getPropertyValue('--font-mono').trim() || 'Consolas, monospace', theme: terminalTheme(),
    });
    const fit = new FitAddon();
    tm.loadAddon(fit);
    tm.open(termHost);
    const doFit = () => {
      try {
        fit.fit();
        if (isActive(termOwner)) api.login.resize(termOwner, tm.cols, tm.rows);
      } catch { /* host not laid out yet */ }
    };
    const ro = new ResizeObserver(() => doFit());
    ro.observe(termHost);
    tm.onData((d) => { if (isActive(termOwner)) api.login.input(termOwner, d); });
    term = { term: tm, fit, ro };
    doFit();
    if (buf) tm.write(buf);
    tm.focus();
  }

  async function startPty(a) {
    clearTimeout(closeTimer);
    // only one terminal at a time: stop the other PTY agent's sign-in first
    for (const o of PTY_AGENTS) if (o !== a && isActive(o)) { try { Promise.resolve(api.login.cancel(o)).catch(() => {}); } catch { /* ignore */ } views[o] = cancelLogin(views[o]); }
    termOwner = a;
    buf = '';
    views[a] = startLogin(views[a]);
    disposeTerm();
    render();
    try { await mountTerm(); } catch { views[a] = startResult(views[a], { ok: false, error: 'terminal-unavailable' }); render(); return; }
    if (closed || !term) return;
    let res;
    try { res = await api.login.start(a, { cols: term.term.cols, rows: term.term.rows }); } catch (e) { res = { ok: false, error: (e && e.message) || '' }; }
    views[a] = startResult(views[a], res);
    if (views[a].phase === 'error') disposeTerm();
    render();
    if (term) term.term.focus();
  }

  function renderPty(a) {
    const v = views[a];
    const kids = [];
    const K = a === 'opencode' ? 'opencode' : 'agy'; // i18n key prefix: login.agyIntro / login.opencodeIntro ...
    if (v.phase === 'success') { agyBox.replaceChildren(successCard(a)); return; }
    if (v.phase === 'idle' || v.phase === 'error') {
      if (v.phase === 'error') kids.push(errorBox(errText(v.error)));
      kids.push(h('p', { class: 'login__intro', text: signedIn(a) ? t('login.' + K + 'SignedIn') : t('login.' + K + 'Intro') }));
      if (signedIn(a)) {
        kids.push(h('div', { class: 'login-note' }, icon('info', 'login-note__icon'), h('span', { text: t('login.' + K + 'LogoutNote') })));
        kids.push(h('div', null, h('button', { class: 'btn', type: 'button', text: a === 'opencode' ? t('login.opencodeAddProvider') : t('login.openTerminalLogout'), on: { click: () => startPty(a) } })));
      } else {
        kids.push(h('div', null, h('button', { class: 'btn btn--primary', type: 'button', text: v.phase === 'error' ? t('login.tryAgain') : t('login.openTerminal'), on: { click: () => startPty(a) } })));
      }
    } else {
      if (v.url) kids.push(urlBar(v.url, 'login-url--bar'));
      kids.push(termHost);
      kids.push(h('div', { class: 'faint small', text: t('login.terminalHint') }));
      if (!term && a === termOwner) mountTerm().catch(() => { views[a] = startResult(views[a], { ok: false, error: 'terminal-unavailable' }); render(); });
    }
    const hadFocus = !!term && termHost.contains(document.activeElement);
    agyBox.replaceChildren(...kids);
    if (term && hadFocus) term.term.focus(); // moving the host in the DOM drops focus
    if (term && v.phase === 'waiting') { try { term.fit.fit(); } catch { /* ignore */ } }
  }

  // ---------- chrome ----------
  /** OpenCode only when it is installed (or this dialog was opened for it). */
  function visibleTabs() {
    const hl = store.get().health;
    const oc = (hl && hl.opencode && hl.opencode.found) || agent === 'opencode' || tab === 'opencode';
    return ['claude', 'agy', ...(oc ? ['opencode'] : [])];
  }

  function renderTabs() {
    tabsEl.replaceChildren(...visibleTabs().map((a) => {
      const b = h('button', {
        class: 'pill-tab login__tab' + (tab === a ? ' is-active' : ''), type: 'button', id: 'login-tab-' + a,
        attrs: { role: 'tab', 'aria-selected': String(tab === a), tabindex: tab === a ? '0' : '-1' },
        on: { click: () => setTab(a) },
      }, h('span', { text: t('login.tab' + (a === 'claude' ? 'Claude' : a === 'opencode' ? 'Opencode' : 'Agy')) }), chip(a));
      return b;
    }));
  }

  function renderFooter() {
    const left = [];
    if (tab === 'claude' && signedIn('claude') === true && !isActive('claude') && views.claude.phase !== 'success') {
      left.push(h('button', { class: 'btn btn--danger btn--sm', type: 'button', text: t('login.signOut'), on: { click: signOut } }));
    }
    footLeft.replaceChildren(...left);
    const active = isActive(tab);
    closeBtn.textContent = active ? t('login.cancelSignIn') : t('common.close');
  }

  async function signOut() {
    if (await actions.signOut('claude') && !closed) render();
  }

  function setTab(a) {
    tab = normTab(a);
    if (tab !== termOwner && term) { /* keep the pty session, drop only the widget */ disposeTerm(); }
    clearTimeout(closeTimer);
    render();
  }

  function render() {
    if (closed) return;
    dlg.setTitle(t('login.title'));
    renderTabs();
    claudeBox.hidden = tab !== 'claude';
    agyBox.hidden = !isPty(tab);
    panel.setAttribute('aria-labelledby', 'login-tab-' + tab);
    // Only repaint the visible pane (the other one may host the live terminal).
    if (tab === 'claude') renderClaude(); else renderPty(tab);
    renderFooter();
    if (isPty(tab) && term === null && !isActive(tab)) termHost.replaceChildren();
  }

  const api4 = { setTab: (a) => { setTab(a); }, el: dlg.el, close: dlg.close };
  current = api4;
  if (api.onLogin) subs.push(api.onLogin(onEvent));
  subs.push(store.subscribe((s, prev) => { if (s.signedIn !== prev.signedIn) render(); }));
  subs.push(onChange(() => render()));
  tabsEl.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const list = visibleTabs();
    const i = list.indexOf(tab);
    const n = list[(i + (e.key === 'ArrowRight' ? 1 : list.length - 1)) % list.length];
    setTab(n);
    const el = tabsEl.querySelector('#login-tab-' + n);
    if (el) el.focus();
  });
  render();
  refreshStatus();
  return api4;
}
