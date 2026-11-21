// Generates build/icon.png (512x512) with no dependencies: gold rounded square with a dark "F" mark.
// Run: node scripts/make-icon.mjs   (electron-builder converts the PNG to .ico for the Windows build)
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

const N = 512;
const SS = 3; // supersampling per axis for anti-aliased edges
const px = new Uint8Array(N * N * 4);

const inRoundRect = (x, y, x0, y0, x1, y1, r) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = x < x0 + r ? x0 + r : x > x1 - r ? x1 - r : x;
  const cy = y < y0 + r ? y0 + r : y > y1 - r ? y1 - r : y;
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
const lerp = (a, b, t) => a + (b - a) * t;
// "F": stem + top bar + middle bar (in a 512 box)
const F = [[168, 124, 232, 388], [168, 124, 372, 188], [168, 232, 330, 288]];
const inF = (x, y) => F.some(([x0, y0, x1, y1]) => inRoundRect(x, y, x0, y0, x1, y1, 14));

for (let j = 0; j < N; j++) {
  for (let i = 0; i < N; i++) {
    let cov = 0; let fcov = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const x = i + (sx + 0.5) / SS; const y = j + (sy + 0.5) / SS;
        if (inRoundRect(x, y, 16, 16, 496, 496, 104)) { cov++; if (inF(x, y)) fcov++; }
      }
    }
    const a = cov / (SS * SS); const f = cov ? fcov / cov : 0;
    const t = j / N;
    const gold = [lerp(240, 200, t), lerp(217, 160, t), lerp(138, 40, t)]; // light gold -> deep gold
    const dark = [26, 20, 0];
    const o = (j * N + i) * 4;
    px[o] = lerp(gold[0], dark[0], f); px[o + 1] = lerp(gold[1], dark[1], f); px[o + 2] = lerp(gold[2], dark[2], f);
    px[o + 3] = Math.round(a * 255);
  }
}

// --- minimal PNG encoder ---
const crcTable = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
const raw = Buffer.alloc((N * 4 + 1) * N);
for (let j = 0; j < N; j++) { raw[j * (N * 4 + 1)] = 0; Buffer.from(px.buffer, j * N * 4, N * 4).copy(raw, j * (N * 4 + 1) + 1); }
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
mkdirSync('build', { recursive: true });
writeFileSync('build/icon.png', png);
console.log('wrote build/icon.png', png.length, 'bytes');
