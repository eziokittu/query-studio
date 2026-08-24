// Deterministic SQL validator: real AST parsing via node-sql-parser plus a set of
// best-practice heuristics (SELECT *, unguarded UPDATE/DELETE, cartesian joins…).
// Runs server-side only.
import { Parser } from "node-sql-parser";
import { getDialect } from "./databases";
import { usesAdvancedSyntax } from "./parse";
import type { StudioNote, ValidateResult } from "./types";

const parser = new Parser();

// A few node-sql-parser dialect grammars are incomplete and reject perfectly valid,
// standard SQL (e.g. snowflake rejects `DELETE … WHERE`, db2 rejects positional
// `ORDER BY 1`). A hard "Syntax error" on valid SQL is worse than admitting we
// couldn't fully verify it, so when the selected dialect's grammar rejects a query
// we retry against the two most complete grammars. If either accepts it, we treat
// the query as standard SQL that we simply couldn't verify against the exact dialect.
const FALLBACK_PARSERS = ["mysql", "postgresql"] as const;

function parsesAsStandardSql(query: string, exclude: string): boolean {
  for (const db of FALLBACK_PARSERS) {
    if (db === exclude) continue;
    try {
      parser.astify(query, { database: db });
      return true;
    } catch {
      /* try the next one */
    }
  }
  return false;
}

/** Strip comments + string/identifier literals so keyword heuristics don't match inside them. */
function stripNoise(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^'\\]|\\.|'')*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`[^`]*`/g, "``");
}

function heuristics(query: string): StudioNote[] {
  const notes: StudioNote[] = [];
  const clean = stripNoise(query);
  const upper = clean.toUpperCase();

  if (/\bSELECT\s+\*/i.test(clean)) {
    notes.push({ kind: "warning", message: "SELECT * pulls every column — list the columns you need to cut I/O and avoid surprises when the schema changes." });
  }

  // UPDATE / DELETE with no WHERE affects every row.
  for (const kw of ["UPDATE", "DELETE"]) {
    const re = new RegExp(`\\b${kw}\\b`, "i");
    if (re.test(clean) && !/\bWHERE\b/i.test(clean)) {
      notes.push({ kind: "warning", message: `${kw} without a WHERE clause will touch every row in the table — add a filter unless that is truly intended.` });
    }
  }

  // Comma-separated tables in FROM with no join predicate → likely a cartesian product.
  const fromMatch = /\bFROM\b([\s\S]*?)(\bWHERE\b|\bGROUP\b|\bORDER\b|\bHAVING\b|\bLIMIT\b|;|$)/i.exec(clean);
  if (fromMatch) {
    const fromClause = fromMatch[1];
    const hasCommaJoin = /,/.test(fromClause);
    if (hasCommaJoin && !/\bWHERE\b/i.test(upper) && !/\bJOIN\b/i.test(fromClause.toUpperCase())) {
      notes.push({ kind: "warning", message: "Multiple tables joined with commas and no WHERE/ON predicate produces a cartesian product — every row of each table paired with every other." });
    }
  }

  if (/\bLIKE\s+'%/i.test(query)) {
    notes.push({ kind: "info", message: "A LIKE pattern starting with % can't use a normal index — consider a full-text index for large tables." });
  }

  return notes;
}

export function runValidate(query: string, sourceId: string): ValidateResult {
  if (!query.trim()) {
    return { action: "validate", valid: false, notes: [{ kind: "info", message: "Nothing to validate yet — write a query first." }] };
  }

  const dialect = getDialect(sourceId);
  const notes: StudioNote[] = [];
  let valid = true;

  if (dialect?.parser) {
    try {
      parser.astify(query, { database: dialect.parser });
      notes.push({ kind: "info", message: `Parsed successfully as valid ${dialect.label} syntax.` });
    } catch (err) {
      if (parsesAsStandardSql(query, dialect.parser)) {
        // Standard SQL that this dialect's (incomplete) grammar couldn't verify.
        notes.push({ kind: "info", message: `This parses as standard SQL, but couldn't be fully verified against ${dialect.label}'s grammar (our parser's ${dialect.label} support is limited). Best-practice checks still ran.` });
      } else if (usesAdvancedSyntax(query)) {
        // Valid advanced SQL our parser can't handle — don't call it invalid.
        notes.push({ kind: "warning", message: `Couldn't fully verify this query — it uses advanced syntax our parser doesn't cover (e.g. WITHIN GROUP, JSON aggregates, aggregate ORDER BY, ::casts). It may well be valid; best-practice checks still ran.` });
      } else {
        valid = false;
        notes.push({ kind: "error", message: `Syntax error: ${(err as Error).message}` });
      }
    }
  } else {
    notes.push({
      kind: "info",
      message: `Deep syntax checking for ${dialect?.label ?? sourceId} isn't available — running best-practice checks only.`,
    });
  }

  notes.push(...heuristics(query));
  return { action: "validate", valid, notes };
}
