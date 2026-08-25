// Run electron-builder, in an npm workspace it cannot navigate on its own.
//
// Three separate things go wrong with the plain `electron-builder` invocation here,
// and all three come from the same root cause: `apps/desktop/node_modules` does not
// exist, because npm hoists every dependency to the repo root.
//
// 1. It cannot work out which Electron to package.
//
//      Cannot compute electron version from installed node modules - none of the
//      possible electron modules are installed and version ("^34.0.0") is not fixed
//
//    The usual advice is to pin an exact version in devDependencies or hard-code
//    `electronVersion` in the build config. Both make the packaged runtime a second
//    place the version is written down, and the two drift the first time someone
//    upgrades Electron and changes only one. So it is read from the module that is
//    actually installed and passed on the command line.
//
// 2. It tries to fix the missing node_modules by running `npm install --production`
//    in apps/desktop. In a workspace that resolves to the *root* tree and prunes
//    every devDependency from it — including electron-builder's own helper binary,
//    which it then tries to spawn:
//
//      spawn …/node_modules/app-builder-bin/win/x64/app-builder.exe ENOENT
//
//    It deletes the tool it is in the middle of using. `npmRebuild=false` stops it.
//
// 3. With that install skipped, the native DuckDB addon would not be packaged at
//    all, because `files` looks for `node_modules/@duckdb/**` under apps/desktop.
//    So the three packages that make up the addon are staged there first, from the
//    hoisted copies at the root.
//
// Usage: node scripts/build-installer.mjs [--win|--mac|--linux] [extra args…]
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { BINDINGS_DIR, fetchBinding } from "./fetch-bindings.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, "..");
const repoRoot = join(appRoot, "..", "..");
const require = createRequire(import.meta.url);

const args = process.argv.slice(2);

// ── which Electron ───────────────────────────────────────────────────────────

let electronVersion;
let electronDist;
try {
  electronVersion = require("electron/package.json").version;
  electronDist = join(dirname(require.resolve("electron/package.json")), "dist");
} catch {
  console.error("[dist] electron is not installed. Run `npm install` at the repo root.");
  process.exit(1);
}

// ── stage the native DuckDB addon ────────────────────────────────────────────

/**
 * Which prebuilt binding package this build needs.
 *
 * DuckDB publishes one package per platform+arch and there is no source fallback,
 * so a build can only produce a working app for a platform whose binding is
 * installed here. That makes cross-building a real limitation rather than a slow
 * path, and it is better to say so before spending twenty minutes on an installer
 * that crashes on its first query.
 */
function bindingPackageFor(platform, arch) {
  return `@duckdb/node-bindings-${platform}-${arch}`;
}

function targetPlatform() {
  if (args.includes("--win")) return "win32";
  if (args.includes("--mac")) return "darwin";
  if (args.includes("--linux")) return "linux";
  return process.platform;
}

/**
 * Which arch this build is for.
 *
 * electron-builder packages one arch at a time when told to, and it has to be told
 * to here: the native addon staged below is platform+arch specific, so a single
 * staging cannot serve an arm64 and an x64 build at once. Passing `--arm64` or
 * `--x64` on the command line picks both the binding and electron-builder's target.
 */
function targetArch(platform) {
  if (args.includes("--arm64")) return "arm64";
  if (args.includes("--x64")) return "x64";
  // Windows is x64-only because DuckDB ships no win32-arm64 binding.
  if (platform === "win32") return "x64";
  return process.arch;
}

const platform = targetPlatform();
const arch = targetArch(platform);
const binding = bindingPackageFor(platform, arch);

const staged = join(appRoot, "node_modules", "@duckdb");

console.log(`[dist] Electron ${electronVersion}`);
console.log(`[dist] Staging the native addon for ${platform}-${arch}`);

rmSync(staged, { recursive: true, force: true });
mkdirSync(staged, { recursive: true });

