// CSS colour string -> '#rrggbb' (pure). Used to colour the native window-controls overlay from computed theme tokens.

const clamp = (n) => Math.max(0, Math.min(255, Math.round(n)));
const hex2 = (n) => clamp(n).toString(16).padStart(2, '0');

/**
 * Accepts '#rgb', '#rgba', '#rrggbb', '#rrggbbaa', 'rgb(r, g, b)', 'rgb(r g b / a)', 'rgba(r,g,b,a)' (percent channels too).
 * Alpha is ignored (the overlay needs an opaque colour). Returns null when the input is not understood.
 * @param {string} css
 * @returns {string|null}
 */
export function cssColorToHex(css) {
  const s = String(css == null ? '' : css).trim().toLowerCase();
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    const h = m[1];
    if (h.length === 3 || h.length === 4) return '#' + h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (h.length === 6 || h.length === 8) return '#' + h.slice(0, 6);
    return null;
  }
  m = /^rgba?\(\s*([^)]*)\)$/.exec(s);
  if (!m) return null;
  const parts = m[1].split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const ch = [];
  for (const p of parts.slice(0, 3)) {
    const pm = /^(-?\d*\.?\d+)(%?)$/.exec(p);
    if (!pm) return null;
    ch.push(pm[2] ? (parseFloat(pm[1]) / 100) * 255 : parseFloat(pm[1]));
  }
  return '#' + ch.map(hex2).join('');
}

/** Same as cssColorToHex with a fallback. */
export function cssColorToHexOr(css, fallback) {
  return cssColorToHex(css) || fallback;
}
