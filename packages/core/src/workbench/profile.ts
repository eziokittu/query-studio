// Column profiling: the "what is actually in this file?" pass.
//
// The first question anyone has about an unfamiliar 4 GB export is not answerable
// with SQL they can write yet — they need to know which columns are empty, which are
// secretly all one value, and whether `user_id` is unique before they join on it.
// Every viewer in this category makes you scroll to find that out.
//
// DuckDB's own `SUMMARIZE` does most of the work in a single pass, which is what
// makes this affordable on a file too big to scroll: one scan, all columns.

import type { ColumnInfo, QueryEngine, TableHandle } from "./types.js";
import { quoteIdent } from "./sql.js";

export interface ColumnProfile {
  name: string;
  type: string;
  /** Rows where the column is NULL. */
  nullCount: number;
  /** Share of rows that are NULL, 0–1. */
  nullFraction: number;
  /** Approximate distinct values. DuckDB uses HyperLogLog, so it is an estimate. */
  approxDistinct: number;
  /** Present for numeric and temporal columns. */
  min?: string;
  max?: string;
  avg?: string;
  /** Quartiles, for numeric columns. Cheap to get once SUMMARIZE has run. */
  q25?: string;
  q50?: string;
  q75?: string;
  /** Derived flags the UI turns into badges. */
  flags: ColumnFlag[];
}

export type ColumnFlag =
  /** Every row is NULL — the column carries no information at all. */
  | "all-null"
  /** No NULLs anywhere. Safe to use in a WHERE without a null guard. */
  | "no-nulls"
  /** Distinct count equals row count: a candidate key, safe to join on. */
  | "unique"
  /** A single distinct value across the whole file. Usually a leftover export flag. */
  | "constant"
  /** Few distinct values relative to rows — a natural GROUP BY or filter. */
  | "low-cardinality"
  /** More than half the rows are NULL. Worth knowing before you aggregate it. */
  | "mostly-null";

export interface TableProfile {
  tableId: string;
  tableName: string;
  rowCount: number;
  columns: ColumnProfile[];
  /** Wall-clock time for the profiling scan. */
  elapsedMs: number;
}

/**
 * Profile every column in one pass.
 *
 * `SUMMARIZE` returns one row per column with the stats already computed, so the
 * cost is a single scan regardless of column count — profiling a 200-column file is
 * the same work as profiling a 3-column one.
 */
export async function profileTable(engine: QueryEngine, table: TableHandle): Promise<TableProfile> {
  const started = Date.now();

  const result = await engine.query(`SUMMARIZE SELECT * FROM ${quoteIdent(table.name)}`, {
    limit: null,
  });

  const index = columnIndex(result.columns);
  const rowCount = await resolveRowCount(engine, table, result, index);

  const columns = result.rows.map((row) => {
    const name = str(row[index.column_name]) ?? "";
    const type = str(row[index.column_type]) ?? "VARCHAR";
    const nullPct = num(row[index.null_percentage]) ?? 0;
    const approxDistinct = num(row[index.approx_unique]) ?? 0;

    // SUMMARIZE reports null_percentage as 0–100, occasionally as a formatted
    // string depending on version. Normalising to a fraction here keeps the flag
    // thresholds below readable.
    const nullFraction = clamp01(nullPct > 1 ? nullPct / 100 : nullPct);
    const nullCount = Math.round(nullFraction * rowCount);

    const profile: ColumnProfile = {
      name,
      type,
      nullCount,
      nullFraction,
      approxDistinct,
      min: str(row[index.min]),
      max: str(row[index.max]),
      avg: str(row[index.avg]),
      q25: str(row[index.q25]),
      q50: str(row[index.q50]),
      q75: str(row[index.q75]),
      flags: [],
    };
    profile.flags = deriveFlags(profile, rowCount);
    return profile;
  });

  return {
    tableId: table.id,
    tableName: table.name,
    rowCount,
    columns,
    elapsedMs: Date.now() - started,
  };
}

/**
 * Flags worth a badge in the UI.
 *
 * Thresholds are chosen to be actionable rather than statistically pure: the point
 * of `low-cardinality` is "this is a good GROUP BY", not a formal definition.
 */