// The two platform-independent packages always come from the root install.
for (const name of ["@duckdb/node-api", "@duckdb/node-bindings"]) {
  const from = join(repoRoot, "node_modules", ...name.split("/"));
  if (!existsSync(from)) {
    console.error(`[dist] ${name} is not installed. Run \`npm install\` at the repo root.`);
    process.exit(1);
  }
  cpSync(from, join(staged, name.split("/")[1]), { recursive: true, dereference: true });
}

// The prebuilt binding is platform+arch specific. For the host platform npm has
// already installed it; for any other it is downloaded into .bindings/ by
// fetch-bindings.mjs, because npm refuses to install a package whose os/cpu does
// not match the host and the --force workaround corrupts the rest of the tree.
const bindingDirName = binding.split("/")[1];
const hostCopy = join(repoRoot, "node_modules", ...binding.split("/"));
const target = join(staged, bindingDirName);

if (existsSync(hostCopy)) {
  cpSync(hostCopy, target, { recursive: true, dereference: true });
} else {
  const cached = join(BINDINGS_DIR, `${platform}-${arch}`);
  if (!existsSync(cached)) {
    console.log(`[dist] ${binding} is not cached — fetching it.`);
    try {
      fetchBinding(`${platform}-${arch}`);
    } catch (error) {
      console.error(`[dist] Could not fetch ${binding}: ${error.message}`);
      console.error("[dist] DuckDB ships prebuilt bindings only; there is no source fallback.");
      process.exit(1);
    }
  }
  // The unpacked tarball already carries the published package.json, with the
  // right name, version and os/cpu fields. Nothing needs rewriting: the addon is
  // loaded as `require("@duckdb/node-bindings-<target>/duckdb.node")`, an explicit
  // file path, so the package's `main` never comes into it.
  cpSync(cached, target, { recursive: true, dereference: true });
}

if (!existsSync(join(target, "duckdb.node"))) {
  console.error(`[dist] ${binding} staged without a duckdb.node.`);
  process.exit(1);
}

// ── build ────────────────────────────────────────────────────────────────────

// `electronDist` points at the *host's* unpacked Electron. Handing that to a
// cross-platform build would package Windows binaries inside a Linux AppImage, so it
// is passed only when the target is the machine we are on. For any other target,
// `electronVersion` alone is enough — electron-builder downloads the right dist.
const crossBuilding = platform !== process.platform;

// electron-builder walks the *workspace root* for production dependencies, so it
// finds every @duckdb/node-bindings-<platform> package npm installed there and packs
// all of them. A Linux build was shipping the 34 MB Windows binding it can never
// load. `files` is therefore rebuilt here with the staged binding included by name
// and every other one excluded — it has to be dynamic, because which one is right
// changes per build.
const ALL_BINDINGS = [
  "node-bindings-win32-x64",
  "node-bindings-darwin-arm64",
  "node-bindings-darwin-x64",
  "node-bindings-linux-x64",
  "node-bindings-linux-arm64",
];

const fileRules = [
  "dist/**/*",
  "!node_modules/**/*",
  "node_modules/@duckdb/**/*",
  ...ALL_BINDINGS.filter((b) => b !== bindingDirName).map((b) => `!node_modules/@duckdb/${b}/**`),
];

const flags = [
  ...args,
  ...fileRules.map((rule) => `--config.files=${rule}`),
  `--config.electronVersion=${electronVersion}`,
  ...(crossBuilding ? [] : [`--config.electronDist=${electronDist}`]),
  // See note 2 above. Without this, electron-builder deletes its own binary.
  "--config.npmRebuild=false",
];

if (crossBuilding) {
  console.log(`[dist] Cross-building for ${platform} from ${process.platform} — downloading its Electron.`);
}

console.log(`[dist] electron-builder ${flags.join(" ")}`);

// electron-builder is a .cmd shim on Windows, which Node refuses to execFile
// without a shell since the CVE-2024-27980 fix.
const windows = process.platform === "win32";
const builder = join(repoRoot, "node_modules", ".bin", windows ? "electron-builder.cmd" : "electron-builder");

const result = spawnSync(builder, windows ? flags.map((a) => `"${a}"`) : flags, {
  cwd: appRoot,
  stdio: "inherit",
  shell: windows,
});

process.exit(result.status ?? 1);
