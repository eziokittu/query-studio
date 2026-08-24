// Generate the Android and iOS app icons.
//
// `cap add` ships Capacitor's own placeholder logo, which is a visible "this is
// unfinished" signal on a home screen. This replaces it with the same mark the
// desktop build uses — the drawing lives in scripts/icon-art.mjs at the repo root.
//
// Safe to re-run: it only writes the icon files, and `cap sync` does not touch them.
// It has to be run again after a fresh `cap add`, which restores the placeholders.
//
// Android gets three sets across five densities:
//
//   ic_launcher            legacy square-ish icon, for launchers before API 26
//   ic_launcher_round      legacy circular icon, for launchers that ask for one
//   ic_launcher_foreground the adaptive icon's foreground layer — the mark alone on
//                          transparency, drawn at two thirds scale so the launcher
//                          can crop it to any shape without clipping the artwork
//
// iOS gets a single 1024x1024, which is what modern Xcode asset catalogues want.
// It is written without an alpha channel: an app icon with transparency is an App
// Store submission rejection, not a rendering quirk.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ANDROID_BACKGROUND, encodePng, render } from "../../../scripts/icon-art.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const mobileRoot = join(here, "..");

// ── Android ──────────────────────────────────────────────────────────────────

// Launcher icons are 48dp; adaptive foregrounds are 108dp. Both scale with density.
const DENSITIES = [
  { dir: "mipmap-mdpi", legacy: 48, adaptive: 108 },
  { dir: "mipmap-hdpi", legacy: 72, adaptive: 162 },
  { dir: "mipmap-xhdpi", legacy: 96, adaptive: 216 },
  { dir: "mipmap-xxhdpi", legacy: 144, adaptive: 324 },
  { dir: "mipmap-xxxhdpi", legacy: 192, adaptive: 432 },
];

const androidRes = join(mobileRoot, "android", "app", "src", "main", "res");

if (!existsSync(androidRes)) {
  console.log("[icons] No android project — run `npm run add:android` first. Skipping.");
} else {
  let written = 0;

  for (const { dir, legacy, adaptive } of DENSITIES) {
    const target = join(androidRes, dir);
    mkdirSync(target, { recursive: true });

    writeFileSync(join(target, "ic_launcher.png"), encodePng(legacy, render(legacy, "rounded")));
    writeFileSync(join(target, "ic_launcher_round.png"), encodePng(legacy, render(legacy, "circle")));
    writeFileSync(
      join(target, "ic_launcher_foreground.png"),
      encodePng(adaptive, render(adaptive, "foreground")),
    );
    written += 3;
  }

  // mipmap-anydpi-v26/ic_launcher.xml composes the adaptive icon from this colour
  // and the foreground above. The template leaves it white, which would put a white
  // ring around a dark mark on every launcher that masks to a circle.
  writeFileSync(
    join(androidRes, "values", "ic_launcher_background.xml"),
    `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${ANDROID_BACKGROUND}</color>\n</resources>\n`,
  );

  console.log(`[icons] Android: ${written} PNGs across ${DENSITIES.length} densities, background ${ANDROID_BACKGROUND}`);
}

// ── iOS ──────────────────────────────────────────────────────────────────────

const appIcon = join(mobileRoot, "ios", "App", "App", "Assets.xcassets", "AppIcon.appiconset");

if (!existsSync(appIcon)) {
  console.log("[icons] No ios project — run `npm run add:ios` first. Skipping.");
} else {
  // Square and opaque: iOS applies its own corner mask, and rounding it here would
  // show as a dark halo inside the system's rounded rectangle.
  writeFileSync(
    join(appIcon, "AppIcon-512@2x.png"),
    encodePng(1024, render(1024, "square"), { opaque: true }),
  );
  console.log("[icons] iOS: AppIcon-512@2x.png (1024x1024, no alpha)");
}
