// SQL construction for the workbench: turning a registered file into something you
// can put after FROM, and making a user's query safe to render.
//
// Everything here is string-building against DuckDB's dialect. It is deliberately
// separate from the engines so both the WASM and native backends emit identical SQL
// — if a query works in the browser it works on the desktop, which is the whole
// promise of shipping the same tool on four platforms.

import type { FileFormat, TableHandle } from "./types.js";

/**
 * Turn a filename into a SQL identifier.
 *
 * `2024 Sales (final).csv` becomes `sales_final_2024`-ish rather than forcing the
 * user to type `"2024 Sales (final).csv"` with quotes every single time. Leading
 * digits get a `t_` prefix because an identifier cannot start with a number.
 */
export function tableNameFor(fileName: string, taken: ReadonlySet<string> = new Set()): string {
  const base = (fileName.split(/[\\/]/).pop() ?? fileName).replace(/\.[^.]+$/, "");

  let name = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);

  if (!name) name = "data";
  if (/^[0-9]/.test(name)) name = `t_${name}`;
  if (RESERVED.has(name)) name = `${name}_tbl`;

  // Collisions are common — people open `jan/data.csv` and `feb/data.csv` together.
  if (!taken.has(name)) return name;
  let n = 2;
  while (taken.has(`${name}_${n}`)) n++;
  return `${name}_${n}`;
}

/** DuckDB keywords that would break an unquoted FROM. Not exhaustive; the common ones. */
const RESERVED = new Set([
  "select", "from", "where", "group", "order", "table", "join", "left", "right",
  "inner", "outer", "on", "as", "and", "or", "not", "null", "case", "when", "then",
  "else", "end", "union", "all", "distinct", "limit", "offset", "having", "into",
  "values", "insert", "update", "delete", "create", "drop", "alter", "index", "view",
  "with", "using", "natural", "cross", "full", "by", "asc", "desc", "default",
]);

/** Single-quote a string literal for SQL, doubling any embedded quotes. */
export function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Double-quote an identifier, doubling any embedded double quotes. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export interface ScanOptions {
  format: FileFormat;
  /** Field separator for csv/tsv. */
  delimiter?: string;
  /** Whether the first row is a header. Defaults to true for delimited formats. */
  header?: boolean;
  /**
   * Rows DuckDB reads before it commits to a column type.
   *
   * The default of -1 means "read the whole file", which is correct and also means
   * a 20 GB CSV gets scanned twice. 32k rows is enough to get types right on real
   * data and keeps registration effectively instant; a user who hits a mistyped
   * column can raise it.
   */
  sampleSize?: number;
  /** Treat every column as VARCHAR. The escape hatch for messy files. */
  allVarchar?: boolean;
}

/**
 * The DuckDB table function that reads this file.
 *
 * `locator` is whatever the engine registered the bytes under — an OPFS/virtual
 * filename for WASM, an absolute path for native. Both are just strings to DuckDB.
 */
export function buildScanExpression(locator: string, options: ScanOptions): string {
  const path = quoteLiteral(locator);

  switch (options.format) {
    case "parquet":
      return `read_parquet(${path})`;

    case "arrow":
      // DuckDB reads Arrow IPC through the same scan once the file is registered.
      return `read_parquet(${path})`;

    case "json":
      return `read_json(${path}, format='array', ${jsonArgs(options)})`;

    case "ndjson":
      return `read_json(${path}, format='newline_delimited', ${jsonArgs(options)})`;

    case "log":
      // One line per row, no delimiter, no header. The column comes back as `line`,
      // which is what makes `WHERE line LIKE '%ERROR%'` read naturally.
      return `read_csv(${path}, delim=${quoteLiteral("")}, header=false, columns={'line':'VARCHAR'}, quote='', escape='', ignore_errors=true)`;

    case "csv":
    case "tsv":
    default:
      return `read_csv(${path}, ${csvArgs(options)})`;
  }
}

function csvArgs(options: ScanOptions): string {
  const delim = options.delimiter ?? (options.format === "tsv" ? "\t" : ",");
  const parts = [
    `delim=${quoteLiteral(delim)}`,
    `header=${options.header === false ? "false" : "true"}`,
    `sample_size=${options.sampleSize ?? 32_768}`,
    // Without this a single malformed row 8 million lines in kills the whole query.
    // The user gets their data and a warning, rather than an error and nothing.
    "ignore_errors=true",
    "auto_detect=true",
  ];
  if (options.allVarchar) parts.push("all_varchar=true");
  return parts.join(", ");
}

function jsonArgs(options: ScanOptions): string {
  return [
    `sample_size=${options.sampleSize ?? 32_768}`,
    "ignore_errors=true",
    "auto_detect=true",
  ].join(", ");
}

/** `CREATE OR REPLACE VIEW x AS SELECT * FROM read_csv(...)` for a registered file. */
export function buildViewStatement(tableName: string, locator: string, options: ScanOptions): string {
  return `CREATE OR REPLACE VIEW ${quoteIdent(tableName)} AS SELECT * FROM ${buildScanExpression(locator, options)}`;
}

