// The Query Studio app mark, and a PNG encoder for it.
//
// Shared by apps/desktop/scripts/make-icons.mjs (ico / icns / png) and
// apps/mobile/scripts/make-icons.mjs (Android mipmaps, iOS AppIcon), so the five
// platforms cannot drift into five slightly different logos.
//
// Written by hand rather than pulled from an image library on purpose. sharp and
// canvas are native modules that need a compiler on every machine that builds a
// release, and drawing four rounded rectangles is not worth that. A PNG is a zlib
// stream with a one-byte filter per scanline; both ICO and ICNS are containers that
// take PNG members directly.
//
// The mark is a table: a bright header row, three data rows, and a cursor block
// trailing the last one. It has to survive being 16 pixels wide in a taskbar, so
// there is no text, no thin stroke and no gradient inside the mark itself.
import { deflateSync } from "node:zlib";

// glitchbong's palette, so every app reads as the same product as the site.
export const NEON = [0x39, 0xff, 0x14];
export const PAPER = [0xf0, 0xe6, 0xff];
export const TOP = [0x1a, 0x0b, 0x26];
export const BOTTOM = [0x0b, 0x04, 0x12];

/** The background colour Android's adaptive icon fills behind the foreground. */
export const ANDROID_BACKGROUND = "#12071B";

const CORNER_RADIUS = 0.185;
const BAR_RADIUS = 0.028;

// The mark, in unit coordinates, top to bottom.
const BARS = [
  { left: 0.2, top: 0.255, right: 0.8, bottom: 0.335, color: NEON, alpha: 1.0 },
  { left: 0.2, top: 0.395, right: 0.72, bottom: 0.475, color: NEON, alpha: 0.62 },
  { left: 0.2, top: 0.535, right: 0.8, bottom: 0.615, color: NEON, alpha: 0.62 },
  { left: 0.2, top: 0.675, right: 0.575, bottom: 0.755, color: NEON, alpha: 0.62 },
  // The cursor. Paper-white rather than neon so it reads as a separate element and
  // not as a fourth row someone forgot to align.
  { left: 0.625, top: 0.675, right: 0.71, bottom: 0.755, color: PAPER, alpha: 0.95 },
];

/**
 * Android adaptive icons are 108dp, of which only the centre 72dp is guaranteed to
 * survive the launcher's mask. Everything outside that can be cropped to a circle,
 * a squircle, or whatever the OEM ships. So the foreground variant draws the mark
 * at two thirds scale, centred, and lets the outer ring be sacrificial.
 */
const ADAPTIVE_SAFE_FRACTION = 72 / 108;

/** Rounded-rectangle hit test in unit space. */
function inRounded(x, y, left, top, right, bottom, radius) {
  if (x < left || x > right || y < top || y > bottom) return false;

  const cx = Math.min(Math.max(x, left + radius), right - radius);
  const cy = Math.min(Math.max(y, top + radius), bottom - radius);
  const dx = x - cx;
  const dy = y - cy;

  return dx * dx + dy * dy <= radius * radius;
}

/** Whether a sample point is inside the tile, for each variant's silhouette. */
function inMask(x, y, variant) {
  switch (variant) {
    // Full bleed and fully opaque. iOS rejects an app icon with an alpha channel,
    // and applies its own corner mask, so it must be given a plain square.
    case "square":
      return true;
    case "circle":
      return (x - 0.5) ** 2 + (y - 0.5) ** 2 <= 0.25;
    // The launcher supplies the background and the mask; this layer is only the
    // mark on transparency.
    case "foreground":
      return true;
    default:
      return inRounded(x, y, 0, 0, 1, 1, CORNER_RADIUS);
  }
}

/**
 * Colour of one sample point.
 *
 * Returns null where the point is not painted — outside the silhouette, or, in the
 * foreground variant, anywhere that is not part of the mark itself.
 */
