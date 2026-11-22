// Agent identity icons (inline SVG, original artwork).
//   claude: a 12-ray irregular burst in Claude orange (var(--claude)).
//   agy:    a 4-point sparkle star filled with the four Gemini colours (red, yellow, green, blue; no purple).
// Animation is pure CSS (styles/app.css) on `.agent-icon.is-running`; everything is disabled under prefers-reduced-motion.
const NS = 'http://www.w3.org/2000/svg';
let uid = 0;

const RAY_LEN = [10.4, 8.2, 10.9, 7.6, 10.2, 8.8, 10.6, 7.9, 10.3, 8.5, 10.8, 8.0];
const RAY_JIT = [0, 3, -2, 4, -3, 2, 0, -4, 3, -2, 2, -3];
const RAY_W = [2.5, 2.1, 2.7, 1.9, 2.4, 2.2, 2.6, 2.0, 2.5, 2.1, 2.7, 2.0];
const STAR = 'M12 0.8C12.9 7 17 11.1 23.2 12C17 12.9 12.9 17 12 23.2C11.1 17 7 12.9 0.8 12C7 11.1 11.1 7 12 0.8Z';

function el(tag, attrs, ...kids) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, String(v));
  for (const c of kids) n.appendChild(c);
  return n;
}

/** The ray geometry (exported for tests): [{ x0, y0, x1, y1, w }]. */
export function claudeRays() {
  const out = [];
  for (let i = 0; i < 12; i++) {
    const a = ((i * 30 - 90 + RAY_JIT[i]) * Math.PI) / 180;
    const r0 = 2.6;
    const r1 = RAY_LEN[i];
    out.push({
      x0: +(12 + Math.cos(a) * r0).toFixed(2), y0: +(12 + Math.sin(a) * r0).toFixed(2),
      x1: +(12 + Math.cos(a) * r1).toFixed(2), y1: +(12 + Math.sin(a) * r1).toFixed(2), w: RAY_W[i],
    });
  }
  return out;
}

function claudeSvg(size) {
  const svg = el('svg', { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': 'true', focusable: 'false', class: 'agent-icon__svg' });
  for (const r of claudeRays()) {
    svg.appendChild(el('path', { d: 'M' + r.x0 + ' ' + r.y0 + 'L' + r.x1 + ' ' + r.y1, 'stroke-width': r.w, 'stroke-linecap': 'round', class: 'ai-ray' }));
  }
  svg.appendChild(el('circle', { cx: 12, cy: 12, r: 3.1, class: 'ai-core' }));
  return svg;
}

function agySvg(size) {
  const n = ++uid;
  const fid = 'agy-blur-' + n;
  const cid = 'agy-clip-' + n;
  const svg = el('svg', { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': 'true', focusable: 'false', class: 'agent-icon__svg' });
  const clip = el('clipPath', { id: cid }, el('path', { d: STAR }));
  const blur = el('filter', { id: fid, x: '-50%', y: '-50%', width: '200%', height: '200%' }, el('feGaussianBlur', { stdDeviation: 2.2 }));
  svg.appendChild(el('defs', null, clip, blur));
  // Four soft colour blobs, one per tip (red top, yellow left, green bottom, blue right), clipped to the star.
  // The clip sits on a static group; only the inner group rotates, so running = the colours circulate through the star.
  const blobs = el('g', { filter: 'url(#' + fid + ')' },
    el('circle', { cx: 12, cy: 3.2, r: 7.5, fill: '#EA4335' }), el('circle', { cx: 3.2, cy: 12, r: 7.5, fill: '#FBBC04' }),
    el('circle', { cx: 12, cy: 20.8, r: 7.5, fill: '#34A853' }), el('circle', { cx: 20.8, cy: 12, r: 7.5, fill: '#4285F4' }));
  svg.appendChild(el('g', { 'clip-path': 'url(#' + cid + ')' }, el('g', { class: 'ai-flow' }, blobs)));
  return svg;
}

/**
 * agentIcon('claude' | 'agy', { size = 16, state = 'idle' | 'running' }) -> <span class="agent-icon agent-icon--<agent> [is-running]">.
 * The returned span can be restyled later with setIconState(). Unknown agents get a neutral spark.
 */
export function agentIcon(agent, opts) {
  const o = opts || {};
  const size = o.size || 16;
  const span = document.createElement('span');
  const known = agent === 'claude' || agent === 'agy';
  span.className = 'agent-icon agent-icon--' + (known ? agent : 'none');
  span.style.setProperty('--ai-size', size + 'px');
  span.setAttribute('aria-hidden', 'true');
  if (agent === 'claude') span.appendChild(claudeSvg(size));
  else if (agent === 'agy') span.appendChild(agySvg(size));
  else {
    const svg = el('svg', { viewBox: '0 0 24 24', width: size, height: size, class: 'agent-icon__svg', 'aria-hidden': 'true', focusable: 'false' }, el('path', { d: STAR, class: 'ai-core' }));
    span.appendChild(svg);
  }
  setIconState(span, o.state);
  return span;
}

export function setIconState(span, state) {
  span.classList.toggle('is-running', state === 'running');
}