function deriveFlags(profile: ColumnProfile, rowCount: number): ColumnFlag[] {
  const flags: ColumnFlag[] = [];
  if (rowCount === 0) return flags;

  if (profile.nullFraction >= 0.999) {
    // An all-null column tells you the export is broken; nothing else applies.
    return ["all-null"];
  }

  if (profile.nullFraction === 0) flags.push("no-nulls");
  else if (profile.nullFraction > 0.5) flags.push("mostly-null");

  const nonNull = rowCount - profile.nullCount;
  if (profile.approxDistinct <= 1) {
    flags.push("constant");
  } else if (nonNull > 0 && profile.approxDistinct >= nonNull * 0.99) {
    // approx_unique is an estimate, so "unique" needs tolerance rather than equality.
    flags.push("unique");
  } else if (profile.approxDistinct <= Math.max(50, rowCount * 0.01)) {
    flags.push("low-cardinality");
  }

  return flags;
}

/**
 * Row count for the profile.
 *
 * SUMMARIZE includes a `count` column, which saves a second full scan. Falling back
 * to `countRows` only matters on DuckDB versions that omit it.
 */
async function resolveRowCount(
  engine: QueryEngine,
  table: TableHandle,
  result: { rows: unknown[][] },
  index: Record<string, number>,
): Promise<number> {
  if (table.rowCount != null) return table.rowCount;

  const fromSummarize = num(result.rows[0]?.[index.count]);
  if (fromSummarize != null && fromSummarize > 0) {
    table.rowCount = fromSummarize;
    return fromSummarize;
  }
  return engine.countRows(table.id);
}

/**
 * Map SUMMARIZE's column names to positions.
 *
 * Its output shape has shifted between DuckDB releases, so looking columns up by
 * name and tolerating misses beats indexing by position and silently reading the
 * wrong statistic.
 */
function columnIndex(columns: ColumnInfo[]): Record<string, number> {
  const map: Record<string, number> = {};
  columns.forEach((c, i) => {
    map[c.name.toLowerCase()] = i;
  });
  return new Proxy(map, {
    get: (target, prop: string) => (prop in target ? target[prop] : -1),
  }) as Record<string, number>;
}

function str(value: unknown): string | undefined {
  if (value == null) return undefined;
  const s = String(value);
  return s.length ? s : undefined;
}

function num(value: unknown): number | undefined {
  if (value == null) return undefined;
  const n = typeof value === "number" ? value : Number(String(value).replace(/[%,]/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/** Human-readable one-liner per flag, for tooltips. */
export const FLAG_COPY: Record<ColumnFlag, string> = {
  "all-null": "Every row is empty — this column carries no data.",
  "no-nulls": "No empty values, so filters on this column need no null guard.",
  unique: "Every value is different — a candidate key, safe to join on.",
  constant: "One value across the whole file, usually a leftover export flag.",
  "low-cardinality": "Few distinct values — a good column to GROUP BY or filter on.",
  "mostly-null": "More than half the rows are empty; aggregates will be misleading.",
};

/** Suggested next queries, derived from the profile. Fills a blank editor usefully. */
export function suggestQueries(profile: TableProfile): { label: string; sql: string }[] {
  const t = quoteIdent(profile.tableName);
  const out: { label: string; sql: string }[] = [];

  const groupable = profile.columns.filter((c) => c.flags.includes("low-cardinality"));
  const numeric = profile.columns.filter((c) => /INT|DOUBLE|DECIMAL|FLOAT|BIGINT|HUGEINT/i.test(c.type));
  const keys = profile.columns.filter((c) => c.flags.includes("unique"));

  if (groupable.length > 0) {
    const col = quoteIdent(groupable[0].name);
    out.push({
      label: `Count by ${groupable[0].name}`,
      sql: `SELECT ${col}, count(*) AS n\nFROM ${t}\nGROUP BY ${col}\nORDER BY n DESC;`,
    });
  }

  if (groupable.length > 0 && numeric.length > 0) {
    const g = quoteIdent(groupable[0].name);
    const n = quoteIdent(numeric[0].name);
    out.push({
      label: `${numeric[0].name} by ${groupable[0].name}`,
      sql: `SELECT ${g}, sum(${n}) AS total, avg(${n}) AS mean\nFROM ${t}\nGROUP BY ${g}\nORDER BY total DESC;`,
    });
  }

  if (keys.length > 0) {
    const k = quoteIdent(keys[0].name);
    out.push({
      label: `Check ${keys[0].name} for duplicates`,
      sql: `SELECT ${k}, count(*) AS n\nFROM ${t}\nGROUP BY ${k}\nHAVING count(*) > 1\nORDER BY n DESC;`,
    });
  }

  const nullish = profile.columns.filter((c) => c.flags.includes("mostly-null"));
  if (nullish.length > 0) {
    const c = quoteIdent(nullish[0].name);
    out.push({
      label: `Rows where ${nullish[0].name} is filled in`,
      sql: `SELECT *\nFROM ${t}\nWHERE ${c} IS NOT NULL\nLIMIT 200;`,
    });
  }

  return out;
}
