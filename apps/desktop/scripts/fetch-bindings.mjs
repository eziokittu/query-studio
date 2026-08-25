// Download DuckDB's prebuilt native bindings for platforms other than this one.
//
// Cross-building a Mac or Linux app from Windows needs that platform's
// `@duckdb/node-bindings-<platform>-<arch>` package, and npm refuses to install one
// whose `os`/`cpu` fields do not match the host:
//
//     npm error notsup Valid cpu: x64 / Actual cpu: x64
//
// The obvious workaround, `npm install --os=linux --cpu=x64 --force`, does install
// it — and also rewrites the rest of the tree for that platform. It replaced
// esbuild's Windows binary with a Linux one and broke the build outright. Never do
// that in a tree you still need.
//
// `npm pack` has no such check: it only downloads the tarball. So each binding is
// fetched and unpacked into its own directory under .bindings/, touching nothing
// else, and scripts/build-installer.mjs stages the right one per build.
//
// Usage:
//   node scripts/fetch-bindings.mjs                     every platform
//   node scripts/fetch-bindings.mjs darwin-arm64 linux-x64
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, "..");
const repoRoot = join(appRoot, "..", "..");

export const BINDINGS_DIR = join(appRoot, ".bindings");

/**
 * Pinned to the exact version @duckdb/node-api depends on.
 *
 * A binding that does not match the API package is an ABI mismatch, which shows up
 * as a native crash on first query rather than anything a build would catch. Read
 * from the installed package so it cannot drift.
 */
function bindingVersion() {
  const pkg = join(repoRoot, "node_modules", "@duckdb", "node-api", "package.json");
  if (!existsSync(pkg)) {
    console.error("[bindings] @duckdb/node-api is not installed. Run `npm install` at the repo root.");
    process.exit(1);
  }
  const deps = JSON.parse(execFileSync(process.execPath, ["-p", `JSON.stringify(require(${JSON.stringify(pkg)}).dependencies)`], {
    encoding: "utf8",
  }));
  const version = deps["@duckdb/node-bindings"];
  if (!version) {
    console.error("[bindings] @duckdb/node-api no longer depends on @duckdb/node-bindings.");
    process.exit(1);
  }
  return version.replace(/^[\^~]/, "");
}

// Every platform+arch DuckDB publishes. There is deliberately no win32-arm64 —
// DuckDB does not ship one, which is why the Windows build is x64 only.
export const TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"];

const SEPARATOR = String.fromCharCode(92);
const windows = process.platform === "win32";
const npm = windows ? "npm.cmd" : "npm";

/** Fetch one binding into .bindings/<target>/, unless it is already there. */
export function fetchBinding(target, version = bindingVersion()) {
  const name = `@duckdb/node-bindings-${target}`;
  const into = join(BINDINGS_DIR, target);
  const marker = join(into, "duckdb.node");

  if (existsSync(marker) && statSync(marker).size > 0) {
    console.log(`[bindings] ${target.padEnd(14)} already present`);
    return into;
  }

  mkdirSync(BINDINGS_DIR, { recursive: true });
  const staging = mkdtempSync(join(tmpdir(), "qs-binding-"));

  try {
    // `npm pack` downloads the tarball and applies no os/cpu check.
    //
    // Both commands get forward-slash paths. bsdtar — which is what `tar` is on
    // Windows — treats a backslash path inconsistently, and the failure is a bare
    // exit code 2 with nothing on stderr, so it is worth not finding out again.
    const posix = (p) => p.split(SEPARATOR).join("/");

    execFileSync(
      npm,
      ["pack", `${name}@${version}`, "--pack-destination", posix(staging), "--silent"],
      { stdio: ["ignore", "ignore", "inherit"], shell: windows },
    );

    const tarball = readdirSync(staging).find((f) => f.endsWith(".tgz"));
    if (!tarball) throw new Error(`npm pack produced nothing for ${name}@${version}`);

    // The tarball is moved next to its destination and extracted with `cwd` set
    // there, so no argument tar sees contains a colon.
    //
    // `tar` on this PATH is GNU tar from Git Bash, not Windows' bsdtar, and GNU tar
    // reads `C:/x` as the rsh syntax host:path — "Cannot connect to C: resolve
    // failed". `--force-local` would fix it for GNU tar and be an unknown flag to
    // bsdtar, so sidestepping the colon works with either.
    mkdirSync(into, { recursive: true });
    const local = join(into, tarball);
    renameSync(join(staging, tarball), local);

    try {
      execFileSync("tar", ["-xzf", tarball, "--strip-components=1"], { cwd: into, stdio: "inherit" });
    } finally {
      rmSync(local, { force: true });
    }

    if (!existsSync(marker)) {
      throw new Error(`${name} unpacked without a duckdb.node — the package layout changed`);
    }

    console.log(`[bindings] ${target.padEnd(14)} fetched (${(statSync(marker).size / 1024 / 1024).toFixed(1)} MB)`);
    return into;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

// Run directly rather than imported.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const version = bindingVersion();
  const wanted = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const targets = wanted.length > 0 ? wanted : TARGETS;

  console.log(`[bindings] @duckdb/node-bindings@${version}`);
  for (const target of targets) {
    if (!TARGETS.includes(target) && target !== "win32-x64") {
      console.error(`[bindings] Unknown target ${target}. Known: ${TARGETS.join(", ")}`);
      process.exit(1);
    }
    fetchBinding(target, version);
  }
}
