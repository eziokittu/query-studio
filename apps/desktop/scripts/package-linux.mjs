// Package release/linux-unpacked as a .tar.gz, from Windows.
//
// Why this exists instead of `electron-builder --linux AppImage`:
//
// The AppImage target builds fine right up to the last step, where it creates a
// symlink for the icon inside the AppDir. Creating a symlink on Windows needs
// SeCreateSymbolicLinkPrivilege — Developer Mode, or an elevated shell — and
// without it the build dies with `EPERM: operation not permitted, symlink`. deb and
// rpm are worse: they are built with fpm, which electron-builder only ships for
// Linux and macOS hosts.
//
// The `dir` target has no such problem: it produces a complete, correct
// release/linux-unpacked. All that is missing is an archive of it, and a tar.gz that
// someone extracts and runs is a perfectly ordinary way to ship a Linux app.
//
// The catch is permissions. NTFS has no executable bit, so anything Windows writes
// into a tar comes out mode 0644 — the extracted `query-studio` would not run, and
// `chrome-sandbox` silently disables the sandbox. Rather than hope the host's tar
// guesses right, the archive is written here with each entry's mode set explicitly.
//
// Usage: node scripts/package-linux.mjs [x64|arm64]
import { createGzip } from "node:zlib";
import { createWriteStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix, relative, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, "..");

const arch = process.argv[2] ?? "x64";
const version = JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8")).version;

// electron-builder names the default arch's output `linux-unpacked` and every
// other arch `linux-<arch>-unpacked`.
const source = join(appRoot, "release", arch === "x64" ? "linux-unpacked" : `linux-${arch}-unpacked`);
const rootName = `QueryStudio-${version}-${arch}`;
const outFile = join(appRoot, "release", `${rootName}.tar.gz`);

if (!existsSync(source)) {
  console.error(`[linux] No build at ${source}.`);
  console.error(`[linux] Run: node scripts/build-installer.mjs --linux dir --${arch}`);
  process.exit(1);
}

/**
 * Which files have to come out executable.
 *
 * `query-studio` is the app. `chrome-sandbox` is Chromium's setuid sandbox helper —
 * if it is not executable Electron falls back to running with the sandbox disabled,
 * which is a security regression that produces no error message.
 * `chrome_crashpad_handler` is spawned as a process. Shared objects are marked
 * executable because that is the convention and some loaders check it.
 */
function modeFor(relPath) {
  const base = posix.basename(relPath);

  if (base === "query-studio" || base === "chrome-sandbox" || base === "chrome_crashpad_handler") {
    return 0o755;
  }
  if (/\.(so|so\.\d+(\.\d+)*|node|dylib)$/.test(base)) return 0o755;
  // The DuckDB shared library is versioned as libduckdb.so.1.4.
  if (/\.so(\.\d+)*$/.test(base)) return 0o755;

  return 0o644;
}

// ── a minimal ustar writer ───────────────────────────────────────────────────
//
// Only what is needed here: regular files and directories, no symlinks (the build
// contains none — checked), and paths short enough for the 100-byte name field with
// the 155-byte prefix as backup.

const BLOCK = 512;

function octal(value, width) {
  return value.toString(8).padStart(width - 1, "0") + "\0";
}

function header({ name, size, mode, type, mtime }) {
  const buf = Buffer.alloc(BLOCK);

  let namePart = name;
  let prefix = "";
  if (Buffer.byteLength(name) > 100) {
    // ustar splits a long path at a directory boundary: prefix + "/" + name.
    // The split has to leave at most 100 bytes after it, so look for the first
    // separator at or beyond that point — searching from the other end finds a
    // slash that is too early and reports a perfectly packable path as too long.
    const cut = name.indexOf("/", Buffer.byteLength(name) - 101);
    if (cut === -1 || Buffer.byteLength(name.slice(cut + 1)) > 100) {
      throw new Error(`Path too long for ustar: ${name}`);
    }
    prefix = name.slice(0, cut);
    namePart = name.slice(cut + 1);
    if (Buffer.byteLength(prefix) > 155) throw new Error(`Prefix too long for ustar: ${name}`);
  }

  buf.write(namePart, 0, 100, "utf8");
  buf.write(octal(mode, 8), 100, 8, "ascii");
  buf.write(octal(0, 8), 108, 8, "ascii"); // uid: root
  buf.write(octal(0, 8), 116, 8, "ascii"); // gid: root
  buf.write(octal(size, 12), 124, 12, "ascii");
  buf.write(octal(Math.floor(mtime / 1000), 12), 136, 12, "ascii");
  buf.write("        ", 148, 8, "ascii"); // checksum placeholder: spaces
  buf.write(type, 156, 1, "ascii");
  buf.write("ustar\0", 257, 6, "ascii");
  buf.write("00", 263, 2, "ascii");
  buf.write("root", 265, 32, "utf8");
  buf.write("root", 297, 32, "utf8");
  if (prefix) buf.write(prefix, 345, 155, "utf8");

  let sum = 0;
  for (const byte of buf) sum += byte;
  buf.write(octal(sum, 8), 148, 8, "ascii");

  return buf;
}

function padding(size) {
  const remainder = size % BLOCK;
  return remainder === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - remainder);
}

/** Walk the build, yielding tar blocks. Streams file contents rather than buffering. */
function* entries() {
  let files = 0;
  let bytes = 0;

  const walk = function* (dir) {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const stats = statSync(full);
      // Archive paths are always posix, and are rooted at a single directory so an
      // extraction cannot scatter files across the user's cwd.
      const rel = `${rootName}/${relative(source, full).split(sep).join("/")}`;

      if (stats.isDirectory()) {
        yield header({ name: `${rel}/`, size: 0, mode: 0o755, type: "5", mtime: stats.mtimeMs });
        yield* walk(full);
        continue;
      }

      if (!stats.isFile()) continue;

      const mode = modeFor(rel);
      yield header({ name: rel, size: stats.size, mode, type: "0", mtime: stats.mtimeMs });
      yield readFileSync(full);
      yield padding(stats.size);

      files++;
      bytes += stats.size;
    }
  };

  const now = Date.now();
  yield header({ name: `${rootName}/`, size: 0, mode: 0o755, type: "5", mtime: now });
  yield* walk(source);

  // Two zero blocks end the archive.
  yield Buffer.alloc(BLOCK * 2);

  console.log(`[linux] ${files} files, ${(bytes / 1024 / 1024).toFixed(1)} MB uncompressed`);
}

console.log(`[linux] Packaging ${source}`);
console.log(`[linux] Root directory inside the archive: ${rootName}/`);

await pipeline(Readable.from(entries()), createGzip({ level: 9 }), createWriteStream(outFile));

console.log(`[linux] ${outFile}`);
console.log(`[linux] ${(statSync(outFile).size / 1024 / 1024).toFixed(1)} MB`);
console.log(`[linux] Run with: tar -xzf ${rootName}.tar.gz && ./${rootName}/query-studio`);
