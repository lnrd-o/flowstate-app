// Rich tool card: icon + human title + status + duration in the header; body per tool kind
// (terminal block for commands, real diff for edits and writes, preview for read/search/list) and a raw JSON view.
import { h, icon } from '../lib/dom.js';
import { t, getLanguage } from '../lib/i18n.js';
import { copyText } from '../lib/clipboard.js';
import {
  kindOf, toolTitle, changeOf, displayPath, commandOf, stripAnsi, formatDuration,
} from '../lib/activity.js';
import { createDiffView } from './diff-view.js';

const KIND_ICONS = { command: 'terminal', edit: 'edit', write: 'edit', read: 'file', search: 'search', list: 'folder', other: 'tool' };
const TERM_TAIL_LINES = 200;
const PREVIEW_LINES = 8;
const AUTO_OPEN_DIFF_LINES = 40;
let uid = 0;

function copyButton(labelKey, getText) {
  const btn = h('button', { class: 'btn btn--ghost btn--sm tc-copy', type: 'button' }, icon('copy'), h('span', { text: t(labelKey) }));
  btn.addEventListener('click', async () => {
    const ok = await copyText(getText());
    const span = btn.lastChild;
    span.textContent = ok ? t('chat.copied') : t('errors.generic');
    btn.classList.toggle('is-copied', ok);
    setTimeout(() => { span.textContent = t(labelKey); btn.classList.remove('is-copied'); }, 1500);
  });
  return btn;
}

function delta(ch) {
  if (!ch) return null;
  return h('span', { class: 'tc-delta' },
    ch.added ? h('span', { class: 'tc-add', text: '+' + ch.added }) : null,
    ch.removed ? h('span', { class: 'tc-del', text: '-' + ch.removed }) : null);
}

function countNewlines(s) {
  let n = 1;
  for (let i = s.indexOf('\n'); i >= 0; i = s.indexOf('\n', i + 1)) n++;
  return n;
}

function rawJson(m, ch) {
  const out = {
    id: m.toolId, name: m.name, kind: kindOf(m), status: m.status, durationMs: m.durationMs, exitCode: m.exitCode,
    input: m.input, output: m.output,
  };
  if (m.commandOutput != null && m.commandOutput !== m.output) out.commandOutput = m.commandOutput;
  if (ch) out.change = { ...ch, diff: ch.diff && ch.diff.length > 3000 ? ch.diff.slice(0, 3000) + '\n...' : ch.diff };
  let s = '';
  try { s = JSON.stringify(out, null, 2); } catch { s = String(out); }
  return s.length > 20000 ? s.slice(0, 20000) + '\n...' : s;
}

