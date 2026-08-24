// Ad-hoc probe of @duckdb/node-api's real surface.
//
// apps/desktop/electron/main.ts was written against this alpha package without ever
// being executed. This checks the four things it assumes — DuckDBInstance.create,
// runAndReadAll, stream/fetchChunk, and the shape of a DECIMAL/BIGINT value — so a
// mismatch shows up here rather than as a blank window.
import { tmpdir } from "node:os";
import { join } from "node:path";

const duckdb = await import("@duckdb/node-api");

console.log("exports:", Object.keys(duckdb).filter((k) => /Instance|Connection|Type|Value/.test(k)).join(", "));

const instance = await duckdb.DuckDBInstance.create(":memory:", {
  threads: "4",
  max_memory: "8192MiB",
  temp_directory: join(tmpdir(), "query-studio-spill"),
});
const conn = await instance.connect();

const v = await conn.runAndReadAll("SELECT version() AS v");
console.log("version:", v.getRows()[0][0]);
console.log("reader methods:", ["columnNames", "columnTypes", "getRows", "getRowObjects"].map(
  (m) => `${m}=${typeof v[m]}`).join(" "));

// The value shapes main.ts's normaliseRows has to survive.
const r = await conn.runAndReadAll(`
  SELECT 10.00::DECIMAL(9,2)                AS dec_small,
         123456789012345678.123456789::DECIMAL(38,9) AS dec_big,
         9007199254740993::BIGINT           AS big,
         (2::HUGEINT)**100                  AS huge,
         DATE '2026-08-24'                  AS d,
         TIMESTAMP '2026-08-24 10:11:12.5'  AS ts,
         'x'::BLOB                          AS b,
         [1,2,3]                            AS list,
         {'a': 1}                           AS struct,
         NULL::INTEGER                      AS n
`);
console.log("cols:", r.columnNames().join(", "));
console.log("types:", r.columnTypes().map((t) => t.toString()).join(", "));
for (const [i, val] of r.getRows()[0].entries()) {
  const ctor = val === null ? "null" : val?.constructor?.name;
  console.log(`  ${r.columnNames()[i].padEnd(10)} ${String(ctor).padEnd(16)} ${JSON.stringify(
    val, (_k, x) => (typeof x === "bigint" ? `${x}n` : x))} | String()=${String(val)}`);
}

// Streaming.
const s = await conn.stream("SELECT i FROM range(5000) t(i)");
console.log("stream methods:", ["columnNames", "fetchChunk", "readAll"].map((m) => `${m}=${typeof s[m]}`).join(" "));
let chunks = 0, rows = 0;
for (;;) {
  const chunk = await s.fetchChunk();
  if (!chunk) break;
  const got = chunk.getRows();
  if (got.length === 0) break;
  chunks++; rows += got.length;
}
console.log(`stream: ${chunks} chunks, ${rows} rows`);

// COPY … TO, used by the desktop export path.
const out = join(tmpdir(), `qs-probe-${Date.now()}.csv`);
const posix = out.split(String.fromCharCode(92)).join('/');
await conn.run(`COPY (SELECT 1 AS a, 'b' AS b) TO '${posix}' (FORMAT CSV, HEADER)`);
console.log("COPY TO ok:", (await import("node:fs")).existsSync(out));

console.log("closeSync:", typeof conn.closeSync, "disconnectSync:", typeof conn.disconnectSync);
