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

const platform = targetPlatform();
// electron-builder is told the arch by the targets in package.json; every one of
// them is x64 or arm64, and only x64 is buildable for Windows (see below).
const arch = platform === "win32" ? "x64" : process.arch;
const binding = bindingPackageFor(platform, arch);

const staged = join(appRoot, "node_modules", "@duckdb");
const sources = ["@duckdb/node-api", "@duckdb/node-bindings", binding];

console.log(`[dist] Electron ${electronVersion}`);
console.log(`[dist] Staging the native addon for ${platform}-${arch}`);

rmSync(staged, { recursive: true, force: true });
mkdirSync(staged, { recursive: true });

for (const name of sources) {
  const from = join(repoRoot, "node_modules", ...name.split("/"));
  if (!existsSync(from)) {
    console.error(`[dist] ${name} is not installed.`);
    if (name === binding) {
      console.error(
        `[dist] DuckDB ships prebuilt bindings only, so a ${platform}-${arch} app has to be`,
      );
      console.error(`[dist] built on a ${platform} machine — or install ${name} explicitly first.`);
    } else {
      console.error("[dist] Run `npm install` at the repo root.");
    }
    process.exit(1);
  }
  cpSync(from, join(staged, name.split("/")[1]), { recursive: true, dereference: true });
}

// ── build ────────────────────────────────────────────────────────────────────

const flags = [
  ...args,
  `--config.electronVersion=${electronVersion}`,
  `--config.electronDist=${electronDist}`,
  // See note 2 above. Without this, electron-builder deletes its own binary.
  "--config.npmRebuild=false",
];

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
