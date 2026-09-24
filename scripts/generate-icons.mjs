// Renders the WebMark toolbar/store icon to public/icon/<size>.png.
// Dependency-free: shapes are rasterised with supersampling and encoded as PNG
// by hand (node:zlib for deflate, CRC32 for chunk checksums).
//
// Usage: npm run icons

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const SIZES = [16, 32, 48, 128];
const SUPERSAMPLE = 4; // 4×4 samples per pixel
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icon');

const GRADIENT_TOP = [0x6a, 0x5c, 0xff];
const GRADIENT_BOTTOM = [0x4b, 0x3c, 0xe0];
const RIBBON = [0xff, 0xff, 0xff];
const ACCENT = [0xff, 0xc8, 0x57];

// ---------------------------------------------------------------------------
// Geometry (all coordinates in output pixels, origin top-left)

/**
 * Per-size layout. Small sizes are hand-tuned so the ribbon's straight edges
 * land on pixel boundaries; otherwise anti-aliasing smears them into mush.
 */
function layoutFor(size) {
  if (size === 16) {
    // No accent and no rounded ribbon corners: too small to read.
    return { radius: 3.5, ribbon: { l: 5, r: 11, t: 3, b: 13, notch: 3, corner: 0 }, accent: null };
  }
  if (size === 32) {
    return { radius: 7, ribbon: { l: 10, r: 22, t: 6, b: 26, notch: 5, corner: 1 }, accent: null };
  }
  const s = size;
  const l = Math.round(s * 0.31);
  const r = s - l;
  return {
    radius: s * 0.22,
    ribbon: { l, r, t: Math.round(s * 0.19), b: Math.round(s * 0.81), notch: s * 0.16, corner: s * 0.035 },
    // Small "note" dot at the ribbon's top-right corner.
    accent: { cx: r - s * 0.005, cy: Math.round(s * 0.19) + s * 0.005, radius: s * 0.09, ring: s * 0.035 },
  };
}

function insideRoundedSquare(x, y, size, radius) {
  if (x < 0 || y < 0 || x > size || y > size) return false;
  const cx = Math.min(Math.max(x, radius), size - radius);
  const cy = Math.min(Math.max(y, radius), size - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

/** Tall rectangle with a V notch cut into the bottom edge, optional rounded top corners. */
function insideRibbon(x, y, { l, r, t, b, notch, corner }) {
  if (x < l || x > r || y < t || y > b) return false;
  const half = (r - l) / 2;
  const cx = l + half;
  const notchY = b - notch * (1 - Math.abs(x - cx) / half);
  if (y > notchY) return false;
  if (corner > 0 && y < t + corner) {
    const ccx = Math.min(Math.max(x, l + corner), r - corner);
    const dx = x - ccx;
    const dy = y - (t + corner);
    if (dx * dx + dy * dy > corner * corner) return false;
  }
  return true;
}

function insideCircle(x, y, cx, cy, radius) {
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

// ---------------------------------------------------------------------------
// Rasterising

const lerp = (a, b, t) => a + (b - a) * t;

/** RGB colour (0..255) of one sample point, or null when it falls outside the icon. */
function sample(x, y, size, layout) {
  if (!insideRoundedSquare(x, y, size, layout.radius)) return null;
  const t = y / size;
  let color = GRADIENT_TOP.map((c, i) => lerp(c, GRADIENT_BOTTOM[i], t));

  if (insideRibbon(x, y, layout.ribbon)) color = RIBBON;

  const { accent } = layout;
  if (accent) {
    // Background-coloured ring separates the dot from the ribbon behind it.
    if (insideCircle(x, y, accent.cx, accent.cy, accent.radius)) color = ACCENT;
    else if (insideCircle(x, y, accent.cx, accent.cy, accent.radius + accent.ring)) {
      color = GRADIENT_TOP.map((c, i) => lerp(c, GRADIENT_BOTTOM[i], t));
    }
  }
  return color;
}

function renderIcon(size) {
  const layout = layoutFor(size);
  const pixels = Buffer.alloc(size * size * 4);
  const n = SUPERSAMPLE;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let hits = 0;
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          const c = sample(px + (sx + 0.5) / n, py + (sy + 0.5) / n, size, layout);
          if (!c) continue;
          r += c[0];
          g += c[1];
          b += c[2];
          hits++;
        }
      }
      const i = (py * size + px) * 4;
      if (hits === 0) continue; // fully transparent
      // Average only covered samples (straight alpha), coverage becomes alpha.
      pixels[i] = Math.round(r / hits);
      pixels[i + 1] = Math.round(g / hits);
      pixels[i + 2] = Math.round(b / hits);
      pixels[i + 3] = Math.round((hits / (n * n)) * 255);
    }
  }
  return pixels;
}

// ---------------------------------------------------------------------------
// PNG encoding

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // no interlace

  // Each scanline is prefixed with filter type 0 (None).
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const file = join(OUT_DIR, `${size}.png`);
  writeFileSync(file, encodePng(size, renderIcon(size)));
  console.log(`wrote ${file}`);
}
