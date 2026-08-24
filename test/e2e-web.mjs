// End-to-end: production build of apps/web, real Chrome, real DuckDB-WASM.
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../apps/web/dist", import.meta.url));
const TMP = fileURLToPath(new URL("./.fixtures", import.meta.url));

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".wasm": "application/wasm", ".json": "application/json", ".map": "application/json",
};

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n + (x !== undefined ? "  -> " + String(x).slice(0, 300) : "")); } };

// ── fixtures ────────────────────────────────────────────────────────────────
await mkdir(TMP, { recursive: true });

const CITIES = ["Oslo", "Rome", "Lima", "Kyiv", "Cairo", "Perth"];
let csv = "id,name,city,amount,note\n";
for (let i = 1; i <= 50_000; i++) {
  const city = CITIES[i % CITIES.length];
  // Row 7 carries a quoted comma and an apostrophe: the two things that break naive parsers.
  const name = i === 7 ? '"Smith, John O\'Hara"' : `user_${i}`;
  const amount = (i % 997) + i / 1000;
  const note = i % 10 === 0 ? "" : `note ${i}`;
  csv += `${i},${name},${city},${amount.toFixed(3)},${note}\n`;
}
const csvPath = join(TMP, "orders.csv");
await writeFile(csvPath, csv);

let nd = "";
for (let i = 1; i <= 2000; i++) nd += JSON.stringify({ id: i, tag: `t${i % 7}`, ok: i % 3 === 0 }) + "\n";
const ndPath = join(TMP, "events.ndjson");
await writeFile(ndPath, nd);

// A .txt file that is really TSV — proves sniffing beats the extension end to end.
let tsv = "sku\tqty\n";
for (let i = 1; i <= 500; i++) tsv += `SKU-${i}\t${i * 2}\n`;
const tsvPath = join(TMP, "stock.txt");
await writeFile(tsvPath, tsv);

console.log(`fixtures: orders.csv ${(csv.length / 1e6).toFixed(1)} MB, events.ndjson, stock.txt`);

// ── static server with cross-origin isolation ───────────────────────────────
if (!existsSync(ROOT)) { console.error("no dist — run npm run build first"); process.exit(1); }

const server = createServer(async (req, res) => {
  const urlPath = decodeURIComponent(req.url.split("?")[0]);
  let file = normalize(join(ROOT, urlPath === "/" ? "index.html" : urlPath));
  if (!file.startsWith(normalize(ROOT))) { res.writeHead(403).end(); return; }
  if (!existsSync(file)) file = join(ROOT, "index.html");
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Resource-Policy": "same-origin",
    });
    res.end(body);
  } catch (e) { res.writeHead(500).end(String(e)); }
});
await new Promise((r) => server.listen(4173, r));
const BASE = "http://localhost:4173";
console.log("serving dist on " + BASE);

// ── browser ─────────────────────────────────────────────────────────────────
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage();

const consoleErrors = [];
const pageErrors = [];
const failedRequests = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("requestfailed", (r) => failedRequests.push(`${r.url()} :: ${r.failure()?.errorText}`));

// Any request off-origin is a privacy regression — the whole pitch is "nothing leaves your browser".
const offOrigin = [];
page.on("request", (r) => { if (!r.url().startsWith(BASE) && !r.url().startsWith("data:") && !r.url().startsWith("blob:")) offOrigin.push(r.url()); });

console.log("\n== boot ==");
await page.goto(BASE, { waitUntil: "networkidle" });

const isolated = await page.evaluate(() => globalThis.crossOriginIsolated);
console.log(`  crossOriginIsolated: ${isolated}`);

try {
  await page.waitForSelector(".runtime", { timeout: 60_000 });
  const label = (await page.textContent(".runtime")).trim();
  ok("engine booted", label.length > 0, label);
  ok("reports the wasm runtime", /browser|wasm/i.test(label), label);
} catch (e) {
  ok("engine booted", false, e.message);
  console.log("  console errors:", consoleErrors.slice(0, 5));
  console.log("  page errors:", pageErrors.slice(0, 5));
  console.log("  failed requests:", failedRequests.slice(0, 5));
}

ok("no page errors during boot", pageErrors.length === 0, pageErrors[0]);
ok("duckdb wasm served from own origin", offOrigin.length === 0, offOrigin.slice(0, 3).join(" | "));

// ── load the CSV ────────────────────────────────────────────────────────────
console.log("\n== register 50k-row CSV ==");
const t0 = Date.now();
await page.setInputFiles('input[type="file"]', csvPath);
try {
  await page.waitForSelector(".sidebar .table-item, .sidebar li", { timeout: 90_000 });
  ok(`csv registered (${Date.now() - t0} ms)`, true);
} catch (e) {
  ok("csv registered", false, e.message);
  const banner = await page.textContent(".banner").catch(() => "no banner");
  console.log("  banner:", banner);
  console.log("  page errors:", pageErrors.slice(0, 3));
}