function sample(x, y, variant) {
  if (!inMask(x, y, variant)) return null;

  const foreground = variant === "foreground";

  // Shrink the mark into the adaptive safe zone by sampling a correspondingly
  // larger area of the artwork.
  const ax = foreground ? (x - 0.5) / ADAPTIVE_SAFE_FRACTION + 0.5 : x;
  const ay = foreground ? (y - 0.5) / ADAPTIVE_SAFE_FRACTION + 0.5 : y;

  let r;
  let g;
  let b;

  if (foreground) {
    // No background layer here, so a point that hits no bar stays transparent.
    const hit = BARS.find((bar) => inRounded(ax, ay, bar.left, bar.top, bar.right, bar.bottom, BAR_RADIUS));
    if (!hit) return null;
    // Composite against the same dark ground the launcher will paint, so the 62%
    // rows keep the colour they have everywhere else rather than turning pale.
    r = TOP[0] + (hit.color[0] - TOP[0]) * hit.alpha;
    g = TOP[1] + (hit.color[1] - TOP[1]) * hit.alpha;
    b = TOP[2] + (hit.color[2] - TOP[2]) * hit.alpha;
    return [r, g, b];
  }

  // Background gradient, top to bottom.
  r = TOP[0] + (BOTTOM[0] - TOP[0]) * y;
  g = TOP[1] + (BOTTOM[1] - TOP[1]) * y;
  b = TOP[2] + (BOTTOM[2] - TOP[2]) * y;

  for (const bar of BARS) {
    if (!inRounded(ax, ay, bar.left, bar.top, bar.right, bar.bottom, BAR_RADIUS)) continue;
    r += (bar.color[0] - r) * bar.alpha;
    g += (bar.color[1] - g) * bar.alpha;
    b += (bar.color[2] - b) * bar.alpha;
  }

  return [r, g, b];
}

/**
 * Render at `size`, returning raw RGBA.
 *
 * Supersampled and box-filtered down: at 16px the difference between antialiased
 * and not is the difference between a logo and a smear.
 */
export function render(size, variant = "rounded", supersample = 4) {
  const pixels = Buffer.alloc(size * size * 4);
  const step = 1 / (size * supersample);
  const samples = supersample * supersample;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let covered = 0;

      for (let sy = 0; sy < supersample; sy++) {
        for (let sx = 0; sx < supersample; sx++) {
          const colour = sample(
            (px * supersample + sx + 0.5) * step,
            (py * supersample + sy + 0.5) * step,
            variant,
          );
          if (!colour) continue;
          r += colour[0];
          g += colour[1];
          b += colour[2];
          covered++;
        }
      }

      if (covered === 0) continue;

      // Colour is the average of the *covered* samples only; coverage becomes alpha.
      // Averaging over all samples would pull every rounded corner towards black,
      // which is the classic dark halo on a light desktop background.
      const at = (py * size + px) * 4;
      pixels[at] = Math.round(r / covered);
      pixels[at + 1] = Math.round(g / covered);
      pixels[at + 2] = Math.round(b / covered);
      pixels[at + 3] = Math.round((covered / samples) * 255);
    }
  }

  return pixels;
}

// ── PNG ──────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);

  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));

  return Buffer.concat([length, body, crc]);
}

/**
 * Encode RGBA as a PNG.
 *
 * `opaque` drops the alpha channel entirely (colour type 2 rather than 6), which is
 * what iOS requires of an app icon — an alpha channel is a submission rejection, not
 * a rendering quirk.
 */
export function encodePng(size, pixels, { opaque = false } = {}) {
  const channels = opaque ? 3 : 4;
  const stride = size * channels + 1;
  const raw = Buffer.alloc(size * stride);

  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: None
    for (let x = 0; x < size; x++) {
      const from = (y * size + x) * 4;
      const to = y * stride + 1 + x * channels;
      raw[to] = pixels[from];
      raw[to + 1] = pixels[from + 1];
      raw[to + 2] = pixels[from + 2];
      if (!opaque) raw[to + 3] = pixels[from + 3];
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = opaque ? 2 : 6; // colour type: RGB or RGBA

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
