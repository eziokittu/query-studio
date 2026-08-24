// Boot the real Electron app and drive it.
//
// Everything below the IPC boundary is covered by native-values.test.mjs, which
// talks to DuckDB directly. This covers the part that test cannot: that the main
// process starts at all, that the preload actually exposes the bridge under the
// name the renderer looks for, that `createEngine()` picks the native backend
// inside the shell rather than silently falling back to WASM, and that a real file
// registers and queries end to end through IPC.
//
// The renderer is the production `apps/web/dist` build, loaded from disk exactly
// as a packaged app loads it — so this also exercises `rendererEntry()`.
//
// Needs Playwright, installed dev-only and deliberately not saved:
//
//   npm i -D playwright --no-save
//
// It drives Electron directly, so no browser download is involved.
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

if (!existsSync(join(repoRoot, "apps", "web", "dist", "index.html"))) {
  console.error("The web build is missing. Run `npm run build` at the repo root first.");
  process.exit(1);
}

let _electron;
try {
  ({ _electron } = await import("playwright"));
} catch {
  console.error("Playwright is not installed. Run: npm i -D playwright --no-save");
  process.exit(1);
}

// ── fixtures ─────────────────────────────────────────────────────────────────

mkdirSync(fixtures, { recursive: true });

// Deliberately awkward: a quoted comma, an apostrophe, a decimal that a float would
// round, an integer past 2^53, and a null. These are the values that broke the
// browser build, so the desktop build gets asked the same questions.
const csvPath = join(fixtures, "desktop-smoke.csv");
const rows = [
  "id,name,price,big,note",
  '1,"Ward, Alice",10.00,9007199254740993,hello',
  "2,O'Brien,0.05,9007199254740994,",
  '3,"Bag ""of"" holding",1234.56,9007199254740995,world',
];
for (let i = 4; i <= 500; i++) rows.push(`${i},row${i},${(i / 100).toFixed(2)},${9007199254740990 + i},n${i}`);
writeFileSync(csvPath, rows.join("\n"), "utf8");

// ── boot ─────────────────────────────────────────────────────────────────────

console.log("\n== boot ==");

// ELECTRON_RUN_AS_NODE turns the electron binary into a plain Node interpreter, so
// `require("electron")` returns the path to the executable instead of the API and
// the main process dies on `ipcMain.handle` — "Cannot read properties of undefined".
// Some sandboxes and CI images export it globally, and inheriting it here looks
// exactly like a bug in main.ts. Clearing it costs nothing when it was never set.
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const app = await _electron.launch({
  args: [join(appRoot, "dist", "main.cjs")],
  cwd: appRoot,
  env,
});

const mainErrors = [];
app.process().stderr?.on("data", (buffer) => mainErrors.push(String(buffer)));

const page = await app.firstWindow();
await page.waitForLoadState("domcontentloaded");

const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") pageErrors.push(message.text());
});

check("a window opened", () => assert.ok(page));

const title = await page.title();
check(`window title is set (${JSON.stringify(title)})`, () => assert.ok(title.length > 0));

// The whole point of the desktop build: no http(s) request, ever. A packaged app
// that phones home would contradict the pitch on the download page.
const offOrigin = [];
page.on("request", (request) => {
  const url = request.url();
  if (url.startsWith("http://") || url.startsWith("https://")) offOrigin.push(url);
});

// ── the bridge ───────────────────────────────────────────────────────────────

console.log("\n== preload bridge ==");

const globals = await page.evaluate(() => ({
  native: window.queryStudioNative ? Object.keys(window.queryStudioNative).sort() : null,
  desktop: window.queryStudioDesktop ? Object.keys(window.queryStudioDesktop).sort() : null,
  platform: window.queryStudioDesktop?.platform ?? null,
}));

check("window.queryStudioNative exists", () => {
  assert.ok(globals.native, "the preload did not expose it");
});
check("window.queryStudioDesktop exists", () => {
  assert.ok(globals.desktop, "the preload did not expose it");
});

