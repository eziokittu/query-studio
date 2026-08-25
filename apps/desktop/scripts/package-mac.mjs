// Build a macOS .app, from Windows, as a .zip.
//
// electron-builder refuses outright — "Build for macOS is supported only on macOS" —
// because a normal mac build shells out to `hdiutil`, `ditto` and `codesign`. None of
// those exist here. But none of them are actually required to *assemble* the bundle:
// a .app is a directory with a known layout, and a .zip of it is a first-class way to
// ship a Mac app.
//
// The one thing that genuinely cannot be done on Windows is create the 14 symlinks a
// macOS framework needs (Versions/Current, Electron Framework, Resources, …).
// Creating a symlink needs Developer Mode or an elevated shell, and without it the
// AppImage build already died with EPERM. So this never creates one: it reads
// Electron's official darwin zip and copies every entry's *raw compressed bytes*
// along with its external attributes into a new zip. A symlink stays a symlink
// because the entry is copied, not materialised. Executable bits survive for the same
// reason.
//
// What is changed:
//   * Electron.app/                      -> Query Studio.app/
//   * Contents/MacOS/Electron            -> Contents/MacOS/Query Studio
//   * Contents/Info.plist                 rewritten (name, id, version, icon, exe)
//   * Contents/Resources/electron.icns    replaced with ours
//   * Contents/Resources/default_app.asar dropped (Electron's welcome app)
//   * Contents/Resources/app.asar         added, plus app.asar.unpacked and app/
//
// Electron's darwin zip ships unsigned — there is no _CodeSignature directory in it —
// so adding files breaks no signature seal. The result is an unsigned app, which
// macOS quarantines on download like any other: the user right-clicks and chooses
// Open the first time, or runs `xattr -cr "Query Studio.app"`.
//
// UNVERIFIED. This was assembled on Windows and has never been launched on a Mac.
// The structure is checked at the end of this script, but "the zip is correct" is not
// the same as "the app runs".
//
// Usage: node scripts/package-mac.mjs [arm64|x64]
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { BINDINGS_DIR, fetchBinding } from "./fetch-bindings.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, "..");
const repoRoot = join(appRoot, "..", "..");

