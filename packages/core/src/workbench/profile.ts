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

    // SUMMARIZE reports null_percentage on a 0–100 scale, always. It is tempting to
    // "handle both" by only dividing when the value exceeds 1, but that reads a
    // genuine 1% of nulls as 100% and flags a perfectly good column as all-null.
    const nullFraction = clamp01(nullPct / 100);
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

  await confirmUniqueness(engine, table, columns, rowCount);

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
  } else if (nonNull > 0 && profile.approxDistinct >= nonNull * UNIQUE_CANDIDATE_RATIO) {
    // Only a *candidate*. `approx_unique` is HyperLogLog, and its error on real data
    // runs to several percent in both directions — measured on a 50k-row file it
    // reported 45,031 for a column that was exactly unique and 49,739 for one that
    // was not. Confirmed exactly by `confirmUniqueness` before the badge survives.
    flags.push("unique");
  } else if (profile.approxDistinct <= Math.max(50, rowCount * 0.01)) {
    flags.push("low-cardinality");
  }

  return flags;
}

/**
 * How close to the non-null count an estimate has to be to be worth checking.
 *
 * Loose on purpose: this only decides which columns get an exact count, and missing
 * a real key because HyperLogLog under-counted by 12% is the failure that matters.
 */
const UNIQUE_CANDIDATE_RATIO = 0.8;

/**
 * Replace the estimated `unique` flags with measured ones.
 *
 * The badge means "candidate key, safe to join on", and people act on it — so it has
 * to be true rather than probably true. One extra scan buys that, and it only runs
 * when SUMMARIZE turned up something that might be a key: a file of low-cardinality
 * columns adds no query at all.
 *
 * Everything is counted in a single statement, so the cost is one pass over the file
 * regardless of how many candidates there are.
 */
async function confirmUniqueness(
  engine: QueryEngine,
  table: TableHandle,
  columns: ColumnProfile[],
  rowCount: number,
): Promise<void> {
  const candidates = columns.filter((c) => c.flags.includes("unique"));
  if (candidates.length === 0 || rowCount === 0) return;

  const projections = candidates.flatMap((c, i) => [
    `count(${quoteIdent(c.name)}) AS n_${i}`,
    `count(DISTINCT ${quoteIdent(c.name)}) AS d_${i}`,
  ]);

  let row: unknown[] | undefined;
  try {
    const result = await engine.query(
      `SELECT ${projections.join(", ")} FROM ${quoteIdent(table.name)}`,
      { limit: null },
    );
    row = result.rows[0];
  } catch {
    // A column type DuckDB cannot count DISTINCT on (nested LIST/STRUCT). Dropping
    // the unverified badges is the honest outcome — better no claim than a wrong one.
    for (const c of candidates) c.flags = c.flags.filter((f) => f !== "unique");
    return;
  }

  candidates.forEach((column, i) => {
    const nonNull = num(row?.[i * 2]);
    const distinct = num(row?.[i * 2 + 1]);

    // A column of all one value is constant, not a key, so require more than one.
    const isUnique = nonNull != null && distinct != null && distinct === nonNull && distinct > 1;

    if (isUnique) {
      column.approxDistinct = distinct;
    } else {
      column.flags = column.flags.filter((f) => f !== "unique");
      if (distinct != null) {
        column.approxDistinct = distinct;
        if (distinct <= 1) column.flags.push("constant");
        else if (distinct <= Math.max(50, rowCount * 0.01)) column.flags.push("low-cardinality");
      }
    }
  });
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
