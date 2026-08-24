// The registry of database dialects Query Studio knows about.
//
// Adding a new database is intentionally a one-line-per-entry change — this is the
// single source of truth used by the dropdowns, the engines, and the SEO copy.
//
// `formatter` maps to a sql-formatter language (null → we can't pretty-print it).
// `parser` maps to a node-sql-parser database (null → we can't build an AST for
// validate/explain). NoSQL dialects have both null and instead declare a `det`
// capability describing the deterministic engine that handles them (see nosql.ts).
// `versions` lists selectable versions, latest first.

export type DialectCategory = "SQL" | "NoSQL";

export interface Dialect {
  id: string;
  label: string;
  category: DialectCategory;
  /** sql-formatter language key, or null if not pretty-printable yet. */
  formatter: string | null;
  /** node-sql-parser database key, or null if not parseable yet. */
  parser: string | null;
  /** Selectable versions, latest first. First entry is the default. */
  versions: string[];
  /** A short accent used for badges — one of the brand palette tokens. */
  accent?: "neon" | "purple" | "yellow";
  /**
   * Deterministic (no-AI, no external service) support for a NoSQL dialect.
   * SQL dialects don't need this — they're deterministic via their parser/formatter.
   * NoSQL dialects are AI-only *unless* they declare capabilities here:
   *  - translateTarget: can be a deterministic target of a SQL→X translation.
   *  - format / validate: can be formatted / validated as the source dialect.
   */
  det?: { translateTarget?: boolean; format?: boolean; validate?: boolean };
}

export const DIALECTS: Dialect[] = [
  // ── SQL ──────────────────────────────────────────────────────────────────
  { id: "mysql", label: "MySQL", category: "SQL", formatter: "mysql", parser: "mysql", versions: ["8.4", "8.0", "5.7"] },
  { id: "postgresql", label: "PostgreSQL", category: "SQL", formatter: "postgresql", parser: "postgresql", versions: ["17", "16", "15", "14", "13"] },
  { id: "sqlite", label: "SQLite", category: "SQL", formatter: "sqlite", parser: "sqlite", versions: ["3.46", "3.45", "3.40"] },
  // MariaDB is a drop-in MySQL fork; node-sql-parser's "mariadb" grammar is
  // incomplete (e.g. it rejects HAVING), so we validate/parse it with the far more
  // complete "mysql" grammar. Formatting still uses the dedicated mariadb profile.
  { id: "mariadb", label: "MariaDB", category: "SQL", formatter: "mariadb", parser: "mysql", versions: ["11.4", "11.0", "10.11"] },
  { id: "sqlserver", label: "SQL Server", category: "SQL", formatter: "transactsql", parser: "transactsql", versions: ["2022", "2019", "2017"] },
  { id: "db2", label: "IBM DB2", category: "SQL", formatter: "db2", parser: "db2", versions: ["11.5", "11.1"] },
  { id: "snowflake", label: "Snowflake", category: "SQL", formatter: "snowflake", parser: "snowflake", versions: ["current"] },
  // Redshift has its own node-sql-parser grammar (it's Postgres-derived).
  { id: "redshift", label: "Amazon Redshift", category: "SQL", formatter: "redshift", parser: "redshift", versions: ["current"] },
  { id: "bigquery", label: "Google BigQuery", category: "SQL", formatter: "bigquery", parser: "bigquery", versions: ["standard"] },
  // DuckDB is intentionally PostgreSQL-compatible, so we parse it with the Postgres
  // grammar (covers everything except a few extensions like QUALIFY).
  { id: "duckdb", label: "DuckDB", category: "SQL", formatter: "duckdb", parser: "postgresql", versions: ["1.1", "1.0"] },
  { id: "spark", label: "Spark SQL", category: "SQL", formatter: "spark", parser: "hive", versions: ["3.5", "3.4", "3.3"] },
  { id: "hive", label: "Hive", category: "SQL", formatter: "hive", parser: "hive", versions: ["4.0", "3.1"] },
  { id: "trino", label: "Trino", category: "SQL", formatter: "trino", parser: "trino", versions: ["latest"] },
  // Presto and Trino are the same SQL dialect (Trino was forked from Presto).
  { id: "presto", label: "Presto", category: "SQL", formatter: "trino", parser: "trino", versions: ["0.288"] },

  // ── NoSQL / other query languages ─────────────────────────────────────────
  // Only dialects with real deterministic (no-AI) support are offered. Everything
  // here works offline for free; there is no AI engine.
  // MongoDB: deterministic SQL→MongoDB translation via @synatic/noql.
  { id: "mongodb", label: "MongoDB Aggregation", category: "NoSQL", formatter: null, parser: null, versions: ["7.0", "6.0"], accent: "purple", det: { translateTarget: true } },
  // Elasticsearch / OpenSearch DSL is JSON → deterministic format + validate.
  { id: "elasticsearch", label: "Elasticsearch DSL", category: "NoSQL", formatter: null, parser: null, versions: ["8.x", "7.x"], accent: "purple", det: { format: true, validate: true } },
  { id: "opensearch", label: "OpenSearch", category: "NoSQL", formatter: null, parser: null, versions: ["2.x"], accent: "purple", det: { format: true, validate: true } },
  // GraphQL: deterministic format + validate via the official graphql package.
  { id: "graphql", label: "GraphQL", category: "NoSQL", formatter: null, parser: null, versions: ["2021"], accent: "purple", det: { format: true, validate: true } },
];

const BY_ID = new Map(DIALECTS.map((d) => [d.id, d]));

export function getDialect(id: string): Dialect | undefined {
  return BY_ID.get(id);
}

export function dialectLabel(id: string): string {
  return BY_ID.get(id)?.label ?? id;
}

export function defaultVersion(id: string): string {
  return BY_ID.get(id)?.versions[0] ?? "";
}

/** Can this NoSQL dialect be used as a *source* (format/validate)? */
export function nosqlSourceDeterministic(id: string): boolean {
  const d = BY_ID.get(id);
  return !!(d?.det?.format || d?.det?.validate);
}

/** Can this NoSQL dialect be a *translate target* (SQL→X)? */
export function nosqlTargetDeterministic(id: string): boolean {
  return !!BY_ID.get(id)?.det?.translateTarget;
}

/**
 * Whether a dialect can be selected in a given role. SQL dialects always can.
 * NoSQL dialects only support the specific role their deterministic engine covers
 * (MongoDB as a translate target; GraphQL / Elasticsearch / OpenSearch as a
 * format/validate source). `role` defaults to "source".
 */
export function supportsRole(id: string, role: "source" | "target" = "source"): boolean {
  const d = BY_ID.get(id);
  if (d?.category !== "NoSQL") return true;
  return role === "target" ? nosqlTargetDeterministic(id) : nosqlSourceDeterministic(id);
}

/** A short label describing what a NoSQL dialect can do (for UI hints). */
export function nosqlCapabilityHint(id: string): string {
  const det = BY_ID.get(id)?.det;
  if (!det) return "";
  if (det.translateTarget) return "translate target";
  const parts: string[] = [];
  if (det.format) parts.push("format");
  if (det.validate) parts.push("validate");
  return parts.join(" · ");
}

export const SQL_DIALECTS = DIALECTS.filter((d) => d.category === "SQL");
export const NOSQL_DIALECTS = DIALECTS.filter((d) => d.category === "NoSQL");

/** Total count used in marketing copy so it never drifts from the registry. */
export const DIALECT_COUNT = DIALECTS.length;
