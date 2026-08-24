// Turning DuckDB's native values into something that survives Electron IPC.
//
// Split out of main.ts so it can be tested against a real DuckDB connection without
// booting Electron — see test/native-values.test.mjs. Nothing here may import
// `electron`, or that test stops being runnable.

/**
 * A DuckDB row -> something that survives IPC and reads the same as the browser build.
 *
 * Two separate problems, and the second is the one that bites.
 *
 * The first is structured clone: a `bigint` cannot cross the Electron IPC boundary
 * at all, so BIGINT and HUGEINT have to become strings.
 *
 * The second is that `@duckdb/node-api` returns *wrapper objects* for almost every
 * non-primitive type, and none of them are the JS built-ins you would guess. A DATE
 * is a `DuckDBDateValue`, not a `Date`. A BLOB is a `DuckDBBlobValue` wrapping a
 * Buffer, not a `Uint8Array`. So an `instanceof Date` / `instanceof Uint8Array`
 * check misses every one of them, and they fall through to `JSON.stringify`, which
 * serialises the wrapper's internals:
 *
 *     10.00::DECIMAL(9,2)  ->  {"width":9,"scale":2,"value":"1000"}
 *     DATE '2026-08-24'    ->  {"days":20689}
 *     [1,2,3]              ->  {"items":[1,2,3]}
 *
 * That is what the desktop build did for every DECIMAL, DATE, TIMESTAMP, BLOB, LIST,
 * STRUCT, MAP, UUID, INTERVAL and BIT column. The browser build renders all of them
 * correctly, so the same file opened in the two apps disagreed.
 *
 * The way out is that every `DuckDB*Value` has a `toString()` producing the correct
 * SQL text — `DuckDBDecimalValue` in particular reconstructs the number exactly,
 * without going through a float, which is what DECIMAL(38,9) needs. So scalars are
 * rendered with `String()`, and only the containers need unwrapping: those are
 * recursed into and returned as plain arrays and objects, so `JSON.stringify` below
 * produces the same `[1,2,3]` / `{"a":1}` the Arrow-based browser path produces.
 */
export function plainValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return value;

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return toHex(value);

  const wrapper = value as Record<string, unknown>;

  // LIST and ARRAY: { items: DuckDBValue[] }
  if (Array.isArray(wrapper.items)) return wrapper.items.map(plainValue);

  // MAP is { entries: { key, value }[] } and STRUCT is { entries: Record<…> }.
  // Same property name, told apart by whether it is an array.
  if (Array.isArray(wrapper.entries)) {
    return (wrapper.entries as { key: unknown; value: unknown }[]).map((entry) => ({
      key: plainValue(entry.key),
      value: plainValue(entry.value),
    }));
  }
  if (wrapper.entries && typeof wrapper.entries === "object") {
    return Object.fromEntries(
      Object.entries(wrapper.entries as Record<string, unknown>).map(([k, v]) => [k, plainValue(v)]),
    );
  }

  // BLOB: { bytes: Buffer }
  if (wrapper.bytes instanceof Uint8Array) return toHex(wrapper.bytes);

  // Everything else — DECIMAL, DATE, TIME, TIMESTAMP, TIMESTAMPTZ, INTERVAL, UUID,
  // BIT — has a toString() that is exactly what the cell should read.
  if (value.toString !== Object.prototype.toString) return String(value);

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toHex(bytes: Uint8Array): string {
  let out = "0x";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function normaliseRows(rows: unknown[][]): unknown[][] {
  return rows.map((row) =>
    row.map((value) => {
      const plain = plainValue(value);
      // Containers render as JSON text, matching the browser backend's grid cells.
      if (plain !== null && typeof plain === "object") {
        try {
          return JSON.stringify(plain);
        } catch {
          return String(plain);
        }
      }
      return plain;
    }),
  );
}
