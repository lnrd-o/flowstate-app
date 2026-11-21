// Pure geometry helpers for the methodology graph (no DOM). Transform tr = { x, y, k }: screen = graph * k + (x, y).

export const NODE_W = 216;
export const NODE_H = 76;
export const SCALE_MIN = 0.25;
export const SCALE_MAX = 2;

export const portOut = (p) => ({ x: p.x + NODE_W, y: p.y + NODE_H / 2 });
export const portIn = (p) => ({ x: p.x, y: p.y + NODE_H / 2 });

/** Cubic edge from the output port of `from` to the input port of `to`. Returns { d, mid, start, end }. */
export function edgeGeometry(from, to) {
  const s = portOut(from);
  const e = portIn(to);
  return pathBetween(s, e);
}

/** Same as edgeGeometry but between two free points (used while dragging a new connection). */
export function pathBetween(s, e) {
  const dx = Math.max(48, Math.abs(e.x - s.x) / 2);
  const c1 = { x: s.x + dx, y: s.y };
  const c2 = { x: e.x - dx, y: e.y };
  const mid = {
    x: 0.125 * s.x + 0.375 * c1.x + 0.375 * c2.x + 0.125 * e.x,
    y: 0.125 * s.y + 0.375 * c1.y + 0.375 * c2.y + 0.125 * e.y,
  };
  const r = (n) => Math.round(n * 10) / 10;
  const d = `M${r(s.x)} ${r(s.y)} C${r(c1.x)} ${r(c1.y)} ${r(c2.x)} ${r(c2.y)} ${r(e.x)} ${r(e.y)}`;
  return { d, mid: { x: r(mid.x), y: r(mid.y) }, start: s, end: e };
}

/** Bounding box { minX, minY, maxX, maxY } of positions {id: {x,y}} including node size. null when empty. */
export function boundsOf(pos) {
  const pts = Object.values(pos || {});
  if (!pts.length) return null;
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + NODE_W); maxY = Math.max(maxY, p.y + NODE_H);
  }
  return { minX, minY, maxX, maxY };
}

export const clampScale = (k, min = SCALE_MIN, max = SCALE_MAX) => Math.min(max, Math.max(min, k));

/** Transform that fits `bounds` into a viewport { w, h } with padding, centered. Never zooms in past `max`. */
export function fitTransform(bounds, vp, { padding = 32, min = SCALE_MIN, max = 1.1 } = {}) {
  if (!bounds || !(vp.w > 0) || !(vp.h > 0)) return { x: padding, y: padding, k: 1 };
  const bw = bounds.maxX - bounds.minX;
  const bh = bounds.maxY - bounds.minY;
  const k = clampScale(Math.min((vp.w - padding * 2) / bw, (vp.h - padding * 2) / bh), min, max);
  // when the content does not fit even at the smallest allowed scale, align its start (left/top) instead of centering
  const ox = bw * k > vp.w - padding * 2 ? padding : (vp.w - bw * k) / 2;
  const oy = bh * k > vp.h - padding * 2 ? padding : (vp.h - bh * k) / 2;
  return { k, x: Math.round(ox - bounds.minX * k), y: Math.round(oy - bounds.minY * k) };
}

/** Zoom by `factor` keeping the screen point `pt` fixed. */
export function zoomAt(tr, factor, pt, { min = SCALE_MIN, max = SCALE_MAX } = {}) {
  const k = clampScale(tr.k * factor, min, max);
  const f = k / tr.k;
  return { k, x: pt.x - (pt.x - tr.x) * f, y: pt.y - (pt.y - tr.y) * f };
}

export const screenToGraph = (tr, pt) => ({ x: (pt.x - tr.x) / tr.k, y: (pt.y - tr.y) / tr.k });

/** Truncate with an ellipsis so the text fits `max` characters. */
export function truncate(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : s.slice(0, Math.max(1, max - 1)).trimEnd() + '\u2026';
}

/** Id of the node whose rectangle contains the graph point, topmost (last) wins. */
export function hitNode(pos, pt) {
  let hit = null;
  for (const [id, p] of Object.entries(pos)) {
    if (pt.x >= p.x && pt.x <= p.x + NODE_W && pt.y >= p.y && pt.y <= p.y + NODE_H) hit = id;
  }
  return hit;
}
