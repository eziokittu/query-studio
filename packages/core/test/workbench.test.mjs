import * as W from "@query-studio/core/workbench";

let pass = 0, fail = 0;
const enc = (s) => new TextEncoder().encode(s);
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
}
function eq(name, actual, expected) { ok(name, Object.is(actual, expected), { actual, expected }); }

console.log("\n== detectFormat ==");
{
  const csv = enc("id,name,city\n1,Ann,Oslo\n2,Bo,Rome\n3,Cy,Lima\n4,Di,Kiev\n");
  const d = W.detectFormat("data.csv", csv);
  eq("csv format", d.format, "csv"); eq("csv delimiter", d.delimiter, ",");

  const semi = enc("id;name;city\n1;Ann;Oslo\n2;Bo;Rome\n3;Cy;Lima\n4;Di;Kiev\n");
  eq("semicolon delimiter", W.detectFormat("euro.csv", semi).delimiter, ";");

  const tsv = enc("id\tname\n1\tAnn\n2\tBo\n3\tCy\n");
  eq("tsv via bytes despite .txt", W.detectFormat("mystery.txt", tsv).format, "tsv");

  const nd = enc('{"a":1}\n{"a":2}\n{"a":3}\n');
  eq("ndjson", W.detectFormat("records.json", nd).format, "ndjson");

  const json = enc('[\n {"a":1},\n {"a":2}\n]\n');
  eq("json array", W.detectFormat("doc.json", json).format, "json");

  const par = new Uint8Array([0x50, 0x41, 0x52, 0x31, 0, 0, 0, 0]);
  eq("parquet magic beats extension", W.detectFormat("wrong.csv", par).format, "parquet");

  const log = enc("2024-01-01 ERROR something broke badly here\n2024-01-01 INFO all fine now ok\n2024-01-02 WARN hmm this is odd\n");
  eq("log fallback", W.detectFormat("app.log", log).format, "log");

  eq("extension-only fallback", W.detectFormat("x.parquet").format, "parquet");
  eq("empty file", W.detectFormat("e.csv", new Uint8Array(0)).format, "csv");

  const quoted = enc('id,name\n1,"Smith, John"\n2,"Doe, Jane"\n3,"Roe, Rick"\n');
  eq("quoted commas respected", W.detectFormat("q.csv", quoted).delimiter, ",");
}

console.log("\n== tableNameFor ==");
{
  eq("spaces+parens", W.tableNameFor("2024 Sales (final).csv"), "t_2024_sales_final");
  eq("plain", W.tableNameFor("orders.parquet"), "orders");
  eq("reserved word", W.tableNameFor("select.csv"), "select_tbl");
  eq("collision", W.tableNameFor("data.csv", new Set(["data"])), "data_2");
  eq("path stripped", W.tableNameFor("C:\\tmp\\jan\\report.csv"), "report");
  eq("all-punct falls back", W.tableNameFor("!!!.csv"), "data");
}

console.log("\n== applyRowLimit ==");
{
  eq("adds limit", W.applyRowLimit("SELECT * FROM t", 10), "SELECT * FROM t\nLIMIT 10");
  eq("keeps existing", W.applyRowLimit("SELECT * FROM t LIMIT 5", 10), "SELECT * FROM t LIMIT 5");
  eq("null means no limit", W.applyRowLimit("SELECT * FROM t", null), "SELECT * FROM t");
  eq("non-select untouched", W.applyRowLimit("CREATE VIEW v AS SELECT 1", 10), "CREATE VIEW v AS SELECT 1");
  const sub = W.applyRowLimit("SELECT * FROM (SELECT * FROM t LIMIT 5) x", 10);
  ok("subquery limit does not count", sub.endsWith("LIMIT 10"), sub);
  const lit = W.applyRowLimit("SELECT * FROM t WHERE msg = 'limit reached'", 10);
  ok("string literal limit does not count", lit.endsWith("LIMIT 10"), lit);
  ok("WITH cte gets limit", W.applyRowLimit("WITH a AS (SELECT 1) SELECT * FROM a", 10).endsWith("LIMIT 10"));
  ok("FROM-first gets limit", W.applyRowLimit("FROM t SELECT *", 10).endsWith("LIMIT 10"));
  eq("trailing semicolon stripped", W.applyRowLimit("SELECT 1;", 10), "SELECT 1\nLIMIT 10");
}

console.log("\n== splitStatements ==");
{
  const s = W.splitStatements("SELECT 1; SELECT ';' AS x; -- c; not a split\nSELECT 3;");
  eq("statement count", s.length, 3);
  eq("semicolon in literal kept", s[1], "SELECT ';' AS x");
  ok("line comment stays with next", s[2].includes("SELECT 3"), s[2]);
  eq("empty script", W.splitStatements("   ").length, 0);
}

