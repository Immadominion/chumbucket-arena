/**
 * The catalog cover Panta requires on every create (`imageUrl`, recommended
 * 1024x1024 square). Chumbucket has no photo upload yet, so the server renders
 * one deterministic, text-free brand card per category: the pink brand
 * gradient, a category-tinted disc, and an abstract YES/NO market card. The
 * bytes are uploaded through Panta's own signed Cloudinary helper at publish.
 *
 * Dependency-free: a minimal PNG encoder (RGB, 8-bit, Sub filter) over
 * node:zlib. Rendered lazily, once per category per process.
 */
import { deflateSync } from "node:zlib";
import type { PantaCreateCategory } from "./rules.ts";

export const COVER_SIZE = 1024;

type Rgb = readonly [number, number, number];
const hex = (value: number): Rgb => [(value >> 16) & 255, (value >> 8) & 255, value & 255];
const LIGHT_PRIMARY = hex(0xff5a76);
const PRIMARY = hex(0xff3355);
const WHITE = hex(0xffffff);
const BAR = hex(0xe5e7eb);
const YES = hex(0x10b981);
const NO = hex(0x3e1114);
const ACCENT: Record<PantaCreateCategory, Rgb> = {
  sports: hex(0x10b981), crypto: hex(0xf59e0b), politics: hex(0x3b82f6), entertainment: hex(0xa855f7),
  finance: hex(0x14b8a6), science: hex(0x06b6d4), world: hex(0x6366f1), other: hex(0x111827),
};

/** Signed distance to an axis-aligned rounded rectangle. */
function roundedRect(x: number, y: number, left: number, top: number, right: number, bottom: number, radius: number): number {
  const cx = (left + right) / 2, cy = (top + bottom) / 2;
  const qx = Math.abs(x - cx) - ((right - left) / 2 - radius);
  const qy = Math.abs(y - cy) - ((bottom - top) / 2 - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}
const coverage = (distance: number): number => Math.min(1, Math.max(0, 0.5 - distance));
const mix = (under: number, over: number, alpha: number): number => under + (over - under) * alpha;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** Encode packed RGB pixels (row-major) as a PNG. */
export function encodePng(width: number, height: number, rgb: Uint8Array): Buffer {
  if (rgb.length !== width * height * 3) throw new Error("pixel buffer size mismatch");
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const out = y * (stride + 1);
    raw[out] = 1; // Sub: flat horizontal runs encode as zeros
    for (let i = 0; i < stride; i++) {
      const left = i >= 3 ? rgb[y * stride + i - 3]! : 0;
      raw[out + 1 + i] = (rgb[y * stride + i]! - left) & 0xff;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", new Uint8Array(0)),
  ]);
}

/** Render the category's cover as packed RGB. */
export function renderCover(category: PantaCreateCategory, size = COVER_SIZE): Uint8Array {
  const s = size / 1024;
  const accent = ACCENT[category];
  const pixels = new Uint8Array(size * size * 3);
  for (let y = 0; y < size; y++) {
    const t = y / (size - 1);
    const base: [number, number, number] = [
      mix(LIGHT_PRIMARY[0], PRIMARY[0], t), mix(LIGHT_PRIMARY[1], PRIMARY[1], t), mix(LIGHT_PRIMARY[2], PRIMARY[2], t),
    ];
    for (let x = 0; x < size; x++) {
      const px = x + 0.5, py = y + 0.5;
      let r = base[0], g = base[1], b = base[2];
      const paint = (colour: Rgb, alpha: number) => {
        if (alpha <= 0) return;
        r = mix(r, colour[0], alpha); g = mix(g, colour[1], alpha); b = mix(b, colour[2], alpha);
      };
      // Category disc, bleeding off the lower-right corner.
      paint(accent, 0.55 * coverage(Math.hypot(px - 900 * s, py - 930 * s) - 360 * s));
      // The market card.
      paint(WHITE, coverage(roundedRect(px, py, 192 * s, 300 * s, 832 * s, 724 * s, 64 * s)));
      // Two question lines.
      paint(BAR, coverage(roundedRect(px, py, 252 * s, 372 * s, 772 * s, 408 * s, 18 * s)));
      paint(BAR, coverage(roundedRect(px, py, 252 * s, 436 * s, 612 * s, 472 * s, 18 * s)));
      // YES and NO.
      paint(YES, coverage(roundedRect(px, py, 252 * s, 532 * s, 502 * s, 652 * s, 60 * s)));
      paint(NO, coverage(roundedRect(px, py, 522 * s, 532 * s, 772 * s, 652 * s, 60 * s)));
      const at = (y * size + x) * 3;
      pixels[at] = Math.round(r); pixels[at + 1] = Math.round(g); pixels[at + 2] = Math.round(b);
    }
  }
  return pixels;
}

const covers = new Map<PantaCreateCategory, Buffer>();
/** The category's cover PNG, rendered once per process. */
export function coverPng(category: PantaCreateCategory): Buffer {
  let png = covers.get(category);
  if (!png) {
    png = encodePng(COVER_SIZE, COVER_SIZE, renderCover(category));
    covers.set(category, png);
  }
  return png;
}
