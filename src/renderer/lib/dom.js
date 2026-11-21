// Small DOM helpers. All content goes through createElement/textContent (no innerHTML).
const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * h('div', { class: 'row', attrs: { role: 'x' }, on: { click: fn }, text: 'hi' }, child, 'string')
 * Other props are set as properties when they exist on the element, else as attributes.
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'attrs') for (const [a, av] of Object.entries(v)) { if (av != null && av !== false) el.setAttribute(a, av === true ? '' : av); }
      else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'style') el.setAttribute('style', v);
      else if (k in el) el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return el;
}

export function clear(el) {
  el.replaceChildren();
  return el;
}

// Feather-style 24x24 stroke icons: arrays of [tag, attrs].
const ICONS = {
  folder: [['path', { d: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z' }]],
  plus: [['path', { d: 'M12 5v14M5 12h14' }]],
  search: [['circle', { cx: 11, cy: 11, r: 7 }], ['path', { d: 'm20 20-3.5-3.5' }]],
  settings: [['circle', { cx: 12, cy: 12, r: 3 }], ['path', { d: 'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z' }]],
  message: [['path', { d: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' }]],
  file: [['path', { d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' }], ['path', { d: 'M14 2v6h6M8 13h8M8 17h8' }]],
  layers: [['path', { d: 'm12 2 10 5-10 5L2 7z' }], ['path', { d: 'm2 17 10 5 10-5M2 12l10 5 10-5' }]],
  chevron: [['path', { d: 'm9 6 6 6-6 6' }]],
  send: [['path', { d: 'M12 19V5M5 12l7-7 7 7' }]],
  stop: [['rect', { x: 6, y: 6, width: 12, height: 12, rx: 2 }]],
  copy: [['rect', { x: 9, y: 9, width: 11, height: 11, rx: 2 }], ['path', { d: 'M5 15V6a2 2 0 0 1 2-2h9' }]],
  alert: [['path', { d: 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z' }], ['path', { d: 'M12 9v4M12 17h.01' }]],
  check: [['path', { d: 'm5 12 5 5L20 7' }]],
  x: [['path', { d: 'M6 6l12 12M18 6 6 18' }]],
  git: [['circle', { cx: 6, cy: 6, r: 2 }], ['circle', { cx: 6, cy: 18, r: 2 }], ['circle', { cx: 18, cy: 8, r: 2 }], ['path', { d: 'M6 8v8M18 10c0 4-6 3-12 6' }]],
  panelRight: [['rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }], ['path', { d: 'M15 4v16' }]],
  panelLeft: [['rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }], ['path', { d: 'M9 4v16' }]],
  undo: [['path', { d: 'M9 14 4 9l5-5' }], ['path', { d: 'M4 9h10a6 6 0 0 1 0 12h-3' }]],
  terminal: [['path', { d: 'm4 17 6-6-6-6M12 19h8' }]],
  edit: [['path', { d: 'M12 20h9' }], ['path', { d: 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z' }]],
  tool: [['path', { d: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z' }]],
  sparkles: [['path', { d: 'm12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z' }]],
  shield: [['path', { d: 'M12 2 4 5v6c0 5 3.4 9.5 8 11 4.6-1.5 8-6 8-11V5z' }], ['path', { d: 'M12 8v4M12 16h.01' }]],
  clock: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M12 7v5l3 2' }]],
  arrowDown: [['path', { d: 'M12 5v14M5 12l7 7 7-7' }]],
  more: [['circle', { cx: 12, cy: 5, r: 1 }], ['circle', { cx: 12, cy: 12, r: 1 }], ['circle', { cx: 12, cy: 19, r: 1 }]],
  play: [['path', { d: 'M6 4l14 8-14 8z' }]],
  trash: [['path', { d: 'M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v5M14 11v5' }]],
  external: [['path', { d: 'M14 4h6v6M20 4 10 14M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5' }]],
  download: [['path', { d: 'M12 4v11M7 11l5 5 5-5M5 20h14' }]],
  link: [['path', { d: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1' }]],
  refresh: [['path', { d: 'M21 12a9 9 0 0 1-15.5 6.2M3 12A9 9 0 0 1 18.5 5.8' }], ['path', { d: 'M21 4v5h-5M3 20v-5h5' }]],
};

export function icon(name, cls = '') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', ('icon ' + cls).trim());
  for (const [tag, attrs] of ICONS[name] || ICONS.tool) {
    const n = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    svg.appendChild(n);
  }
  return svg;
}

let uid = 0;
export function nextId(prefix = 'fs') {
  uid += 1;
  return prefix + '-' + uid;
}

export const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function focusables(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter((el) => !el.hidden && el.offsetParent !== null);
}

/** Roving radiogroup keyboard support (Left/Right/Up/Down) for role=radio buttons. */
export function radioKeys(group) {
  group.addEventListener('keydown', (e) => {
    const keys = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 };
    if (!(e.key in keys)) return;
    const items = [...group.querySelectorAll('[role="radio"]:not([disabled])')];
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const next = items[(i + keys[e.key] + items.length) % items.length];
    next.focus();
    next.click();
  });
}