console.log("\n== buildScanExpression ==");
{
  const csv = W.buildScanExpression("a.csv", { format: "csv", delimiter: ";" });
  ok("csv delim quoted", csv.includes("delim=';'"), csv);
  ok("csv ignore_errors", csv.includes("ignore_errors=true"));
  ok("parquet", W.buildScanExpression("a.parquet", { format: "parquet" }).startsWith("read_parquet("));
  ok("ndjson newline_delimited", W.buildScanExpression("a.ndjson", { format: "ndjson" }).includes("newline_delimited"));
  ok("json array", W.buildScanExpression("a.json", { format: "json" }).includes("format='array'"));
  const inj = W.buildScanExpression("evil's.csv", { format: "csv" });
  ok("locator literal escaped", inj.includes("'evil''s.csv'"), inj);
  const tsv = W.buildScanExpression("a.tsv", { format: "tsv" });
  ok("tsv defaults to tab", tsv.includes("delim='\t'"), JSON.stringify(tsv));
}

console.log("\n== isMutation / quoting ==");
{
  ok("create is mutation", W.isMutation("CREATE TABLE t (a int)"));
  ok("select is not", !W.isMutation("SELECT 1"));
  eq("quoteIdent escapes", W.quoteIdent('we"ird'), '"we""ird"');
  eq("quoteLiteral escapes", W.quoteLiteral("it's"), "'it''s'");
}

console.log("\n== share round-trip ==");
{
  const tables = [{
    id: "t1", name: "orders", fileName: "orders.csv", format: "csv",
    sizeBytes: 3_221_225_472, rowCount: 9_000_000, locator: "orders.csv",
    columns: [
      { name: "id", type: "BIGINT", nullable: false },
      { name: "customer_email", type: "VARCHAR", nullable: true },
      { name: "total", type: "DOUBLE", nullable: true },
    ],
  }];
  const sql = "SELECT customer_email, sum(total) AS spend\nFROM orders\nGROUP BY 1\nORDER BY spend DESC";
  const payload = W.buildSharePayload(sql, tables, "look at row 42");
  const url = await W.buildShareUrl("https://glitchbong.com/tools/query-studio/workbench", payload);
  ok("fragment only", url.includes("#q=") && !url.includes("?q="), url.slice(0, 90));
  ok("compressed marker", url.includes("#q=z"));

  const back = await W.readShareUrl(url);
  eq("sql survives", back.sql, sql);
  eq("note survives", back.note, "look at row 42");
  eq("source count", back.sources.length, 1);
  eq("column count", back.sources[0].columns.length, 3);
  eq("size survives", back.sources[0].sizeBytes, 3_221_225_472);

  const serialized = JSON.stringify(payload).replace(sql, "");
  ok("no data fields in payload", !/sample|preview|rows|cells/i.test(serialized), serialized.slice(0, 200));

  eq("garbage returns null", await W.decodeShare("not-ours"), null);
  eq("empty returns null", await W.decodeShare(""), null);
  eq("truncated returns null", await W.decodeShare(url.slice(url.indexOf("#q=") + 3, url.indexOf("#q=") + 23)), null);

  const size = await W.checkShareSize(payload);
  ok("link is pasteable", size.ok && size.bytes < 1000, size);

  const wide = W.buildSharePayload(sql, [{
    ...tables[0],
    columns: Array.from({ length: 600 }, (_, i) => ({ name: `column_number_${i}`, type: "VARCHAR", nullable: true })),
  }]);
  const wideSize = await W.checkShareSize(wide);
  ok("oversize link carries advice", wideSize.ok || !!wideSize.advice, wideSize);
}

console.log("\n== matchSources ==");
{
  const expected = [{
    id: "t1", name: "orders", fileName: "orders.csv", format: "csv", sizeBytes: 10, rowCount: null, locator: "orders.csv",
    columns: [{ name: "id", type: "BIGINT", nullable: false }, { name: "total", type: "DOUBLE", nullable: true }],
  }];
  const payload = W.buildSharePayload("SELECT 1", expected);

  eq("missing table", W.matchSources(payload, [])[0].matched, null);

  const drifted = [{ ...expected[0], columns: [{ name: "id", type: "VARCHAR", nullable: true }] }];
  const m = W.matchSources(payload, drifted)[0];
  ok("type mismatch caught", m.typeMismatches.length === 1 && m.typeMismatches[0].column === "id", m.typeMismatches);
  ok("missing column caught", m.missingColumns.includes("total"), m.missingColumns);

  const exact = W.matchSources(payload, expected)[0];
  ok("clean match", !!exact.matched && !exact.missingColumns.length && !exact.typeMismatches.length);
}

console.log("\n== engine selection / size guard ==");
{
  const e = W.createEngine({ force: "wasm" });
  eq("wasm kind", e.capabilities.kind, "wasm");
  ok("suggests desktop", W.describeRuntime(e).suggestDesktop);
  ok("2GB ok", W.checkFileSize(2 * 1024 ** 3, e).ok);
  const big = W.checkFileSize(9 * 1024 ** 3, e);
  ok("9GB refused", !big.ok && big.desktopWouldWork, big);
  ok("refusal names the size", !big.ok && /9(\.0)?\s?GB/i.test(big.message), big.message);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
