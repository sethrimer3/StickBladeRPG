/**
 * Generates the StickBlade desktop/app icon: the Stick Ranger stickman
 * holding a sword.
 *
 * The figure is laid out from the real rig proportions in
 * src/sim/clusters/stickRangerBody.ts (head-chest 3.6, chest-hip 3.6,
 * hip-knee 4.8, knee-foot 4.8, head block 5) scaled into a 64x64 design
 * space, so the icon matches the character the game actually simulates.
 *
 * Zero dependencies — this project has no image library, so the script
 * rasterises with 4x supersampling, encodes PNG via node:zlib, and packs the
 * multi-resolution .ico container by hand.
 *
 * Usage: node scripts/generate-stickblade-icon.mjs
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'ASSETS', 'icon');

// ── Palette ────────────────────────────────────────────────────────────────
// Warm off-white figure on near-black keeps the silhouette legible at 16px,
// where a black-on-dark stickman (how the game draws it in-world) would vanish.
const BG_DARK = [0x16, 0x13, 0x0f, 0xff];
const BG_EDGE = [0x2b, 0x24, 0x18, 0xff];
const FIGURE = [0xf4, 0xe9, 0xd4, 0xff];
const BLADE = [0xdd, 0xe8, 0xf6, 0xff];
const BLADE_EDGE = [0x9f, 0xb2, 0xc9, 0xff];
const HILT_GOLD = [0xff, 0xd2, 0x3c, 0xff];

// ── Figure layout, 64x64 design space (y grows downward) ───────────────────
const HEAD = [23, 15];
const CHEST = [23, 26];
const HIP = [23, 35];
const KNEE_L = [18, 43];
const FOOT_L = [15, 53];
const KNEE_R = [28, 43];
const FOOT_R = [32, 52];
// Back arm bent clear of the legs, so the silhouette doesn't grow a third leg.
const SHOULDER_L = [16, 31];
const HAND_L = [11, 38];
// Sword arm forward and up.
const SHOULDER_R = [29, 24];
const HAND_R = [36.5, 18];

// Sword, gripped at the right hand and angled up-right. The tip is kept
// inside the rounded-square corner radius so the blade never clips the tile.
const GRIP_BUTT = [34.5, 20];
const GRIP_TOP = [39.5, 15];
const BLADE_TIP = [49, 5.5];
const GUARD_A = [36.7, 12.2];
const GUARD_B = [42.3, 17.8];

const HEAD_HALF = 5.6;
const LIMB_RADIUS = 2.0;
const SPINE_RADIUS = 2.3;

/** Squared distance from point p to segment ab, used as a capsule test. */
function distToSegment(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** Rounded-square background mask in design space. */
function insideBackground(x, y) {
  const inset = 1.5;
  const r = 9;
  const lo = inset;
  const hi = 64 - inset;
  if (x < lo || y < lo || x > hi || y > hi) return false;
  const cx = Math.min(Math.max(x, lo + r), hi - r);
  const cy = Math.min(Math.max(y, lo + r), hi - r);
  return Math.hypot(x - cx, y - cy) <= r || (x >= lo + r && x <= hi - r) || (y >= lo + r && y <= hi - r);
}

/**
 * Colour at a design-space sample, or null for transparent.
 * Painted back-to-front: background, sword, then the figure on top.
 */
function sampleColor(x, y) {
  if (!insideBackground(x, y)) return null;

  // Subtle vertical lift so the tile doesn't read as a flat black square.
  const t = Math.min(1, Math.max(0, (y - 4) / 56));
  let color = [
    Math.round(BG_EDGE[0] + (BG_DARK[0] - BG_EDGE[0]) * t),
    Math.round(BG_EDGE[1] + (BG_DARK[1] - BG_EDGE[1]) * t),
    Math.round(BG_EDGE[2] + (BG_DARK[2] - BG_EDGE[2]) * t),
    255,
  ];

  // ── Sword (drawn under the hand so the grip reads as held) ──────────────
  const bladeDist = distToSegment(x, y, GRIP_TOP, BLADE_TIP);
  if (bladeDist <= 2.9) color = bladeDist > 1.7 ? BLADE_EDGE : BLADE;
  if (distToSegment(x, y, GUARD_A, GUARD_B) <= 1.7) color = HILT_GOLD;
  if (distToSegment(x, y, GRIP_BUTT, GRIP_TOP) <= 1.6) color = HILT_GOLD;

  // ── Figure ──────────────────────────────────────────────────────────────
  const limbs = [
    [HEAD, CHEST, SPINE_RADIUS],
    [CHEST, HIP, SPINE_RADIUS],
    [CHEST, SHOULDER_L, LIMB_RADIUS],
    [CHEST, SHOULDER_R, LIMB_RADIUS],
    [SHOULDER_L, HAND_L, LIMB_RADIUS],
    [SHOULDER_R, HAND_R, LIMB_RADIUS],
    [HIP, KNEE_L, LIMB_RADIUS],
    [HIP, KNEE_R, LIMB_RADIUS],
    [KNEE_L, FOOT_L, LIMB_RADIUS],
    [KNEE_R, FOOT_R, LIMB_RADIUS],
  ];
  for (const [a, b, r] of limbs) {
    if (distToSegment(x, y, a, b) <= r) return FIGURE;
  }
  // Head: the square block Stick Ranger draws, with the corners eased off.
  const hx = Math.abs(x - HEAD[0]) - (HEAD_HALF - 1.4);
  const hy = Math.abs(y - HEAD[1]) - (HEAD_HALF - 1.4);
  const headDist = Math.hypot(Math.max(hx, 0), Math.max(hy, 0)) + Math.min(Math.max(hx, hy), 0);
  if (headDist <= 1.4) return FIGURE;

  return color;
}

/** Renders one square size with 4x supersampling; returns RGBA bytes. */
function render(size) {
  const SS = 4;
  const out = Buffer.alloc(size * size * 4);
  const scale = 64 / size;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const dx = (px + (sx + 0.5) / SS) * scale;
          const dy = (py + (sy + 0.5) / SS) * scale;
          const c = sampleColor(dx, dy);
          if (c !== null) { r += c[0]; g += c[1]; b += c[2]; a += 255; }
        }
      }
      const n = SS * SS;
      const i = (py * size + px) * 4;
      // Un-premultiply so edge pixels keep their colour instead of darkening.
      if (a > 0) {
        out[i] = Math.round(r / (a / 255));
        out[i + 1] = Math.round(g / (a / 255));
        out[i + 2] = Math.round(b / (a / 255));
      }
      out[i + 3] = Math.round(a / n);
    }
  }
  return out;
}

