// Terminal tab (side panel): the project's own console, an interactive shell started in the project folder (xterm.js + a PTY in main).
import { h, icon } from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import { activeProject } from '../lib/store.js';
import { terminalTheme } from './login-dialog.js';

export function mountTerminalTab(panel, { store, api }) {
  const sessions = new Map(); // projectId -> { term, fit, host, alive, starting }
  const bar = h('div', { class: 'term-tab__bar small muted' });
  const stack = h('div', { class: 'term-tab__stack' });
  panel.classList.add('term-tab');
  panel.append(bar, stack);
  let libs = null;
  const loadLibs = async () => (libs ??= Promise.all([import('../vendor/xterm.js'), import('../vendor/xterm-addon-fit.js')]));

  async function ensure(p) {
    let s = sessions.get(p.id);
    if (s) return s;
    s = { term: null, fit: null, host: h('div', { class: 'term-tab__host', hidden: true }), alive: false, starting: false, error: '' };
    sessions.set(p.id, s);
    stack.append(s.host);
    const [{ Terminal }, { FitAddon }] = await loadLibs();
    const cs = getComputedStyle(document.documentElement);
    s.term = new Terminal({ cursorBlink: true, fontSize: 13, scrollback: 5000, fontFamily: cs.getPropertyValue('--font-mono').trim() || 'Consolas, monospace', theme: terminalTheme() });
    s.fit = new FitAddon();
    s.term.loadAddon(s.fit);
    s.term.open(s.host);
    s.term.onData((d) => { if (s.alive) api.term.input(p.id, d); });
    return s;
  }

  async function start(p, s) {
    if (s.starting) return;
    s.starting = true;
    s.host.hidden = false;
    try { s.fit.fit(); } catch { /* not laid out yet */ }
    let r;
    try { r = await api.term.start(p.id, { cols: s.term.cols, rows: s.term.rows }); } catch (e) { r = { ok: false, error: (e && e.message) || 'start-failed' }; }
    s.starting = false;
    if (!r || !r.ok) { s.error = (r && (r.message || r.error)) || 'start-failed'; s.alive = false; paintBar(); return; }
    s.error = '';
    s.term.reset();
    if (r.buffer) s.term.write(r.buffer);
    s.alive = true;
    s.term.focus();
    paintBar();
  }

  function paintBar() {
    const p = activeProject(store.get());
    const s = p && sessions.get(p.id);
    if (!p) { bar.replaceChildren(h('span', { text: t('files.noProject') })); return; }
    const restart = h('button', { class: 'btn btn--ghost btn--sm', type: 'button', title: t('term.restart'), on: { click: async () => { await api.term.stop(p.id); if (s) { s.alive = false; await start(p, s); } } } }, icon('refresh'), t('term.restart'));
    bar.replaceChildren(
      icon('terminal', 'term-tab__ic'),
      h('span', { class: 'truncate mono', text: p.path, title: p.path }),
      s && s.error ? h('span', { class: 'field__error', text: t('term.unavailable') }) : null,
      s && !s.alive && !s.starting && !s.error ? h('span', { class: 'faint', text: t('term.exited') }) : null,
      restart);
  }

  async function render() {
    const s0 = store.get();
    const p = activeProject(s0);
    paintBar();
    for (const [id, s] of sessions) s.host.hidden = !p || id !== p.id;
    if (!p) return;
    const s = await ensure(p);
    s.host.hidden = false;
    try { s.fit.fit(); } catch { /* ignore */ }
    if (!s.alive && !s.starting && !s.error) await start(p, s);
    else if (s.alive) { try { api.term.resize(p.id, s.term.cols, s.term.rows); } catch { /* ignore */ } s.term.focus(); }
  }

  if (api.onTerm) {
    api.onTerm((ev) => {
      const s = ev && sessions.get(ev.projectId);
      if (!s || !s.term) return;
      if (ev.kind === 'data') s.term.write(String(ev.data));
      else if (ev.kind === 'exit') { s.alive = false; s.term.write('\r\n\x1b[90m[' + t('term.exited') + ']\x1b[0m\r\n'); paintBar(); }
    });
  }
  const ro = new ResizeObserver(() => {
    const p = activeProject(store.get());
    const s = p && sessions.get(p.id);
    if (!s || !s.term || s.host.hidden || !panel.offsetParent) return;
    try { s.fit.fit(); if (s.alive) api.term.resize(p.id, s.term.cols, s.term.rows); } catch { /* ignore */ }
  });
  ro.observe(panel);
  return { render };
}
