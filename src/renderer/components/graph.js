// Methodology graph: SVG view/editor (no libs). The component owns gestures only; the host owns the methodology
// (pure ops in lib/graph-state.js) and calls setMethodology() after every change.
import { layoutGraph, pickText, startNodes } from '../../shared/methodology.js';
import { h, icon, nextId } from '../lib/dom.js';
import { t, getLanguage } from '../lib/i18n.js';
import { NODE_W, NODE_H, edgeGeometry, pathBetween, portOut, boundsOf, fitTransform, zoomAt, screenToGraph, truncate, hitNode } from '../lib/graph-geom.js';
import { NODE_META, nodeSummary } from '../lib/method-utils.js';

const NS = 'http://www.w3.org/2000/svg';
const GLYPH = { running: '\u2026', waiting: '||', done: '\u2713', error: '\u00d7', warn: '!', skipped: '\u2013' };

function s(tag, attrs, ...kids) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v != null && v !== false) el.setAttribute(k, v === true ? '' : String(v));
  for (const k of kids.flat()) if (k != null) el.appendChild(typeof k === 'string' ? document.createTextNode(k) : k);
  return el;
}
const text = (cls, x, y, str) => { const el = s('text', { class: cls, x, y }); el.textContent = str; return el; };

/**
 * createGraph({ editable, onSelect(sel|null), onOpen(id), onMove(id,x,y), onConnect(from,to), onDelete(sel), onModeChange(bool) })
 * sel = { kind:'node', id } | { kind:'edge', index }.
 */
