// Copy DuckDB-WASM's runtime assets into public/duckdb.
//
// The desktop and mobile builds load from file:// with no network, and glitchbong
// serves under a CSP that forbids third-party script hosts. Both of those rule out
// DuckDB's default jsDelivr bundles, so the assets have to ship with the app.
//
// Only the EH (exception-handling) build is copied. Every browser and WebView the
// app supports has had WASM exception handling for years, and shipping the MVP
// fallback as well would add ~35 MB to an installer for a case that cannot occur.
import { cpSync, mkdirSync, existsSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const from = join(root, "node_modules", "@duckdb", "duckdb-wasm", "dist");
const to = join(here, "..", "public", "duckdb");

const ASSETS = ["duckdb-eh.wasm", "duckdb-browser-eh.worker.js"];

// DuckDB ships a small core and pulls the rest in on demand. `read_json` needs the
// `json` extension, and the default behaviour is to fetch it from
// extensions.duckdb.org *the first time someone opens a JSON file* — which would
// mean the desktop and mobile builds silently need a network connection, and that
// glitchbong's CSP would block JSON support outright. Neither failure shows up until
// a user drops a .json file, so the extension ships with the app like everything else.
//
// The version is DuckDB's own (`SELECT version()`), not the duckdb-wasm package
// version, and the platform matches the EH build copied above. Both are pinned
// rather than detected: getting them wrong is a hard 404 at build time, which is
// exactly when we want to hear about it.
const DUCKDB_VERSION = "v1.4.3";
const DUCKDB_PLATFORM = "wasm_eh";
const EXTENSIONS = ["json"];
const EXTENSION_CDN = "https://extensions.duckdb.org";

if (!existsSync(from)) {
  console.error(`[duckdb] Not found at ${from} — run npm install first.`);
  process.exit(1);
}

mkdirSync(to, { recursive: true });

let total = 0;
for (const asset of ASSETS) {
  const source = join(from, asset);
  if (!existsSync(source)) {
    console.error(`[duckdb] Missing ${asset} in ${from}`);
    process.exit(1);
  }
  cpSync(source, join(to, asset));
  total += statSync(source).size;
}

console.log(`[duckdb] Copied ${ASSETS.length} assets (${(total / 1024 / 1024).toFixed(1)} MB) into public/duckdb`);

// ── extensions ───────────────────────────────────────────────────────────────
//
// Laid out exactly as DuckDB expects to find them, so the runtime only has to be
// told the repository root: {repo}/{version}/{platform}/{name}.duckdb_extension.wasm
const extensionDir = join(to, "extensions", DUCKDB_VERSION, DUCKDB_PLATFORM);
mkdirSync(extensionDir, { recursive: true });

let fetched = 0;
let cached = 0;

for (const name of EXTENSIONS) {
  const file = `${name}.duckdb_extension.wasm`;
  const target = join(extensionDir, file);

  // Already downloaded: every build after the first is offline.
  if (existsSync(target) && statSync(target).size > 0) {
    cached++;
    continue;
  }

  const url = `${EXTENSION_CDN}/${DUCKDB_VERSION}/${DUCKDB_PLATFORM}/${file}`;
  const response = await fetch(url);

  if (!response.ok) {
    console.error(`[duckdb] Could not fetch the ${name} extension: ${response.status} ${url}`);
    console.error(
      `[duckdb] This usually means @duckdb/duckdb-wasm was upgraded and DUCKDB_VERSION`,
    );
    console.error(
      `[duckdb] in this script is stale. Run \`SELECT version()\` in the app and update it.`,
    );
    process.exit(1);
  }

  writeFileSync(target, Buffer.from(await response.arrayBuffer()));
  fetched++;
}

// A manifest so the app can report which extensions it actually shipped with,
// rather than discovering a gap when a user drops a file.
writeFileSync(
  join(to, "extensions", "manifest.json"),
  JSON.stringify({ version: DUCKDB_VERSION, platform: DUCKDB_PLATFORM, extensions: EXTENSIONS }, null, 2),
);

console.log(
  `[duckdb] Extensions ${DUCKDB_VERSION}/${DUCKDB_PLATFORM}: ${fetched} downloaded, ${cached} already present (${EXTENSIONS.join(", ")})`,
);
