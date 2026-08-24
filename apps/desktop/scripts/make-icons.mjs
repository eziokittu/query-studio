// Generate the desktop icons electron-builder needs.
//
// build/icon.png (Linux), build/icon.ico (Windows) and build/icon.icns (macOS).
// Without these the packaged app either fails to build or ships with Electron's own
// logo, which looks like an unfinished side project.
//
// The drawing lives in scripts/icon-art.mjs at the repo root, shared with the
// mobile icons so the five platforms cannot drift apart.
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { encodePng, render } from "../../../scripts/icon-art.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "build");

// ── containers ───────────────────────────────────────────────────────────────

/** ICO, with PNG members. Supported since Vista, which is the floor Electron sets. */
function ico(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);

  const directory = Buffer.alloc(entries.length * 16);
  let offset = header.length + directory.length;

  entries.forEach((entry, i) => {
    const at = i * 16;
    // 0 means 256 in these fields, which is why they are only one byte wide.
    directory[at] = entry.size >= 256 ? 0 : entry.size;
    directory[at + 1] = entry.size >= 256 ? 0 : entry.size;
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(entry.data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += entry.data.length;
  });

  return Buffer.concat([header, directory, ...entries.map((e) => e.data)]);
}

/** ICNS, with PNG members. The four-character types are Apple's size codes. */
function icns(members) {
  const body = Buffer.concat(
    members.map(({ type, data }) => {
      const header = Buffer.alloc(8);
      header.write(type, 0, 4, "ascii");
      header.writeUInt32BE(data.length + 8, 4);
      return Buffer.concat([header, data]);
    }),
  );

  const header = Buffer.alloc(8);
  header.write("icns", 0, 4, "ascii");
  header.writeUInt32BE(body.length + 8, 4);

  return Buffer.concat([header, body]);
}

// ── write ────────────────────────────────────────────────────────────────────

mkdirSync(out, { recursive: true });

const rendered = new Map();
for (const size of [16, 32, 48, 64, 128, 256, 512, 1024]) {
  rendered.set(size, encodePng(size, render(size, "rounded")));
}

writeFileSync(join(out, "icon.png"), rendered.get(1024));

// Windows ignores ICO members larger than 256.
writeFileSync(
  join(out, "icon.ico"),
  ico([16, 32, 48, 64, 128, 256].map((size) => ({ size, data: rendered.get(size) }))),
);

writeFileSync(
  join(out, "icon.icns"),
  icns([
    { type: "icp4", data: rendered.get(16) },
    { type: "icp5", data: rendered.get(32) },
    { type: "ic11", data: rendered.get(32) }, // 16x16@2x
    { type: "ic12", data: rendered.get(64) }, // 32x32@2x
    { type: "ic07", data: rendered.get(128) },
    { type: "ic13", data: rendered.get(256) }, // 128x128@2x
    { type: "ic08", data: rendered.get(256) },
    { type: "ic14", data: rendered.get(512) }, // 256x256@2x
    { type: "ic09", data: rendered.get(512) },
    { type: "ic10", data: rendered.get(1024) }, // 512x512@2x
  ]),
);

for (const name of ["icon.png", "icon.ico", "icon.icns"]) {
  console.log(`[icons] ${name.padEnd(10)} ${(statSync(join(out, name)).size / 1024).toFixed(1)} KB`);
}