// The NativeBridge contract from @query-studio/core. The core package declares it
// structurally rather than importing anything from Electron, so preload.ts is the
// one place the two halves have to agree — and a rename on either side surfaces as
// "is not a function" deep inside a query rather than at boot.
for (const method of ["version", "register", "unregister", "query", "streamStart", "streamCancel", "onBatch"]) {
  check(`queryStudioNative exposes ${method}()`, () => {
    assert.ok(globals.native?.includes(method), `missing — got ${globals.native?.join(", ")}`);
  });
}

// The desktop-only extras are a second global, so the shared UI can feature-detect
// them without the two contracts bleeding into each other.
for (const method of ["openFiles", "saveDialog", "exportTo", "onOpenPaths", "onMenu"]) {
  check(`queryStudioDesktop exposes ${method}()`, () => {
    assert.ok(globals.desktop?.includes(method), `missing — got ${globals.desktop?.join(", ")}`);
  });
}

check(`platform is reported (${globals.platform})`, () => {
  assert.ok(["win32", "darwin", "linux"].includes(globals.platform));
});

// ── DuckDB through IPC ───────────────────────────────────────────────────────

console.log("\n== native DuckDB ==");

// This is the call that used to throw: getConnection() built the instance with
// `max_memory: "80%"`, DuckDB rejected the config, and every query after it failed.
const version = await page.evaluate(() => window.queryStudioNative.version());
check(`DuckDB answers version() (${version})`, () => {
  assert.match(String(version), /^v?\d+\.\d+/);
});

// Asserted through the UI rather than by importing the core package in here: the
// renderer is loaded from file:// with no import map, so a bare specifier would fail
// for reasons that have nothing to do with what is being tested. The badge in the
// header is rendered straight from `describeRuntime()`, so it is the same answer.
await page.waitForSelector(".runtime", { timeout: 60_000 });

const runtime = await page.evaluate(() => {
  const badge = document.querySelector(".runtime");
  return {
    className: badge?.className ?? "",
    label: badge?.textContent?.trim() ?? "",
    limit: badge?.getAttribute("title") ?? "",
  };
});

check(`createEngine() picks the native backend in the shell (${runtime.label})`, () => {
  assert.match(runtime.className, /runtime-native/, "fell back to WASM — the bridge was not detected");
});
check("the native runtime advertises no size limit", () => {
  assert.match(runtime.limit, /No file size limit/);
});

console.log("\n== register and query a real file ==");

const registered = await page.evaluate(async (path) => {
  return window.queryStudioNative.register(path, "smoke");
}, csvPath);

check("register() returns a schema", () => {
  assert.ok(Array.isArray(registered.columns) && registered.columns.length === 5);
});
check("columns are named from the header", () => {
  assert.deepEqual(
    registered.columns.map((c) => c.name),
    ["id", "name", "price", "big", "note"],
  );
});
check("the format is sniffed as csv", () => assert.equal(registered.format, "csv"));
check("the file size comes back", () => assert.ok(registered.sizeBytes > 0));

const counted = await page.evaluate(() =>
  window.queryStudioNative.query("SELECT count(*) AS n FROM smoke", null),
);
check("count(*) is 500", () => assert.equal(String(counted.rows[0][0]), "500"));

// A quoted comma must not become two columns, and an apostrophe must survive.
const parsed = await page.evaluate(() =>
  window.queryStudioNative.query("SELECT name FROM smoke WHERE id IN (1, 2, 3) ORDER BY id", null),
);
check("a quoted comma stays one field", () => assert.equal(parsed.rows[0][0], "Ward, Alice"));
check("an apostrophe survives", () => assert.equal(parsed.rows[1][0], "O'Brien"));
check("a doubled quote unescapes", () => assert.equal(parsed.rows[2][0], 'Bag "of" holding'));