// ── Minimal PNG encoder ────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba, size, wIn, hIn) {
  const w = wIn ?? size, h = hIn ?? size;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // colour type: RGBA
  // 10..12 = compression, filter, interlace — all 0.

  // One filter byte (0 = None) per scanline.
  const stride = w * 4 + 1;
  const raw = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0;
    rgba.copy(raw, y * stride + 1, y * w * 4, (y + 1) * w * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Packs PNG payloads into an .ico container (PNG-in-ICO, Vista+). */
function encodeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);              // reserved
  header.writeUInt16LE(1, 2);              // type: icon
  header.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(entries.length * 16);
  let offset = 6 + entries.length * 16;
  entries.forEach((e, i) => {
    const o = i * 16;
    dir[o] = e.size >= 256 ? 0 : e.size;   // 0 means 256
    dir[o + 1] = e.size >= 256 ? 0 : e.size;
    dir[o + 2] = 0;                        // palette colours
    dir[o + 3] = 0;                        // reserved
    dir.writeUInt16LE(1, o + 4);           // colour planes
    dir.writeUInt16LE(32, o + 6);          // bits per pixel
    dir.writeUInt32LE(e.png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.png.length;
  });

  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

// ── Main ───────────────────────────────────────────────────────────────────
const SIZES = [16, 24, 32, 48, 64, 128, 256];
mkdirSync(OUT_DIR, { recursive: true });

const entries = SIZES.map((size) => ({ size, png: encodePng(render(size), size) }));

const icoPath = join(OUT_DIR, 'StickBlade_Icon.ico');
const pngPath = join(OUT_DIR, 'StickBlade_Icon.png');
writeFileSync(icoPath, encodeIco(entries));
writeFileSync(pngPath, entries.find((e) => e.size === 256).png);

console.log(`wrote ${icoPath} (${SIZES.join(', ')} px)`);
console.log(`wrote ${pngPath} (256 px)`);
