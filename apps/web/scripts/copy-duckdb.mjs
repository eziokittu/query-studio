// Copy DuckDB-WASM's runtime assets into public/duckdb.
//
// The desktop and mobile builds load from file:// with no network, and glitchbong
// serves under a CSP that forbids third-party script hosts. Both of those rule out
// DuckDB's default jsDelivr bundles, so the assets have to ship with the app.
//
// Only the EH (exception-handling) build is copied. Every browser and WebView the
// app supports has had WASM exception handling for years, and shipping the MVP
// fallback as well would add ~35 MB to an installer for a case that cannot occur.
import { cpSync, mkdirSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const from = join(root, "node_modules", "@duckdb", "duckdb-wasm", "dist");
const to = join(here, "..", "public", "duckdb");

const ASSETS = ["duckdb-eh.wasm", "duckdb-browser-eh.worker.js"];

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
