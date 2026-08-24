// The desktop backend's value conversion, tested against a real DuckDB.
//
// apps/desktop/electron/main.ts had never been executed before this test existed.
// Two things it assumed turned out to be wrong, and both were silent:
//
//   * `max_memory: "80%"` is rejected by DuckDB 1.4 — `%` is not a unit it accepts,
//     in a config or in a `SET`. That threw inside getConnection(), so the first
//     query in the desktop app failed and every one after it did too.
//   * every DECIMAL, DATE, TIMESTAMP, BLOB, LIST, STRUCT, MAP, UUID, INTERVAL and
//     BIT rendered as the internals of a wrapper object, because none of them are
//     the JS built-ins the old code checked for.
//
// So this asserts on the values a real DuckDB actually hands back, not on a mock.
// A mock would have kept passing through both bugs.
import { strict as assert } from "node:assert";
import { totalmem } from "node:os";

import { normaliseRows, plainValue } from "../dist/values.mjs";

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

const duckdb = await import("@duckdb/node-api");

// ── the config that used to throw ────────────────────────────────────────────

console.log("\n== instance config ==");

// Same expression as memoryBudget() in main.ts. If DuckDB ever stops accepting
// this spelling, the desktop app is dead on boot, so it is asserted rather than
// assumed.
const budget = `${Math.max(1024, Math.floor((totalmem() * 0.8) / (1024 * 1024)))}MiB`;

let instance;
try {
  instance = await duckdb.DuckDBInstance.create(":memory:", {
    threads: "4",
    max_memory: budget,
    temp_directory: process.env.TEMP || "/tmp",
  });
  passed++;
  console.log(`  ok   max_memory=${budget} accepted`);
} catch (error) {
  failed++;
  console.log(`  FAIL max_memory=${budget} rejected: ${error.message}`);
  process.exit(1);
}

const conn = await instance.connect();

// Documents *why* memoryBudget() exists. If a later DuckDB starts accepting "80%",
// this fails and the helper can go away.
//
// `create` rejects rather than throwing, so this must be awaited — leaving it
// unawaited surfaces as an unhandled rejection that kills the run several tests
// later, nowhere near the cause.
let rejected = false;
try {
  await duckdb.DuckDBInstance.create(":memory:", { max_memory: "80%" });
} catch {
  rejected = true;
}
check("a percentage is still not a valid memory unit", () => {
  assert.equal(rejected, true, "expected DuckDB to reject a percentage");
});

// ── value conversion ─────────────────────────────────────────────────────────

async function cell(expression) {
  const reader = await conn.runAndReadAll(`SELECT ${expression} AS v`);
  return normaliseRows(reader.getRows())[0][0];
}

console.log("\n== scalars ==");

const scalars = [
  // The bug that shipped in the browser build too: an unscaled integer must get
  // its point back, and must not be rounded through a float on the way.
  ["10.00::DECIMAL(9,2)", "10.00"],
  ["-0.05::DECIMAL(9,2)", "-0.05"],
  ["123456789012345678.123456789::DECIMAL(38,9)", "123456789012345678.123456789"],
  // Beyond 2^53. A float round-trip would corrupt this one.
  ["9007199254740993::BIGINT", "9007199254740993"],
  ["170141183460469231731687303715884105727::HUGEINT", "170141183460469231731687303715884105727"],
  ["DATE '2026-08-24'", "2026-08-24"],
  ["TIME '10:11:12'", "10:11:12"],
  ["'550e8400-e29b-41d4-a716-446655440000'::UUID", "550e8400-e29b-41d4-a716-446655440000"],
  ["INTERVAL 3 DAY", "3 days"],
  ["'101'::BIT", "101"],
  ["'x'::ENUM('x','y')", "x"],
  // Primitives must pass through untouched, not become strings.
  ["42::INTEGER", 42],
  ["3.5::DOUBLE", 3.5],
  ["true", true],
  ["'hello'", "hello"],
  ["NULL::INTEGER", null],
];

for (const [expression, expected] of scalars) {
  const actual = await cell(expression);
  check(`${expression} -> ${JSON.stringify(expected)}`, () => {
    assert.deepEqual(actual, expected);
  });
}

const timestamp = await cell("TIMESTAMP '2026-08-24 10:11:12.5'");
check("TIMESTAMP renders as a timestamp, not {micros}", () => {
  assert.equal(typeof timestamp, "string");
  assert.match(timestamp, /^2026-08-24 10:11:12/);
});

const blob = await cell("'x'::BLOB");
check("BLOB renders as hex", () => assert.equal(blob, "0x78"));

console.log("\n== containers ==");

// These have to match the browser backend exactly. The share link carries a schema
// and people compare the two apps side by side; DuckDB's own `[1, 2, 3]` and
// `{'a': 1}` spellings are not what Arrow produces, so they are not used.
const containers = [
  ["[1,2,3]", "[1,2,3]"],
  ["{'a': 1, 'b': 'two'}", '{"a":1,"b":"two"}'],
  ["[{'a': 1}, {'a': 2}]", '[{"a":1},{"a":2}]'],
  ["MAP{'a': 1}", '[{"key":"a","value":1}]'],
  // A BIGINT nested inside a list still cannot cross IPC as a bigint.
  ["[9007199254740993::BIGINT]", '["9007199254740993"]'],
  // And a DECIMAL nested in a struct must not regress to the wrapper's internals.
  ["{'price': 10.00::DECIMAL(9,2)}", '{"price":"10.00"}'],
];

for (const [expression, expected] of containers) {
  const actual = await cell(expression);
  check(`${expression} -> ${expected}`, () => assert.equal(actual, expected));
}

console.log("\n== IPC safety ==");

// The actual requirement. Anything structuredClone refuses is a crash in the real
// app rather than a rendering glitch, so the whole matrix is checked at once.
const wide = await conn.runAndReadAll(`
  SELECT 10.00::DECIMAL(9,2), 9007199254740993::BIGINT, DATE '2026-08-24',
         TIMESTAMP '2026-08-24 10:11:12', 'x'::BLOB, [1,2], {'a': 1},
         MAP{'a': 1}, INTERVAL 3 DAY, '550e8400-e29b-41d4-a716-446655440000'::UUID,
         NULL::INTEGER
`);
const rows = normaliseRows(wide.getRows());

check("every value survives structuredClone", () => {
  structuredClone(rows);
});

check("no wrapper object leaks through", () => {
  for (const value of rows[0]) {
    assert.notEqual(typeof value, "bigint", "a bigint reached IPC");
    if (value !== null) {
      assert.notEqual(typeof value, "object", `a wrapper reached IPC: ${JSON.stringify(value)}`);
    }
  }
});

check("plainValue is null-safe", () => {
  assert.equal(plainValue(null), null);
  assert.equal(plainValue(undefined), null);
});

console.log("\n== streaming ==");

// main.ts's export path depends on fetchChunk returning null (or an empty chunk)
// to end. Getting that wrong is an infinite loop, so it is checked here.
const stream = await conn.stream("SELECT i FROM range(5000) t(i)");
let streamed = 0;
let chunks = 0;
for (;;) {
  const chunk = await stream.fetchChunk();
  if (!chunk) break;
  const got = chunk.getRows();
  if (got.length === 0) break;
  chunks++;
  streamed += got.length;
  assert.ok(chunks < 1000, "fetchChunk never terminated");
}
check(`stream drains 5000 rows (${chunks} chunks)`, () => assert.equal(streamed, 5000));

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
