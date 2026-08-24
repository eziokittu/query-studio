// Drive the *packaged* app, not the source tree.
//
// smoke.mjs launches `dist/main.cjs` through the electron module, which is the
// development layout. That path never touches the two things packaging changes:
//
//   * `rendererEntry()` resolves the UI from `process.resourcesPath/app`, which only
//     exists inside an installed app. Its fallback to the repo is what smoke.mjs
//     actually exercises, so a broken packaged path would pass every existing test
//     and still ship a blank window.
//   * the native DuckDB addon is loaded out of `app.asar.unpacked`. A native module
//     left inside the asar cannot be `require`d at all, so an `asarUnpack` glob that
//     misses is a silent packaging failure that surfaces on the user's first query.
//
// Run `npm run dist:win` (or dist:mac / dist:linux) first, then this.
//
// Needs Playwright: npm i -D playwright --no-save
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, "..");
const repoRoot = join(appRoot, "..", "..");
const fixtures = join(repoRoot, "test", ".fixtures");

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
}

// electron-builder names the unpacked directory per platform.
const unpacked = {
  win32: join(appRoot, "release", "win-unpacked", "Query Studio.exe"),
  linux: join(appRoot, "release", "linux-unpacked", "query-studio"),
  darwin: join(appRoot, "release", "mac", "Query Studio.app", "Contents", "MacOS", "Query Studio"),
}[process.platform];

if (!unpacked || !existsSync(unpacked)) {
  console.error(`No packaged app at ${unpacked ?? process.platform}.`);
  console.error("Run `npm run dist:win` (or dist:mac / dist:linux) in apps/desktop first.");
  process.exit(1);
}

let _electron;
try {
  ({ _electron } = await import("playwright"));
} catch {
  console.error("Playwright is not installed. Run: npm i -D playwright --no-save");
  process.exit(1);
}

mkdirSync(fixtures, { recursive: true });

const csvPath = join(fixtures, "packaged-smoke.csv");
writeFileSync(
  csvPath,
  ["id,name,price", '1,"Ward, Alice",10.00', "2,O'Brien,0.05", "3,Third,1234.56"].join("\n"),
  "utf8",
);

console.log(`\n== ${unpacked} ==`);

// See smoke.mjs — an inherited ELECTRON_RUN_AS_NODE turns this into a plain Node
// process that dies on ipcMain.
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const app = await _electron.launch({ executablePath: unpacked, env });

const mainErrors = [];
app.process().stderr?.on("data", (b) => mainErrors.push(String(b)));

const page = await app.firstWindow();
await page.waitForLoadState("domcontentloaded");

const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") pageErrors.push(m.text());
});

const offOrigin = [];
page.on("request", (r) => {
  const url = r.url();
  if (url.startsWith("http://") || url.startsWith("https://")) offOrigin.push(url);
});

check("the packaged window opened", () => assert.ok(page));

// The assertion the unpackaged test cannot make: the UI came from resources/app,
// not from the repo working tree next door.
const loadedFrom = page.url();
check("the UI loaded from the packaged resources", () => {
  assert.match(loadedFrom, /^file:/);
  assert.ok(
    !loadedFrom.includes("/apps/web/dist/"),
    `fell back to the repo instead of resources/app: ${loadedFrom}`,
  );
});

const title = await page.title();
check("the window is titled", () => assert.equal(title, "Query Studio"));

// The native addon, loaded out of app.asar.unpacked.
const version = await page.evaluate(() => window.queryStudioNative.version());
check(`the unpacked native addon loads (DuckDB ${version})`, () => {
  assert.match(String(version), /^v?\d+\.\d+/);
});

await page.waitForSelector(".runtime", { timeout: 60_000 });
const runtimeClass = await page.evaluate(() => document.querySelector(".runtime")?.className ?? "");
check("the packaged app uses the native backend", () => assert.match(runtimeClass, /runtime-native/));

const registered = await page.evaluate(
  (path) => window.queryStudioNative.register(path, "packaged"),
  csvPath,
);
check("a real file registers", () => assert.equal(registered.columns.length, 3));

const result = await page.evaluate(() =>
  window.queryStudioNative.query("SELECT name, price::DECIMAL(9,2) AS p FROM packaged ORDER BY id", null),
);
check("a quoted comma stays one field", () => assert.equal(result.rows[0][0], "Ward, Alice"));
check("a DECIMAL keeps its point", () => assert.equal(result.rows[0][1], "10.00"));

// The DuckDB WASM assets ship as well, even though the desktop build uses the native
// engine — they are the fallback if the addon ever fails to load, and they are also
// what makes the app work with no network at all.
const wasmPresent = await page.evaluate(async () => {
  const response = await fetch("./duckdb/duckdb-eh.wasm", { method: "HEAD" }).catch(() => null);
  return Boolean(response && (response.ok || response.status === 0));
});
check("the WASM fallback assets shipped too", () => assert.equal(wasmPresent, true));

check("the packaged app made no http(s) request", () => {
  assert.deepEqual(offOrigin, [], offOrigin.join(", "));
});
check("no uncaught renderer error", () => assert.deepEqual(pageErrors, [], pageErrors.join(" | ")));

const fatal = mainErrors
  .join("")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => /Error|Failed/.test(line));
check("the main process logged no error", () => assert.deepEqual(fatal, [], fatal.join(" | ")));

await page.screenshot({ path: join(fixtures, "desktop-packaged.png") });
console.log(`\nscreenshot: ${join(fixtures, "desktop-packaged.png")}`);

await app.close();

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
