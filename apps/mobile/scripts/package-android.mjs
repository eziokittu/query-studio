// Build the release APK and put it where the other artefacts live.
//
// Gradle writes to android/app/build/outputs/apk/release/app-release.apk, which is
// not a name anyone should download. This renames it to match the release manifest
// on glitchbong and checks the things that make an APK installable at all.
//
// Needs a JDK 21 and the Android SDK. Capacitor 7 compiles against Java 21
// (`sourceCompatibility VERSION_21` in capacitor.build.gradle), so a JDK 17 fails
// with an error that names neither Java nor the version.
//
// Usage: node scripts/package-android.mjs
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const mobileRoot = join(here, "..");
const androidRoot = join(mobileRoot, "android");

const version = JSON.parse(readFileSync(join(mobileRoot, "package.json"), "utf8")).version;
const built = join(androidRoot, "app", "build", "outputs", "apk", "release", "app-release.apk");

if (!existsSync(built)) {
  console.error(`[android] No APK at ${built}.`);
  console.error("[android] Run: npm run build:android");
  process.exit(1);
}

const outDir = join(mobileRoot, "release");
mkdirSync(outDir, { recursive: true });

const outFile = join(outDir, `QueryStudio-${version}.apk`);
copyFileSync(built, outFile);

const bytes = statSync(outFile).size;
const sha256 = createHash("sha256").update(readFileSync(outFile)).digest("hex");

console.log(`[android] ${outFile}`);
console.log(`[android] ${(bytes / 1024 / 1024).toFixed(1)} MB`);
console.log(`[android] bytes  ${bytes}`);
console.log(`[android] sha256 ${sha256}`);

// ── verification ─────────────────────────────────────────────────────────────
//
// An unsigned APK cannot be installed at all, and a missing asset shows up as a
// blank screen on a phone rather than as a build failure. Both are checked here
// because neither is visible from a successful Gradle run.

const sdkDir = (() => {
  const props = join(androidRoot, "local.properties");
  if (existsSync(props)) {
    const match = readFileSync(props, "utf8").match(/^sdk\.dir=(.*)$/m);
    if (match) return match[1].trim();
  }
  return process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? "";
})();

const buildTools = sdkDir ? join(sdkDir, "build-tools") : "";
const toolsVersion =
  buildTools && existsSync(buildTools) ? readdirSync(buildTools).sort().at(-1) : null;

if (!toolsVersion) {
  console.warn("[android] Android build-tools not found — skipping signature check.");
} else {
  const apksigner = join(buildTools, toolsVersion, "apksigner.bat");
  try {
    const output = execFileSync(apksigner, ["verify", "--verbose", outFile], {
      encoding: "utf8",
      shell: true,
    });
    const v2 = /v2 scheme \(APK Signature Scheme v2\): true/.test(output);
    console.log(`[android] signed: v1=${/JAR signing\): true/.test(output)} v2=${v2}`);
    if (!v2) {
      console.error("[android] The APK is not signed with scheme v2 — Android 11+ will refuse it.");
      process.exit(1);
    }
  } catch (error) {
    console.error(`[android] apksigner rejected the APK:\n${error.stdout ?? error.message}`);
    process.exit(1);
  }
}

// The DuckDB assets are the whole product; shipping without them is a blank app.
//
// The listing is read straight out of the zip central directory rather than shelling
// out. An APK is a zip, and `tar` here is GNU tar, which cannot read one — and given
// a Windows path it also reads `C:` as an rsh host and fails with "Cannot connect
// to C: resolve failed".
function zipEntryNames(file) {
  const buffer = readFileSync(file);
  const EOCD = 0x06054b50;

  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 22 - 65536; i--) {
    if (buffer.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error(`${file} is not a zip`);

  const total = buffer.readUInt16LE(eocd + 10);
  let at = buffer.readUInt32LE(eocd + 16);
  const names = [];

  for (let i = 0; i < total; i++) {
    const nameLen = buffer.readUInt16LE(at + 28);
    const extraLen = buffer.readUInt16LE(at + 30);
    const commentLen = buffer.readUInt16LE(at + 32);
    names.push(buffer.toString("utf8", at + 46, at + 46 + nameLen));
    at += 46 + nameLen + extraLen + commentLen;
  }

  return names;
}

const listing = zipEntryNames(outFile);
const required = [
  "assets/public/index.html",
  "assets/public/duckdb/duckdb-eh.wasm",
  "assets/public/duckdb/duckdb-browser-eh.worker.js",
];

const missing = required.filter((path) => !listing.includes(path));
if (missing.length > 0) {
  console.error(`[android] The APK is missing:\n  ${missing.join("\n  ")}`);
  process.exit(1);
}

// The privacy claim, checked in the built artefact rather than in the manifest
// source: the stock Capacitor template declares android.permission.INTERNET and the
// manifest deliberately does not.
const manifest = buffer_hasInternet(outFile);
if (manifest) {
  console.error("[android] The APK declares android.permission.INTERNET.");
  console.error("[android] AndroidManifest.xml deliberately omits it — something re-added it.");
  process.exit(1);
}
console.log("[android] no INTERNET permission");

console.log(`[android] payload: ${listing.filter((p) => p.startsWith("assets/public/")).length} web asset entries`);
console.log("[android] UNVERIFIED: built here, never installed on a device.");

/**
 * Whether the compiled manifest names the INTERNET permission.
 *
 * AndroidManifest.xml inside an APK is binary XML, but the string pool keeps the
 * permission names as plain UTF-16, so a substring scan is enough to tell whether it
 * is referenced at all. Cheap, and it cannot produce a false negative.
 */
function buffer_hasInternet(apkPath) {
  const buffer = readFileSync(apkPath);
  const EOCD = 0x06054b50;

  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 22 - 65536; i--) {
    if (buffer.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  const total = buffer.readUInt16LE(eocd + 10);
  let at = buffer.readUInt32LE(eocd + 16);

  for (let i = 0; i < total; i++) {
    const nameLen = buffer.readUInt16LE(at + 28);
    const extraLen = buffer.readUInt16LE(at + 30);
    const commentLen = buffer.readUInt16LE(at + 32);
    const name = buffer.toString("utf8", at + 46, at + 46 + nameLen);
    const localOffset = buffer.readUInt32LE(at + 42);

    if (name === "AndroidManifest.xml") {
      const localNameLen = buffer.readUInt16LE(localOffset + 26);
      const localExtraLen = buffer.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLen + localExtraLen;
      const size = buffer.readUInt32LE(at + 20);
      const raw = buffer.subarray(start, start + size);
      return raw.includes(Buffer.from("android.permission.INTERNET", "utf16le"));
    }

    at += 46 + nameLen + extraLen + commentLen;
  }

  return false;
}