export function createGraph(opts = {}) {
  const editable = !!opts.editable;
  const uid = nextId('graph');
  const el = h('div', { class: 'graph' + (editable ? ' is-editable' : '') });
  const svg = s('svg', { class: 'graph__svg', role: 'group', tabindex: editable ? '-1' : null });
  const defs = s('defs', null, s('marker', { id: uid + '-arrow', viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '8', markerHeight: '8', orient: 'auto-start-reverse', markerUnits: 'userSpaceOnUse' }, s('path', { d: 'M0 0 10 5 0 10z', class: 'graph__arrow' })));
  const bg = s('rect', { class: 'graph__bg', x: 0, y: 0, width: '100%', height: '100%' });
  const vp = s('g', { class: 'graph__vp' });
  const gEdges = s('g', { class: 'graph__edges' });
  const gNodes = s('g', { class: 'graph__nodes' });
  const tmp = s('path', { class: 'graph__tmp', hidden: true, 'marker-end': `url(#${uid}-arrow)` });
  vp.append(gEdges, gNodes, tmp);
  svg.append(defs, bg, vp);
  const ctl = (name, key, fn) => h('button', { class: 'btn btn--icon btn--sm graph__btn', type: 'button', on: { click: fn }, attrs: { 'data-act': name } }, icon(key));
  const btnIn = ctl('zoom-in', 'plus', () => zoomBy(1.25));
  const btnOut = ctl('zoom-out', 'minus', () => zoomBy(0.8));
  const btnFit = ctl('fit', 'fit', () => fit(true));
  const controls = h('div', { class: 'graph__controls', attrs: { role: 'group' } }, btnIn, btnOut, btnFit);
  const srList = h('ol', { class: 'sr-only', id: uid + '-steps' });
  const live = h('div', { class: 'sr-only', attrs: { role: 'status', 'aria-live': 'polite' } });
  el.append(svg, controls, srList, live);

  let m = null;
  let pos = {};
  let tr = { x: 24, y: 24, k: 1 };
  let userMoved = false;
  let sel = null;
  let runState = null;
  let connectMode = false;
  let connectFrom = null;
  let drag = null; // { kind:'pan'|'node'|'link', ... }
  const nodeEls = new Map();
  let edgeEls = [];
  let lang = getLanguage();

  const apply = () => vp.setAttribute('transform', `translate(${tr.x} ${tr.y}) scale(${tr.k})`);
  const size = () => { const r = svg.getBoundingClientRect(); return { w: r.width, h: r.height }; };
  const toGraph = (e) => { const r = svg.getBoundingClientRect(); return screenToGraph(tr, { x: e.clientX - r.left, y: e.clientY - r.top }); };
  const titleOf = (n) => pickText(n.title, lang) || n.id;
  const typeLabel = (n) => t('method.type.' + n.type);
  const stateOf = (id) => (runState && runState.nodes && runState.nodes[id] && runState.nodes[id].state) || null;

  /** all=true fits the whole graph (button); otherwise a readable fit that never shrinks below 0.7. */
  function fit(all = true) {
    if (!m) return;
    const sz = size();
    tr = fitTransform(boundsOf(pos), sz, all ? {} : { min: 0.7 });
    userMoved = false;
    apply();
  }
  /** Pan (never zoom) so that the node is fully inside the viewport. */
  function reveal(id) {
    const p = pos[id];
    if (!p) return;
    const sz = size();
    if (sz.w < 10) return;
    const pad = 24;
    const l = p.x * tr.k + tr.x; const r = (p.x + NODE_W) * tr.k + tr.x;
    const tp = p.y * tr.k + tr.y; const b = (p.y + NODE_H) * tr.k + tr.y;
    let dx = 0; let dy = 0;
    if (l < pad) dx = pad - l; else if (r > sz.w - 52) dx = sz.w - 52 - r;
    if (tp < pad) dy = pad - tp; else if (b > sz.h - pad) dy = sz.h - pad - b;
    if (dx || dy) { tr = { ...tr, x: tr.x + dx, y: tr.y + dy }; userMoved = true; apply(); }
  }
  function zoomBy(f) {
    const sz = size();
    tr = zoomAt(tr, f, { x: sz.w / 2, y: sz.h / 2 });
    userMoved = true;
    apply();
  }

  // ---------- rendering ----------
  function buildNode(n) {
    const meta = NODE_META[n.type];
    const cond = n.type === 'condition';
    const p = pos[n.id];
    const g = s('g', { class: `gnode gnode--${n.type}`, transform: `translate(${p.x} ${p.y})`, 'data-id': n.id, tabindex: '-1', role: 'button' });
    const card = cond
      ? s('polygon', { class: 'gnode__card', points: `0,${NODE_H / 2} 22,0 ${NODE_W - 22},0 ${NODE_W},${NODE_H / 2} ${NODE_W - 22},${NODE_H} 22,${NODE_H}` })
      : s('rect', { class: 'gnode__card', width: NODE_W, height: NODE_H, rx: 12 });
    const halo = s('rect', { class: 'gnode__halo', x: -5, y: -5, width: NODE_W + 10, height: NODE_H + 10, rx: 16 });
    const ic = icon(meta.icon, 'gnode__icon');
    ic.setAttribute('x', cond ? 26 : 12); ic.setAttribute('y', 10); ic.setAttribute('width', 16); ic.setAttribute('height', 16);
    const tx = cond ? 26 : 12;
    const badge = s('g', { class: 'gnode__badge', transform: `translate(${NODE_W - 6} 4)` }, s('circle', { r: 10 }), text('gnode__glyph', 0, 4, ''));
    const outPort = s('circle', { class: 'gnode__port gnode__port--out', cx: NODE_W, cy: NODE_H / 2, r: 6, 'data-port': 'out' });
    const inPort = s('circle', { class: 'gnode__port gnode__port--in', cx: 0, cy: NODE_H / 2, r: 4 });
    const tip = s('title');
    g.append(tip, halo, card, ic, text('gnode__type', tx + 22, 23, truncate(typeLabel(n), 22)),
      text('gnode__title', tx, 47, truncate(titleOf(n), cond ? 22 : 27)), text('gnode__sum', tx, 64, truncate(nodeSummary(n), cond ? 28 : 33)), inPort, editable ? outPort : null, badge);
    nodeEls.set(n.id, g);
    return g;
  }

  function nodeLabel(n) {
    const st = stateOf(n.id);
    const outs = m.edges.filter((e) => e.from === n.id).map((e) => (e.label ? t('graph.' + e.label) + ': ' : '') + titleOf(m.nodes.find((q) => q.id === e.to) || { id: e.to }));
    return [`${titleOf(n)}, ${typeLabel(n)}`, st ? t('method.state.' + st) : '', outs.length ? t('graph.nextSteps', { list: outs.join(', ') }) : t('graph.endStep')].filter(Boolean).join('. ');
  }

  function buildEdge(e, i) {
    const a = pos[e.from]; const b = pos[e.to];
    if (!a || !b) return null;
    const geo = edgeGeometry(a, b);
    const line = s('path', { class: 'gedge__line', d: geo.d, 'marker-end': `url(#${uid}-arrow)` });
    const hit = s('path', { class: 'gedge__hit', d: geo.d });
    const g = s('g', { class: 'gedge', 'data-index': i }, hit, line);
    let lab = null;
    if (e.label) {
      const label = t('graph.' + e.label);
      const w = label.length * 7 + 14;
      lab = s('g', { class: `gedge__label gedge__label--${e.label}`, transform: `translate(${geo.mid.x} ${geo.mid.y})` }, s('rect', { x: -w / 2, y: -10, width: w, height: 20, rx: 10 }), text('gedge__text', 0, 4, label));
      g.append(lab);
    }
    return { g, line, hit, lab, e };
  }

  function render() {
    lang = getLanguage();
    const hadFocus = el.contains(document.activeElement) && document.activeElement.dataset ? document.activeElement.dataset.id : null;
    gNodes.replaceChildren(); gEdges.replaceChildren(); nodeEls.clear();
    if (!m) { edgeEls = []; return; }
    pos = layoutGraph(m);
    if (drag && drag.kind === 'node' && drag.moved) pos[drag.id] = drag.cur;
    svg.setAttribute('aria-label', t('graph.label', { name: pickText(m.name, lang), count: m.nodes.length }));
    svg.setAttribute('aria-describedby', uid + '-steps');
    edgeEls = m.edges.map(buildEdge).filter(Boolean);
    for (const x of edgeEls) gEdges.append(x.g);
    for (const n of m.nodes) gNodes.append(buildNode(n));
    renderSr();
    applyDecor();
    if (hadFocus && nodeEls.has(hadFocus)) nodeEls.get(hadFocus).focus({ preventScroll: true });
  }

  function renderSr() {
    const order = [];
    const seen = new Set();
    const visit = (id) => { if (!id || seen.has(id)) return; seen.add(id); order.push(id); for (const e of m.edges.filter((q) => q.from === id)) visit(e.to); };
    try { for (const st of startNodes(m)) visit(st.id); } catch { /* ignore */ }
    for (const n of m.nodes) visit(n.id);
    srList.replaceChildren(...order.map((id) => { const n = m.nodes.find((q) => q.id === id); return h('li', { text: nodeLabel(n) + (nodeSummary(n) ? '. ' + truncate(nodeSummary(n), 120) : '') }); }));
  }

  /** Classes that depend on selection / run state / connect mode. Cheap: no rebuild. */
  function applyDecor() {
    if (!m) return;
    svg.classList.toggle('has-run', !!runState);
    svg.classList.toggle('is-connecting', connectMode || (drag && drag.kind === 'link'));
    const focusId = sel && sel.kind === 'node' ? sel.id : (m.nodes[0] && (startNodes(m)[0] || m.nodes[0]).id);
    for (const n of m.nodes) {
      const g = nodeEls.get(n.id);
      if (!g) continue;
      const st = stateOf(n.id);
      const isSel = sel && sel.kind === 'node' && sel.id === n.id;
      g.setAttribute('class', `gnode gnode--${n.type}${isSel ? ' is-selected' : ''}${connectFrom === n.id ? ' is-source' : ''}${st ? ' st-' + st : ''}${runState && runState.current === n.id ? ' is-current' : ''}`);
      g.setAttribute('aria-pressed', String(!!isSel));
      g.setAttribute('aria-label', nodeLabel(n));
      if (!g.contains(document.activeElement)) g.setAttribute('tabindex', n.id === focusId ? '0' : '-1');
      const tip = g.querySelector('title');
      tip.textContent = nodeLabel(n);
      const glyph = g.querySelector('.gnode__glyph');
      glyph.textContent = st && GLYPH[st] ? GLYPH[st] : '';
    }
    edgeEls.forEach((x, i) => {
      const fromSt = stateOf(x.e.from); const toSt = stateOf(x.e.to);
      const walked = runState && (fromSt === 'done' || fromSt === 'warn') && toSt && toSt !== 'pending' && toSt !== 'skipped';
      x.g.setAttribute('class', `gedge${sel && sel.kind === 'edge' && sel.index === i ? ' is-selected' : ''}${walked ? ' is-walked' : ''}`);
    });
  }

  function relayoutEdges() {
    edgeEls.forEach((x) => {
      const a = pos[x.e.from]; const b = pos[x.e.to];
      const geo = edgeGeometry(a, b);
      x.line.setAttribute('d', geo.d); x.hit.setAttribute('d', geo.d);
      if (x.lab) x.lab.setAttribute('transform', `translate(${geo.mid.x} ${geo.mid.y})`);
    });
  }

  // ---------- selection ----------
  function select(next, notify = true) {
    sel = next;
    applyDecor();
    if (notify && opts.onSelect) opts.onSelect(sel);
  }

  function setConnectMode(on, from = null) {
    connectMode = !!on; connectFrom = on ? from : null;
    applyDecor();
    live.textContent = on ? t(from ? 'graph.connectPickTarget' : 'graph.connectPickSource') : '';
    if (opts.onModeChange) opts.onModeChange(connectMode);
  }

  function nodeFromEvent(e) { const g = e.target.closest && e.target.closest('.gnode'); return g ? g.dataset.id : null; }

  // ---------- pointer ----------
  svg.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const portEl = e.target.closest && e.target.closest('[data-port="out"]');
    const id = nodeFromEvent(e);
    const edgeG = e.target.closest && e.target.closest('.gedge');
    const r = svg.getBoundingClientRect();
    const pt = { x: e.clientX - r.left, y: e.clientY - r.top };
    if (editable && portEl && id) {
      drag = { kind: 'link', from: id, pid: e.pointerId };
      svg.setPointerCapture(e.pointerId);
      e.preventDefault();
      applyDecor();
      return;
    }
    if (id) {
      if (connectMode) { handleConnectClick(id); e.preventDefault(); return; }
      select({ kind: 'node', id });
      nodeEls.get(id).focus({ preventScroll: true });
      drag = { kind: 'node', id, start: pt, orig: { ...pos[id] }, cur: { ...pos[id] }, moved: false, pid: e.pointerId };
      svg.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    if (edgeG) { select({ kind: 'edge', index: Number(edgeG.dataset.index) }); e.preventDefault(); return; }
    drag = { kind: 'pan', start: pt, orig: { ...tr }, moved: false, pid: e.pointerId };
    svg.setPointerCapture(e.pointerId);
    svg.classList.add('is-panning');
  });

  svg.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (e.buttons === 0) { endDrag(e, true); return; } // missed pointerup (released outside the window)
    const r = svg.getBoundingClientRect();
    const pt = { x: e.clientX - r.left, y: e.clientY - r.top };
    if (drag.kind === 'pan') {
      const dx = pt.x - drag.start.x; const dy = pt.y - drag.start.y;
      if (!drag.moved && Math.hypot(dx, dy) < 3) return;
      drag.moved = true; userMoved = true;
      tr = { ...tr, x: drag.orig.x + dx, y: drag.orig.y + dy };
      apply();
    } else if (drag.kind === 'node') {
      const dx = (pt.x - drag.start.x) / tr.k; const dy = (pt.y - drag.start.y) / tr.k;
      if (!drag.moved && Math.hypot(dx, dy) * tr.k < 4) return;
      if (!editable) return;
      drag.moved = true;
      drag.cur = { x: Math.round(drag.orig.x + dx), y: Math.round(drag.orig.y + dy) };
      pos[drag.id] = drag.cur;
      nodeEls.get(drag.id).setAttribute('transform', `translate(${drag.cur.x} ${drag.cur.y})`);
      relayoutEdges();
    } else if (drag.kind === 'link') {
      const g = toGraph(e);
      const geo = pathBetween(portOut(pos[drag.from]), g);
      tmp.setAttribute('d', geo.d); tmp.removeAttribute('hidden'); tmp.style.display = 'block';
      const over = hitNode(pos, g);
      for (const [nid, ne] of nodeEls) ne.classList.toggle('is-drop', nid === over && nid !== drag.from);
    }
  });

  function endDrag(e, cancel) {
    const d = drag;
    if (!d) return;
    drag = null;
    try { svg.releasePointerCapture(d.pid); } catch { /* not captured */ }
    svg.classList.remove('is-panning');
    tmp.style.display = 'none';
    for (const ne of nodeEls.values()) ne.classList.remove('is-drop');
    if (d.kind === 'pan' && !d.moved && !cancel) select(null);
    if (d.kind === 'node' && d.moved && !cancel) { if (opts.onMove) opts.onMove(d.id, d.cur.x, d.cur.y); else render(); }
    if (d.kind === 'node' && d.moved && cancel) render();
    if (d.kind === 'link' && !cancel) {
      const over = hitNode(pos, toGraph(e));
      if (over && over !== d.from && opts.onConnect) opts.onConnect(d.from, over);
    }
    applyDecor();
  }
  svg.addEventListener('pointerup', (e) => endDrag(e, false));
  svg.addEventListener('pointercancel', (e) => endDrag(e, true));

  svg.addEventListener('dblclick', (e) => { const id = nodeFromEvent(e); if (id && opts.onOpen) opts.onOpen(id); });

  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = svg.getBoundingClientRect();
    tr = zoomAt(tr, e.deltaY < 0 ? 1.1 : 1 / 1.1, { x: e.clientX - r.left, y: e.clientY - r.top });
    userMoved = true;
    apply();
  }, { passive: false });

  function handleConnectClick(id) {
    if (!connectFrom) { connectFrom = id; applyDecor(); live.textContent = t('graph.connectPickTarget'); return; }
    if (id === connectFrom) { connectFrom = null; applyDecor(); return; }
    const from = connectFrom;
    setConnectMode(false);
    if (opts.onConnect) opts.onConnect(from, id);
  }

  // ---------- keyboard ----------
  function neighbour(id, dir) {
    const cur = pos[id];
    if (dir === 'right') { const e = m.edges.find((q) => q.from === id); return e ? e.to : null; }
    if (dir === 'left') { const e = m.edges.find((q) => q.to === id); return e ? e.from : null; }
    const col = m.nodes.filter((n) => Math.abs(pos[n.id].x - cur.x) < NODE_W / 2).sort((a, b) => pos[a.id].y - pos[b.id].y);
    const i = col.findIndex((n) => n.id === id);
    const nx = col[i + (dir === 'down' ? 1 : -1)];
    return nx ? nx.id : null;
  }

  svg.addEventListener('keydown', (e) => {
    const id = nodeFromEvent(e);
    const keyDir = { ArrowRight: 'right', ArrowLeft: 'left', ArrowDown: 'down', ArrowUp: 'up' }[e.key];
    if (e.key === 'Escape') {
      if (drag && drag.kind === 'link') { drag = null; tmp.style.display = 'none'; applyDecor(); }
      if (connectMode) setConnectMode(false);
      return;
    }
    if (e.key === '+' || e.key === '=') { zoomBy(1.25); return; }
    if (e.key === '-') { zoomBy(0.8); return; }
    if (e.key === '0') { fit(true); return; }
    if (!id) return;
    if (keyDir) {
      const to = neighbour(id, keyDir);
      e.preventDefault();
      if (to) { select({ kind: 'node', id: to }); reveal(to); nodeEls.get(to).focus({ preventScroll: true }); }
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (connectMode) { handleConnectClick(id); return; }
      select({ kind: 'node', id });
      if (opts.onOpen) opts.onOpen(id);
      return;
    }
    if (editable && (e.key === 'Delete' || e.key === 'Backspace') && opts.onDelete) { e.preventDefault(); opts.onDelete({ kind: 'node', id }); return; }
    if (editable && e.key.toLowerCase() === 'c' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); setConnectMode(true, id); }
  });
  svg.addEventListener('focusin', (e) => {
    const id = nodeFromEvent(e);
    if (!id) return;
    for (const [nid, ne] of nodeEls) ne.setAttribute('tabindex', nid === id ? '0' : '-1');
  });

  // ---------- size ----------
  let fitted = false;
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
    const sz = size();
    if (sz.w < 10 || sz.h < 10 || !m) return;
    if (!fitted || !userMoved) { fitted = true; fit(false); }
  }) : null;
  if (ro) ro.observe(svg);
  apply();

  return {
    el,
    setMethodology(next, { keepView = true } = {}) {
      const first = !m;
      m = next;
      render();
      if (first || !keepView) { userMoved = false; if (size().w > 10) fit(false); }
    },
    setRunState(rs) { runState = rs || null; applyDecor(); if (m) renderSr(); },
    setSelection(next) { select(next, false); },
    getSelection: () => sel,
    setConnectMode,
    isConnecting: () => connectMode,
    focusNode(id) { const n = nodeEls.get(id); if (n) { reveal(id); n.focus({ preventScroll: true }); } },
    reveal,
    refresh() { render(); },
    fit: (all) => fit(all !== false), zoomBy,
    destroy() { if (ro) ro.disconnect(); },
  };
}