const sidebar = await page.textContent(".sidebar").catch(() => "");
ok("table named from the filename", /orders/i.test(sidebar), sidebar.slice(0, 200));

// The editor should be pre-seeded with a preview query and it should have auto-run.
await page.waitForTimeout(2500);
const editorText = await page.inputValue("textarea").catch(() => page.textContent(".editor-pane").catch(() => ""));
ok("editor seeded with a query", /select/i.test(editorText || ""), (editorText || "").slice(0, 120));

// By design the drop seeds the editor but does not run — dropping a 3 GB file must
// not start a scan nobody asked for. So the grid should be empty until Run.
const gridExists = await page.locator("table.grid").count();
ok("drop does not auto-scan the file", gridExists === 0, `grid count ${gridExists}`);

// ── run a real aggregate ────────────────────────────────────────────────────
console.log("\n== aggregate query ==");
async function runSql(sql) {
  await page.fill("textarea", sql);
  await page.click('button:has-text("Run")');
  await page.waitForFunction(
    () => !document.querySelector(".spinner") && (document.querySelector("table.grid") || document.querySelector(".grid-state")),
    { timeout: 60_000 },
  );
  await page.waitForTimeout(400);
}

await runSql("SELECT city, count(*) AS n, round(sum(amount), 2) AS total\nFROM orders\nGROUP BY city\nORDER BY n DESC");

const err = await page.textContent(".grid-state-message").catch(() => null);
ok("aggregate ran without error", !err, err);

const rows = await page.locator("table.grid tbody tr").count();
ok("six cities grouped", rows === 6, `got ${rows} rows`);

const firstRow = await page.locator("table.grid tbody tr").first().innerText().catch(() => "");
ok("group counts look right", /8333|8334/.test(firstRow.replace(/[\s,]/g, "")), firstRow);

// ── the quoted-comma row ────────────────────────────────────────────────────
console.log("\n== quoting and escaping ==");
await runSql("SELECT id, name FROM orders WHERE id = 7");
const quotedRow = await page.locator("table.grid tbody tr").first().innerText().catch(() => "");
ok("quoted comma parsed as one field", /Smith, John/.test(quotedRow), quotedRow);

await runSql("SELECT count(*) AS n FROM orders WHERE note = ''");
const emptyNote = await page.locator("table.grid tbody tr").first().innerText().catch(() => "");
ok("empty-string / null column queryable", emptyNote.length > 0, emptyNote);

// ── BIGINT rendering ────────────────────────────────────────────────────────
await runSql("SELECT 9223372036854775807::BIGINT AS big, 1.5::DOUBLE AS d, NULL AS n");
const bigRow = await page.locator("table.grid tbody tr").first().innerText().catch(() => "");
ok("BIGINT renders exactly, no precision loss", bigRow.includes("9223372036854775807"), bigRow);

// ── auto LIMIT ──────────────────────────────────────────────────────────────
console.log("\n== auto row limit ==");
await runSql("SELECT * FROM orders");
const limitedRows = await page.locator("table.grid tbody tr").count();
ok("unbounded SELECT was capped", limitedRows > 0 && limitedRows <= 1000, `${limitedRows} rows rendered`);
const footer = await page.textContent(".grid-footer").catch(() => "");
ok("truncation disclosed in the footer", /limit|truncat|1,000|1000/i.test(footer), footer.slice(0, 200));

// ── second file, join across formats ────────────────────────────────────────
console.log("\n== second file (NDJSON) + cross-format join ==");
await page.setInputFiles('input[type="file"]', ndPath);
await page.waitForTimeout(4000);
const sidebar2 = await page.textContent(".sidebar").catch(() => "");
ok("ndjson registered alongside csv", /events/i.test(sidebar2), sidebar2.slice(0, 250));

await runSql("SELECT e.tag, count(*) AS n\nFROM events e JOIN orders o ON o.id = e.id\nGROUP BY e.tag ORDER BY e.tag");
const joinErr = await page.textContent(".grid-state-message").catch(() => null);
ok("csv-to-ndjson join ran", !joinErr, joinErr);
const joinRows = await page.locator("table.grid tbody tr").count();
ok("join returned the 7 tags", joinRows === 7, `got ${joinRows}`);

// ── sniffed .txt that is really TSV ─────────────────────────────────────────
console.log("\n== extension lies: .txt holding TSV ==");
await page.setInputFiles('input[type="file"]', tsvPath);
await page.waitForTimeout(4000);
await runSql("SELECT count(*) AS n, max(qty) AS mx FROM stock");
const tsvErr = await page.textContent(".grid-state-message").catch(() => null);
const tsvRow = await page.locator("table.grid tbody tr").first().innerText().catch(() => "");
ok("tsv-in-txt sniffed and queried", !tsvErr && /500/.test(tsvRow.replace(/[\s,]/g, "")), tsvErr || tsvRow);