// The bugs from the browser build, asked of the native path through real IPC.
const values = await page.evaluate(() =>
  window.queryStudioNative.query(
    "SELECT price::DECIMAL(9,2) AS p, big, note FROM smoke WHERE id = 1",
    null,
  ),
);
check("a DECIMAL keeps its point and scale", () => assert.equal(values.rows[0][0], "10.00"));
check("a BIGINT past 2^53 is exact", () => assert.equal(values.rows[0][1], "9007199254740993"));

const nulls = await page.evaluate(() =>
  window.queryStudioNative.query("SELECT note FROM smoke WHERE id = 2", null),
);
check("an empty field is null, not the string 'null'", () => assert.equal(nulls.rows[0][0], null));

const aggregate = await page.evaluate(() =>
  window.queryStudioNative.query("SELECT round(sum(price), 2) AS total FROM smoke", null),
);
check("an aggregate runs", () => assert.ok(Number(aggregate.rows[0][0]) > 0));
check("elapsedMs is reported", () => assert.ok(typeof aggregate.elapsedMs === "number"));

// ── errors ───────────────────────────────────────────────────────────────────

console.log("\n== error handling ==");

const failure = await page.evaluate(async () => {
  try {
    await window.queryStudioNative.query("SELECT * FROM nope", null);
    return null;
  } catch (error) {
    return String(error.message ?? error);
  }
});
check("a bad query rejects rather than hanging", () => assert.ok(failure));
check("the error names the missing table", () => assert.match(failure, /nope/i));

const recovered = await page.evaluate(() =>
  window.queryStudioNative.query("SELECT 1 AS ok", null),
);
check("the connection still works after an error", () => assert.equal(recovered.rows[0][0], 1));

// ── export ───────────────────────────────────────────────────────────────────

console.log("\n== export ==");

const exportPath = join(fixtures, "desktop-smoke-export.csv");
const exported = await page.evaluate(
  ([sql, dest]) => window.queryStudioDesktop.exportTo(sql, dest, "csv"),
  ["SELECT id, name FROM smoke ORDER BY id LIMIT 10", exportPath],
);

check("COPY … TO wrote a file", () => assert.ok(existsSync(exportPath)));
check("the export reports its size", () => assert.ok(exported.sizeBytes > 0));

// ── unregister ───────────────────────────────────────────────────────────────

await page.evaluate(() => window.queryStudioNative.unregister("smoke"));
const gone = await page.evaluate(async () => {
  try {
    await window.queryStudioNative.query("SELECT count(*) FROM smoke", null);
    return false;
  } catch {
    return true;
  }
});
check("unregister() drops the view", () => assert.equal(gone, true));

// ── quiet ────────────────────────────────────────────────────────────────────

console.log("\n== offline and quiet ==");

check("no http(s) request was made", () => {
  assert.deepEqual(offOrigin, [], `the desktop app reached out to: ${offOrigin.join(", ")}`);
});
check("no uncaught renderer error", () => {
  assert.deepEqual(pageErrors, [], pageErrors.join(" | "));
});

// Two of the queries above were meant to fail, and Electron logs every rejected
// ipcMain handler to stderr, so those two lines are expected and are matched out by
// name. Anything else on stderr is a genuine main-process fault — a rejected DuckDB
// config, a native module that would not load — and those are exactly the failures
// that used to reach a user as a window that opened and then did nothing.
const deliberate = /Table with name (nope|smoke) does not exist/;
const fatal = mainErrors
  .join("")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => /Error|Failed/.test(line) && !deliberate.test(line));

check("the main process logged no unexpected error", () => {
  assert.deepEqual(fatal, [], fatal.join(" | "));
});

await page.screenshot({ path: join(fixtures, "desktop.png") });
console.log(`\nscreenshot: ${join(fixtures, "desktop.png")}`);

await app.close();

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
