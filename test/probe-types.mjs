import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../apps/web/dist", import.meta.url));
const TMP = fileURLToPath(new URL("./.fixtures", import.meta.url));
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".json": "application/json", ".map": "application/json" };

const server = createServer(async (req, res) => {
  const p = decodeURIComponent(req.url.split("?")[0]);
  let file = normalize(join(ROOT, p === "/" ? "index.html" : p));
  if (!existsSync(file)) file = join(ROOT, "index.html");
  const body = await readFile(file);
  res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream", "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cross-Origin-Resource-Policy": "same-origin" });
  res.end(body);
});
await new Promise((r) => server.listen(4177, r));

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage();
await page.goto("http://localhost:4177", { waitUntil: "networkidle" });
await page.waitForSelector(".runtime", { timeout: 60_000 });
await page.setInputFiles('input[type="file"]', join(TMP, "orders.csv"));
await page.waitForTimeout(3000);

async function grid(sql) {
  await page.fill("textarea", sql);
  await page.click('button:has-text("Run")');
  await page.waitForFunction(() => !document.querySelector(".spinner"), { timeout: 60_000 });
  await page.waitForTimeout(500);
  const err = await page.textContent(".grid-state-message").catch(() => null);
  if (err) return "ERROR " + err;
  return await page.locator("table.grid").innerText().catch(() => "(none)");
}

console.log("--- summarize types ---");
console.log(await grid("SELECT column_name, typeof(null_percentage) AS t_null, typeof(approx_unique) AS t_uniq, null_percentage::VARCHAR AS np FROM (SUMMARIZE SELECT * FROM orders)"));

console.log("\n--- exact distinct vs approx ---");
console.log(await grid(`SELECT 'id' AS col, count(*) AS n, count(DISTINCT id) AS exact FROM orders
UNION ALL SELECT 'name', count(*), count(DISTINCT name) FROM orders
UNION ALL SELECT 'city', count(*), count(DISTINCT city) FROM orders
UNION ALL SELECT 'amount', count(*), count(DISTINCT amount) FROM orders
UNION ALL SELECT 'note', count(*), count(DISTINCT note) FROM orders`));

console.log("\n--- nulls in note ---");
console.log(await grid("SELECT count(*) AS total, count(note) AS non_null, sum(CASE WHEN note IS NULL THEN 1 ELSE 0 END) AS nulls FROM orders"));

await browser.close();
server.close();