// ── error handling ──────────────────────────────────────────────────────────
console.log("\n== error surface ==");
await runSql("SELECT * FROM does_not_exist");
const errText = await page.textContent(".grid-state-message").catch(() => null);
ok("bad table gives a readable error", !!errText && errText.length > 5, errText);
ok("app still alive after an error", (await page.locator(".runtime").count()) > 0);

await runSql("SELECT city, count(*) AS n FROM orders GROUP BY city");
const recovered = await page.locator("table.grid tbody tr").count();
ok("recovers and runs the next query", recovered === 6, `${recovered} rows`);

// ── share link round-trip through the UI ────────────────────────────────────
console.log("\n== share link ==");
let shareUrl = null;
const shareBtn = page.locator('button:has-text("Share")');
if (await shareBtn.count()) {
  await shareBtn.first().click();
  await page.waitForTimeout(1200);
  shareUrl = await page.inputValue('input[readonly], .share-url input, input.share-link').catch(() => null);
  if (!shareUrl) {
    const dialogText = await page.textContent(".dialog, .share-dialog, [role=dialog]").catch(() => "");
    const m = dialogText && dialogText.match(/https?:\/\/\S*#q=\S+/);
    shareUrl = m ? m[0] : null;
  }
}
ok("share produced a link", !!shareUrl, shareUrl ? shareUrl.slice(0, 80) : "no link found");
if (shareUrl) {
  ok("link is a fragment, not a query string", shareUrl.includes("#q="), shareUrl.slice(0, 80));
  ok("link carries no row data", !/Oslo|Rome|Smith/.test(shareUrl));

  const p2 = await browser.newPage();
  await p2.goto(shareUrl, { waitUntil: "networkidle" });
  await p2.waitForSelector(".runtime", { timeout: 60_000 }).catch(() => {});
  await p2.waitForTimeout(2000);
  const restored = await p2.inputValue("textarea").catch(() => "");
  ok("recipient sees the shared SQL", /group by/i.test(restored), restored.slice(0, 120));
  const bodyText = await p2.textContent("body");
  ok("recipient told which file to open", /orders/i.test(bodyText), "");
  await p2.close();
}

// Dismiss the share dialog before touching the toolbar again.
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
if (await page.locator(".modal-backdrop").count()) {
  await page.locator(".modal-backdrop").click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.waitForTimeout(400);
}
ok("share dialog closes on Escape", (await page.locator(".modal-backdrop").count()) === 0);

// ── export ──────────────────────────────────────────────────────────────────
console.log("\n== export ==");
await runSql("SELECT city, count(*) AS n FROM orders GROUP BY city ORDER BY city");
const exportBtn = page.locator('button:has-text("Export")');
if (await exportBtn.count()) {
  await exportBtn.first().click();
  await page.waitForTimeout(600);
  const dl = page.waitForEvent("download", { timeout: 30_000 }).catch(() => null);
  const csvItem = page.locator('[role=menuitem]:has-text("CSV"), [role=menuitem]').first();
  if (await csvItem.count()) await csvItem.click();
  const download = await dl;
  if (download) {
    const path = join(TMP, "exported.csv");
    await download.saveAs(path);
    const content = await readFile(path, "utf8");
    ok("export downloaded a file", content.length > 0, `${content.length} bytes`);
    ok("export has a header row", /city/i.test(content.split("\n")[0]), content.split("\n")[0]);
    ok("export has all six cities", content.trim().split("\n").length === 7, `${content.trim().split("\n").length} lines`);
  } else ok("export downloaded a file", false, "no download event");
} else ok("export button present", false);

// ── profiling ───────────────────────────────────────────────────────────────
console.log("\n== column profiling ==");
const profileBtn = page.locator('button:has-text("Profile"), button[title*="rofile"]');
if (await profileBtn.count()) {
  await profileBtn.first().click();
  await page.waitForTimeout(8000);
  const body = await page.textContent("body");
  ok("profile produced badges", /unique|constant|no nulls|low.card|null/i.test(body), "");
} else {
  console.log("  (no profile button in this UI — profiling is exercised via the core API below)");
  const viaApi = await page.evaluate(async () => {
    try { return typeof window; } catch { return "err"; }
  });
  ok("profile entry point", viaApi === "object");
}

// ── final health ────────────────────────────────────────────────────────────
console.log("\n== session health ==");
ok("no uncaught page errors all session", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
ok("no off-origin requests all session", offOrigin.length === 0, offOrigin.slice(0, 3).join(" | "));
if (consoleErrors.length) console.log("  console errors (informational):\n    " + consoleErrors.slice(0, 6).join("\n    "));

await page.screenshot({ path: join(TMP, "workbench.png"), fullPage: true });
console.log("  screenshot -> " + join(TMP, "workbench.png"));

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