/** `DESCRIBE` output is the cheapest way to get a schema without scanning rows. */
export function buildDescribeStatement(tableName: string): string {
  return `DESCRIBE SELECT * FROM ${quoteIdent(tableName)}`;
}

export function buildCountStatement(tableName: string): string {
  return `SELECT count(*) AS n FROM ${quoteIdent(tableName)}`;
}

/** The query a freshly-dropped file opens with, so the user sees data immediately. */
export function buildPreviewQuery(tableName: string, limit = 100): string {
  return `SELECT *\nFROM ${quoteIdent(tableName)}\nLIMIT ${limit};`;
}

/**
 * Append a LIMIT when the statement is an uncapped SELECT.
 *
 * The UI must never try to render an unbounded result — that is the failure every
 * competing viewer ships. But silently rewriting the user's SQL is rude, so the
 * executed statement comes back on the result and is shown in the UI.
 *
 * Statements that already limit themselves, and anything that is not a SELECT, pass
 * through untouched.
 */
export function applyRowLimit(sql: string, limit: number | null | undefined): string {
  if (limit == null) return sql;

  const trimmed = sql.trim().replace(/;\s*$/, "");
  if (!isSelectLike(trimmed)) return sql;
  if (hasTopLevelLimit(trimmed)) return sql;

  return `${trimmed}\nLIMIT ${Math.max(1, Math.floor(limit))}`;
}

/** SELECT, WITH … SELECT, FROM-first (DuckDB allows it), TABLE, DESCRIBE, SUMMARIZE. */
function isSelectLike(sql: string): boolean {
  return /^\s*(select|with|from|table|describe|summarize|pivot|unpivot)\b/i.test(sql);
}

/**
 * Whether a LIMIT applies to the outermost query.
 *
 * A LIMIT inside a subquery or CTE does not bound the result, so a naive
 * `/limit/i.test()` would let an unbounded outer SELECT through. Scanning from the
 * end at paren-depth zero is the cheap, correct-enough answer; it also has to skip
 * string literals, because `WHERE msg = 'limit reached'` is not a LIMIT clause.
 */
function hasTopLevelLimit(sql: string): boolean {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  const tail: string[] = [];

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];

    if (inSingle) {
      if (ch === "'") inSingle = sql[i + 1] === "'" ? (i++, true) : false;
      continue;
    }
    if (inDouble) {
      if (ch === '"') inDouble = sql[i + 1] === '"' ? (i++, true) : false;
      continue;
    }
    if (ch === "'") { inSingle = true; continue; }
    if (ch === '"') { inDouble = true; continue; }
    if (ch === "(") { depth++; continue; }
    if (ch === ")") { depth--; continue; }

    if (depth === 0) tail.push(ch);
  }

  return /\blimit\s+\d|\blimit\s+all\b/i.test(tail.join(""));
}

/** Statements that change state rather than return rows. Used to pick a result view. */
export function isMutation(sql: string): boolean {
  return /^\s*(create|insert|update|delete|drop|alter|attach|detach|copy|set|install|load|begin|commit|rollback)\b/i.test(sql);
}

/**
 * Split a script into statements on top-level semicolons.
 *
 * Same quote/paren awareness as above — `';'` inside a string literal is data, and
 * splitting on it produces two broken statements.
 */
export function splitStatements(script: string): string[] {
  const out: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < script.length; i++) {
    const ch = script[i];
    const next = script[i + 1];

    if (inLineComment) {
      current += ch;
      if (ch === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      current += ch;
      if (ch === "*" && next === "/") { current += next; i++; inBlockComment = false; }
      continue;
    }
    if (inSingle) {
      current += ch;
      if (ch === "'") { if (next === "'") { current += next; i++; } else inSingle = false; }
      continue;
    }
    if (inDouble) {
      current += ch;
      if (ch === '"') { if (next === '"') { current += next; i++; } else inDouble = false; }
      continue;
    }

    if (ch === "-" && next === "-") { inLineComment = true; current += ch; continue; }
    if (ch === "/" && next === "*") { inBlockComment = true; current += ch; continue; }
    if (ch === "'") { inSingle = true; current += ch; continue; }
    if (ch === '"') { inDouble = true; current += ch; continue; }

    if (ch === ";") {
      if (current.trim()) out.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }

  if (current.trim()) out.push(current.trim());
  return out;
}

/** A starter query joining every registered table is more useful than a blank editor. */
export function buildStarterQuery(tables: TableHandle[]): string {
  if (tables.length === 0) {
    return "-- Drop a CSV, JSON, Parquet or log file to get started.\n";
  }
  const first = tables[0];
  if (tables.length === 1) return buildPreviewQuery(first.name);

  const names = tables.map((t) => quoteIdent(t.name)).join(", ");
  return `-- ${tables.length} tables loaded: ${names}\nSELECT *\nFROM ${quoteIdent(first.name)}\nLIMIT 100;`;
}