export function buildToolCard() {
  const bodyId = 'tc-body-' + (++uid);
  const ic = h('span', { class: 'tool-card__icon-wrap' });
  const title = h('span', { class: 'tool-card__title truncate' });
  const summary = h('span', { class: 'tool-card__summary' });
  const deltaHost = h('span', { class: 'tool-card__delta-host' });
  const dur = h('span', { class: 'tool-card__dur faint small' });
  const spinner = h('span', { class: 'spinner' });
  const badge = h('span', { class: 'badge' });
  const chevron = icon('chevron', 'tool-card__chevron');
  const header = h('button', { class: 'tool-card__header', type: 'button', attrs: { 'aria-expanded': 'false', 'aria-controls': bodyId } },
    ic, title, summary, deltaHost, h('span', { class: 'tool-card__spacer' }), dur, spinner, badge, chevron);
  const rawBtn = h('button', { class: 'btn btn--ghost btn--sm tool-card__raw', type: 'button', attrs: { 'aria-pressed': 'false' } });
  const bar = h('div', { class: 'tool-card__bar' }, header, rawBtn);
  const body = h('div', { class: 'tc-body', id: bodyId, hidden: true });
  const card = h('div', { class: 'tool-card' }, bar, body);

  let userOpen = null;
  let rawOpen = false;
  let showAll = false;
  let lastMsg = null;
  let lastCtx = null;
  let sig = '';
  let autoOpen = false;
  let iconName = '';

  const isOpen = () => (userOpen == null ? autoOpen : userOpen) || rawOpen;

  function applyOpen() {
    const open = isOpen();
    card.classList.toggle('is-open', open);
    header.setAttribute('aria-expanded', String(open));
    body.hidden = !open;
  }

  header.addEventListener('click', () => {
    const next = !(userOpen == null ? autoOpen : userOpen);
    userOpen = next;
    if (!next) rawOpen = false;
    sig = '';
    if (lastMsg) update(lastMsg, lastCtx);
  });
  rawBtn.addEventListener('click', () => {
    rawOpen = !rawOpen;
    if (rawOpen && userOpen === false) userOpen = true;
    sig = '';
    if (lastMsg) update(lastMsg, lastCtx);
  });

  function commandBody(m) {
    const cmd = commandOf(m);
    const out = stripAnsi(m.commandOutput != null ? m.commandOutput : m.output).replace(/\n+$/, '');
    const lines = out ? out.split('\n') : [];
    const long = lines.length > TERM_TAIL_LINES;
    const shown = long && !showAll ? lines.slice(-TERM_TAIL_LINES) : lines;
    const tools = h('div', { class: 'tc-term__tools' });
    if (typeof m.exitCode === 'number') {
      tools.append(h('span', { class: 'badge ' + (m.exitCode === 0 ? 'badge--green' : 'badge--red'), text: t('act.exitCode', { code: m.exitCode }) }));
    }
    if (long) {
      tools.append(h('button', { class: 'btn btn--ghost btn--sm', type: 'button', text: showAll ? t('act.showLess') : t('act.showAll'), on: { click: () => { showAll = !showAll; sig = ''; update(lastMsg, lastCtx); } } }));
    }
    tools.append(copyButton('act.copyOutput', () => (cmd ? '$ ' + cmd + '\n' : '') + out));
    const pre = h('pre', { class: 'tc-term__pre' + (showAll ? ' is-all' : ''), attrs: { tabindex: '0', role: 'region', 'aria-label': t('act.outputLabel') } });
    if (cmd) pre.append(h('span', { class: 'tc-term__cmd', text: '$ ' + cmd }), '\n');
    if (long && !showAll) pre.append(h('span', { class: 'tc-term__note', text: t('act.hiddenLines', { count: lines.length - TERM_TAIL_LINES }) }), '\n');
    if (shown.length) pre.append(h('span', { class: 'tc-term__out', text: shown.join('\n') }));
    else pre.append(h('span', { class: 'tc-term__note', text: m.status === 'running' ? t('act.waitingOutput') : t('act.noOutput') }));
    return h('div', { class: 'tc-term' }, tools, pre);
  }

  function fileBody(m, ch, ctx) {
    const path = displayPath(m, ctx.root);
    const wrap = h('div', { class: 'tc-file' });
    const head = h('div', { class: 'tc-file__head' });
    if (path) {
      const canOpen = !(ch && ch.op === 'delete') && ctx.openFile;
      const pathBtn = h('button', {
        class: 'tc-file__path', type: 'button', disabled: !canOpen,
        title: t('act.openFileTitle', { file: path }),
      }, icon('file'), h('span', { class: 'truncate', text: path }));
      if (canOpen) pathBtn.addEventListener('click', () => ctx.openFile(path));
      head.append(pathBtn);
    }
    if (ch) {
      head.append(h('span', { class: 'badge badge--muted', text: ch.op === 'create' ? t('act.opCreate') : ch.op === 'delete' ? t('act.opDelete') : t('act.opModify') }), delta(ch));
    }
    head.append(h('span', { class: 'tool-card__spacer' }));
    wrap.append(head);
    if (ch && ch.diff) {
      const dv = createDiffView({ diff: ch.diff, path, hideNumbers: !!ch.derived && ch.op !== 'create' });
      head.append(copyButton('act.copyDiff', () => ch.diff));
      wrap.append(dv.el);
      if (ch.derived && ch.op !== 'create') wrap.append(h('div', { class: 'tc-note faint small', text: t('act.derivedNote') }));
    } else if (m.status === 'running') {
      wrap.append(h('div', { class: 'tc-note muted small row' }, h('span', { class: 'spinner' }), t('act.waitingDiff')));
    } else {
      wrap.append(h('div', { class: 'tc-note muted small', text: t('act.noDiff') }));
    }
    if (ch && ch.truncated) wrap.append(h('div', { class: 'fv__note tc-trunc', attrs: { role: 'status' } }, icon('alert'), t('act.truncatedNote')));
    return wrap;
  }

  function infoBody(m, ctx) {
    const wrap = h('div', { class: 'tc-info' });
    const line = displayPath(m, ctx.root) || m.summary || '';
    if (line) wrap.append(h('div', { class: 'tc-info__line mono', text: line }));
    const out = stripAnsi(m.output).replace(/\n+$/, '');
    if (out) {
      const lines = out.split('\n');
      const more = lines.length > PREVIEW_LINES;
      const shown = more && !showAll ? lines.slice(0, PREVIEW_LINES) : lines;
      wrap.append(h('pre', { class: 'tc-preview' + (showAll ? ' is-all' : ''), text: shown.join('\n'), attrs: { tabindex: '0', role: 'region', 'aria-label': t('act.previewLabel') } }));
      if (more) {
        wrap.append(h('button', {
          class: 'btn btn--ghost btn--sm', type: 'button',
          text: showAll ? t('act.showLess') : t('act.moreLines', { count: lines.length - PREVIEW_LINES }) + ' - ' + t('act.showAll'),
          on: { click: () => { showAll = !showAll; sig = ''; update(lastMsg, lastCtx); } },
        }));
      }
    }
    return wrap;
  }

  function genericBody(m) {
    const parts = [];
    const i = m.input;
    if (i && typeof i === 'object') {
      let s = '';
      try { s = JSON.stringify(i, null, 2); } catch { s = String(i); }
      parts.push(s.length > 4000 ? s.slice(0, 4000) + '\n...' : s);
    }
    if (m.output) parts.push(m.output);
    return h('pre', { class: 'tc-preview tc-generic', text: parts.join('\n\n'), attrs: { tabindex: '0', role: 'region', 'aria-label': t('act.previewLabel') } });
  }

  function update(m, ctx) {
    lastMsg = m;
    lastCtx = ctx || lastCtx || {};
    const c = lastCtx;
    const kind = kindOf(m);
    const tt = toolTitle(m, c.root);
    const ch = (kind === 'edit' || kind === 'write') ? changeOf(m) : null;
    const want = KIND_ICONS[kind] || 'tool';
    if (want !== iconName) { iconName = want; ic.replaceChildren(icon(want, 'tool-card__icon')); }
    title.textContent = tt ? t(tt.key, tt.vars) : String(m.name || 'tool');
    title.title = title.textContent;
    summary.textContent = tt ? '' : m.summary || '';
    summary.title = m.summary || '';
    summary.hidden = !!tt || !m.summary;
    deltaHost.replaceChildren(...(ch ? [delta(ch)].filter(Boolean) : []));
    card.className = 'tool-card tool-card--' + kind + (m.status === 'running' ? ' tool-card--running' : '') + (m.status === 'error' ? ' tool-card--error' : '');
    spinner.hidden = m.status !== 'running';
    badge.className = 'badge ' + (m.status === 'running' ? 'badge--purple' : m.status === 'error' ? 'badge--red' : 'badge--green');
    badge.textContent = m.status === 'running' ? t('chat.toolRunning') : m.status === 'error' ? t('chat.toolError') : t('chat.toolDone');
    dur.textContent = m.durationMs != null && m.status !== 'running' ? formatDuration(m.durationMs) : '';
    rawBtn.textContent = t('act.raw');
    rawBtn.title = t('act.rawTitle');
    rawBtn.setAttribute('aria-pressed', String(rawOpen));
    rawBtn.classList.toggle('is-on', rawOpen);

    if (kind === 'command') autoOpen = m.status === 'running' || m.status === 'error';
    else if (ch && ch.diff) autoOpen = countNewlines(ch.diff) <= AUTO_OPEN_DIFF_LINES;
    else autoOpen = false;
    applyOpen();

    const nextSig = JSON.stringify([
      getLanguage(), m.status, (m.output || '').length, (m.commandOutput || '').length, m.exitCode, m.input && m.input.CommandLine, m.input && m.input.command,
      ch && [ch.path, ch.op, ch.added, ch.removed, ch.diff && ch.diff.length, ch.truncated], c.root, rawOpen, showAll, isOpen(),
    ]);
    if (nextSig === sig) return;
    sig = nextSig;
    if (!isOpen()) { body.replaceChildren(); return; } // build bodies lazily: long histories stay cheap
    const parts = [];
    if (kind === 'command') parts.push(commandBody(m));
    else if (kind === 'edit' || kind === 'write') parts.push(fileBody(m, ch, c));
    else if (kind === 'read' || kind === 'search' || kind === 'list') parts.push(infoBody(m, c));
    else parts.push(genericBody(m));
    if (rawOpen) parts.push(h('pre', { class: 'tc-raw', text: rawJson(m, changeOf(m)), attrs: { tabindex: '0', role: 'region', 'aria-label': t('act.rawLabel') } }));
    body.replaceChildren(...parts);
  }

  return {
    el: card,
    update,
    setOpen(v) { userOpen = !!v; if (!v) rawOpen = false; sig = ''; if (lastMsg) update(lastMsg, lastCtx); },
    isOpen,
  };
}