const arch = process.argv[2] ?? "arm64";
if (!["arm64", "x64"].includes(arch)) {
  console.error(`[mac] Unknown arch ${arch}. Use arm64 or x64.`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8"));
const version = pkg.version;
const productName = pkg.build.productName;
const appId = pkg.build.appId;
const electronVersion = JSON.parse(
  readFileSync(join(repoRoot, "node_modules", "electron", "package.json"), "utf8"),
).version;

const APP_DIR = `${productName}.app`;
const cacheDir = join(appRoot, ".electron-dist");
const zipName = `electron-v${electronVersion}-darwin-${arch}.zip`;
const zipPath = join(cacheDir, zipName);
const outPath = join(appRoot, "release", `QueryStudio-${version}-${arch}-mac.zip`);

// ── get Electron's darwin build ──────────────────────────────────────────────

if (!existsSync(zipPath)) {
  mkdirSync(cacheDir, { recursive: true });
  const url = `https://github.com/electron/electron/releases/download/v${electronVersion}/${zipName}`;
  console.log(`[mac] Downloading ${zipName}`);

  const response = await fetch(url);
  if (!response.ok) {
    console.error(`[mac] ${response.status} fetching ${url}`);
    process.exit(1);
  }
  writeFileSync(zipPath, Buffer.from(await response.arrayBuffer()));
}

console.log(`[mac] Electron ${electronVersion} darwin-${arch} (${(statSync(zipPath).size / 1024 / 1024).toFixed(1)} MB)`);

// ── a zip reader, enough for this ────────────────────────────────────────────

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

function readZip(buffer) {
  // The EOCD is at the end, after a comment of up to 64 KB.
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 22 - 65536; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error("No end-of-central-directory record — not a zip?");

  const total = buffer.readUInt16LE(eocd + 10);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff) throw new Error("Zip64 archive — this reader does not handle it");

  const entries = [];
  let at = cdOffset;

  for (let i = 0; i < total; i++) {
    if (buffer.readUInt32LE(at) !== CD_SIG) throw new Error(`Bad central directory entry at ${at}`);

    const flags = buffer.readUInt16LE(at + 8);
    const method = buffer.readUInt16LE(at + 10);
    const modTime = buffer.readUInt16LE(at + 12);
    const modDate = buffer.readUInt16LE(at + 14);
    const crc = buffer.readUInt32LE(at + 16);
    const compressedSize = buffer.readUInt32LE(at + 20);
    const uncompressedSize = buffer.readUInt32LE(at + 24);
    const nameLen = buffer.readUInt16LE(at + 28);
    const extraLen = buffer.readUInt16LE(at + 30);
    const commentLen = buffer.readUInt16LE(at + 32);
    const versionMadeBy = buffer.readUInt16LE(at + 4);
    const externalAttrs = buffer.readUInt32LE(at + 38);
    const localOffset = buffer.readUInt32LE(at + 42);
    const name = buffer.toString("utf8", at + 46, at + 46 + nameLen);

    // The compressed bytes start after the *local* header, whose extra field can
    // differ in length from the central one.
    if (buffer.readUInt32LE(localOffset) !== LOCAL_SIG) {
      throw new Error(`Bad local header for ${name}`);
    }
    const localNameLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;

    entries.push({
      name,
      flags,
      method,
      modTime,
      modDate,
      crc,
      compressedSize,
      uncompressedSize,
      versionMadeBy,
      externalAttrs,
      data: buffer.subarray(dataStart, dataStart + compressedSize),
    });

    at += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

// ── a zip writer ─────────────────────────────────────────────────────────────

/** Unix mode out of a zip external attributes field. */
const modeOf = (externalAttrs) => (externalAttrs >>> 16) & 0xffff;
/** Zip external attributes for a unix mode. */
const attrsFor = (mode) => (mode & 0xffff) * 0x10000;

const S_IFLNK = 0o120000;
const isSymlink = (entry) => (modeOf(entry.externalAttrs) & 0o170000) === S_IFLNK;

class ZipWriter {
  constructor() {
    this.chunks = [];
    this.central = [];
    this.offset = 0;
  }

  push(buffer) {
    this.chunks.push(buffer);
    this.offset += buffer.length;
  }

  /** Add an entry whose compressed bytes are already in hand. */
  addRaw(entry, name = entry.name) {
    const nameBuf = Buffer.from(name, "utf8");
    const localOffset = this.offset;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4); // version needed
    // The data descriptor bit would put crc/sizes after the data; sizes are known
    // here, so it is cleared and the values written inline.
    local.writeUInt16LE(entry.flags & ~0x08, 6);
    local.writeUInt16LE(entry.method, 8);
    local.writeUInt16LE(entry.modTime, 10);
    local.writeUInt16LE(entry.modDate, 12);
    local.writeUInt32LE(entry.crc, 14);
    local.writeUInt32LE(entry.compressedSize, 18);
    local.writeUInt32LE(entry.uncompressedSize, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    this.push(local);
    this.push(nameBuf);
    this.push(entry.data);

    this.central.push({ ...entry, name, localOffset });
  }

  /** Add a new file from raw content. */
  addFile(name, content, mode = 0o644) {
    const deflated = deflateRawSync(content, { level: 9 });
    // Storing is smaller when deflate does not help (already-compressed payloads).
    const useDeflate = deflated.length < content.length;

    this.addRaw(
      {
        flags: 0,
        method: useDeflate ? 8 : 0,
        modTime: 0,
        modDate: 0x21, // 1980-01-01, so the archive is reproducible
        crc: crc32(content),
        compressedSize: useDeflate ? deflated.length : content.length,
        uncompressedSize: content.length,
        versionMadeBy: (3 << 8) | 20, // unix
        externalAttrs: attrsFor(mode),
        data: useDeflate ? deflated : content,
      },
      name,
    );
  }

  finish() {
    const cdStart = this.offset;

    for (const entry of this.central) {
      const nameBuf = Buffer.from(entry.name, "utf8");
      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(CD_SIG, 0);
      cd.writeUInt16LE(entry.versionMadeBy, 4);
      cd.writeUInt16LE(20, 6);
      cd.writeUInt16LE(entry.flags & ~0x08, 8);
      cd.writeUInt16LE(entry.method, 10);
      cd.writeUInt16LE(entry.modTime, 12);
      cd.writeUInt16LE(entry.modDate, 14);
      cd.writeUInt32LE(entry.crc, 16);
      cd.writeUInt32LE(entry.compressedSize, 20);
      cd.writeUInt32LE(entry.uncompressedSize, 24);
      cd.writeUInt16LE(nameBuf.length, 28);
      cd.writeUInt16LE(0, 30);
      cd.writeUInt16LE(0, 32);
      cd.writeUInt16LE(0, 34);
      cd.writeUInt16LE(0, 36);
      cd.writeUInt32LE(entry.externalAttrs >>> 0, 38);
      cd.writeUInt32LE(entry.localOffset, 42);

      this.push(cd);
      this.push(nameBuf);
    }

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(EOCD_SIG, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(this.central.length, 8);
    eocd.writeUInt16LE(this.central.length, 10);
    eocd.writeUInt32LE(this.offset - cdStart, 12);
    eocd.writeUInt32LE(cdStart, 16);
    eocd.writeUInt16LE(0, 20);
    this.push(eocd);

    return Buffer.concat(this.chunks);
  }
}

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

// ── assemble ─────────────────────────────────────────────────────────────────

const source = readZip(readFileSync(zipPath));
console.log(`[mac] ${source.length} entries in, ${source.filter(isSymlink).length} of them symlinks`);

const MAIN_EXE_IN = "Electron.app/Contents/MacOS/Electron";
const MAIN_EXE_OUT = `${APP_DIR}/Contents/MacOS/${productName}`;

// Dropped: rewritten below, or Electron's own placeholder app.
const REPLACED = new Set([
  "Electron.app/Contents/Info.plist",
  "Electron.app/Contents/Resources/electron.icns",
  "Electron.app/Contents/Resources/default_app.asar",
]);

const original = new Map(source.map((e) => [e.name, e]));
const writer = new ZipWriter();

let copied = 0;
// Electron's zip carries the bundle root both as `Electron.app` and `Electron.app/`,
// and both rename to the same output path. A duplicate entry is legal in a zip but
// extractors disagree about which one wins, so the first is kept and the rest
// dropped.
const written = new Set();

for (const entry of source) {
  if (REPLACED.has(entry.name)) continue;

  const name =
    entry.name === MAIN_EXE_IN
      ? MAIN_EXE_OUT
      : `${APP_DIR}/${entry.name.slice("Electron.app/".length)}`;

  if (written.has(name)) continue;
  written.add(name);

  writer.addRaw(entry, name);
  copied++;
}

// ── Info.plist ───────────────────────────────────────────────────────────────

const originalPlist = original.get("Electron.app/Contents/Info.plist");
if (!originalPlist) {
  console.error("[mac] Electron.app/Contents/Info.plist is missing from the zip.");
  process.exit(1);
}

// Written out rather than patched: the original is Electron's own, and every key
// that identifies the app has to change anyway. Keys that matter here are
// CFBundleExecutable (must match the file in Contents/MacOS or the app will not
// launch) and CFBundleIconFile.
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key>
	<string>en</string>
	<key>CFBundleDisplayName</key>
	<string>${productName}</string>
	<key>CFBundleExecutable</key>
	<string>${productName}</string>
	<key>CFBundleIconFile</key>
	<string>electron.icns</string>
	<key>CFBundleIdentifier</key>
	<string>${appId}</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleName</key>
	<string>${productName}</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>${version}</string>
	<key>CFBundleVersion</key>
	<string>${version}</string>
	<key>LSApplicationCategoryType</key>
	<string>public.app-category.developer-tools</string>
	<key>LSMinimumSystemVersion</key>
	<string>11.0.0</string>
	<key>NSHighResolutionCapable</key>
	<true/>
	<key>NSRequiresAquaSystemAppearance</key>
	<false/>
	<key>NSSupportsAutomaticGraphicsSwitching</key>
	<true/>
	<key>CFBundleDocumentTypes</key>
	<array>
		<dict>
			<key>CFBundleTypeName</key>
			<string>Data file</string>
			<key>CFBundleTypeRole</key>
			<string>Viewer</string>
			<key>LSHandlerRank</key>
			<string>Alternate</string>
			<key>LSItemContentTypes</key>
			<array>
				<string>public.comma-separated-values-text</string>
				<string>public.tab-separated-values-text</string>
				<string>public.json</string>
				<string>public.plain-text</string>
			</array>
		</dict>
	</array>
</dict>
</plist>
`;
writer.addFile(`${APP_DIR}/Contents/Info.plist`, Buffer.from(plist, "utf8"));

// ── icon ─────────────────────────────────────────────────────────────────────

const icns = join(appRoot, "build", "icon.icns");
if (!existsSync(icns)) {
  console.error("[mac] build/icon.icns is missing. Run `npm run icons` first.");
  process.exit(1);
}
writer.addFile(`${APP_DIR}/Contents/Resources/electron.icns`, readFileSync(icns));

// ── the app payload ──────────────────────────────────────────────────────────
//
// app.asar holds only dist/*.cjs and package.json — everything native is in
// asarUnpack — so the copy electron-builder produced for another platform is byte
// for byte what macOS needs. The unpacked native addon is *not* portable, so it is
// assembled here from the darwin binding.

const built = ["linux-arm64-unpacked", "linux-unpacked", "win-unpacked"]
  .map((d) => join(appRoot, "release", d))
  .find((d) => existsSync(join(d, "resources", "app.asar")));

if (!built) {
  console.error("[mac] No existing build to take resources/app.asar from.");
  console.error("[mac] Run: node scripts/build-installer.mjs --linux dir --x64");
  process.exit(1);
}

console.log(`[mac] Reusing app.asar from ${relative(appRoot, built)}`);
writer.addFile(`${APP_DIR}/Contents/Resources/app.asar`, readFileSync(join(built, "resources", "app.asar")));

/** Add a directory tree, preserving nothing but the file bytes. */
function addTree(fromDir, toPrefix, mode = 0o644) {
  let count = 0;
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const stats = statSync(full);
      if (stats.isDirectory()) {
        walk(full);
        continue;
      }
      if (!stats.isFile()) continue;

      const rel = relative(fromDir, full).split(sep).join("/");
      // Native code has to be executable; the loader checks.
      const isNative = /\.(node|dylib)$/.test(name);
      writer.addFile(`${toPrefix}/${rel}`, readFileSync(full), isNative ? 0o755 : mode);
      count++;
    }
  };
  walk(fromDir);
  return count;
}

// The web UI, which electron-builder places at resources/app via extraResources.
const webDist = join(appRoot, "..", "web", "dist");
if (!existsSync(join(webDist, "index.html"))) {
  console.error("[mac] apps/web/dist is missing. Run `npm run build` at the repo root.");
  process.exit(1);
}
console.log(`[mac] resources/app: ${addTree(webDist, `${APP_DIR}/Contents/Resources/app`)} files`);

// The native addon, for this arch.
const unpackedPrefix = `${APP_DIR}/Contents/Resources/app.asar.unpacked/node_modules/@duckdb`;
let nativeFiles = 0;

for (const name of ["node-api", "node-bindings"]) {
  nativeFiles += addTree(join(repoRoot, "node_modules", "@duckdb", name), `${unpackedPrefix}/${name}`);
}

const bindingName = `node-bindings-darwin-${arch}`;
let bindingDir = join(BINDINGS_DIR, `darwin-${arch}`);
if (!existsSync(bindingDir)) {
  console.log(`[mac] Fetching @duckdb/${bindingName}`);
  bindingDir = fetchBinding(`darwin-${arch}`);
}
// The tarball already carries the published package.json; adding another here
// produced a duplicate zip entry for the same path.
nativeFiles += addTree(bindingDir, `${unpackedPrefix}/${bindingName}`);
console.log(`[mac] app.asar.unpacked: ${nativeFiles} files (${bindingName})`);

// ── write and check ──────────────────────────────────────────────────────────

mkdirSync(join(appRoot, "release"), { recursive: true });
const output = writer.finish();
writeFileSync(outPath, output);

console.log(`\n[mac] ${outPath}`);
console.log(`[mac] ${(output.length / 1024 / 1024).toFixed(1)} MB`);
console.log(`[mac] sha256 ${createHash("sha256").update(output).digest("hex")}`);

// Re-read what was just written and check the things that would silently break the
// bundle. This cannot tell us the app runs — only that the archive says what it
// should.
const check = readZip(readFileSync(outPath));
const byName = new Map(check.map((e) => [e.name, e]));

const problems = [];
const expect = (condition, message) => {
  if (!condition) problems.push(message);
};

const symlinksIn = source.filter(isSymlink).length;
const symlinksOut = check.filter(isSymlink).length;
expect(symlinksOut === symlinksIn, `symlinks: ${symlinksOut} out vs ${symlinksIn} in`);

const mainExe = byName.get(MAIN_EXE_OUT);
expect(Boolean(mainExe), `missing ${MAIN_EXE_OUT}`);
expect(mainExe ? (modeOf(mainExe.externalAttrs) & 0o111) !== 0 : false, "main executable is not marked executable");

expect(byName.has(`${APP_DIR}/Contents/Info.plist`), "missing Info.plist");
expect(byName.has(`${APP_DIR}/Contents/Resources/electron.icns`), "missing icon");
expect(byName.has(`${APP_DIR}/Contents/Resources/app.asar`), "missing app.asar");
expect(byName.has(`${APP_DIR}/Contents/Resources/app/index.html`), "missing resources/app/index.html");
expect(
  byName.has(`${unpackedPrefix}/${bindingName}/duckdb.node`),
  `missing ${bindingName}/duckdb.node`,
);
expect(!byName.has(`${APP_DIR}/Contents/Resources/default_app.asar`), "Electron's default app is still bundled");
expect(
  [...byName.keys()].every((n) => n.startsWith(`${APP_DIR}/`)),
  "some entries are outside the .app",
);

// Every helper app needs its executable bit or the renderer processes cannot spawn.
const helpers = [...byName.values()].filter((e) => /Helper[^/]*\.app\/Contents\/MacOS\/[^/]+$/.test(e.name));
expect(helpers.length >= 3, `expected the Electron helper apps, found ${helpers.length}`);
expect(
  helpers.every((h) => (modeOf(h.externalAttrs) & 0o111) !== 0),
  "a helper executable lost its executable bit",
);

console.log(`\n[mac] ${check.length} entries, ${symlinksOut} symlinks, ${helpers.length} helper executables`);

if (problems.length > 0) {
  console.error("\n[mac] PROBLEMS:");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log("[mac] Structure checks passed.");
console.log("[mac] UNVERIFIED: assembled on Windows, never launched on a Mac.");
console.log('[mac] Unsigned — first run needs right-click > Open, or `xattr -cr "Query Studio.app"`.');
