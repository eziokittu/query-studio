// Shared dialect syntax check, built on node-sql-parser. Lets the engines validate
// that the input actually parses as the *selected* dialect, so choosing the wrong
// database for a query surfaces a real error instead of a silent generic result.
import { Parser } from "node-sql-parser";
import { getDialect } from "./databases";

const parser = new Parser();

export interface ParseCheck {
  ok: boolean;
  /** Whether a parser exists for this dialect (false → we couldn't deep-check). */
  supported: boolean;
  error?: string;
}

export function tryParse(query: string, dialectId: string): ParseCheck {
  const dialect = getDialect(dialectId);
  if (!dialect?.parser) return { ok: true, supported: false };
  try {
    parser.astify(query, { database: dialect.parser });
    return { ok: true, supported: true };
  } catch (err) {
    return { ok: false, supported: true, error: (err as Error).message };
  }
}

// node-sql-parser is a real parser but an incomplete one: it rejects plenty of valid,
// advanced SQL (ordered-set aggregates, aggregate ORDER BY / FILTER, rich JSON, etc.).
// When a parse fails we use this to tell "the parser can't handle this feature" apart
// from "the user made a typo", so we can degrade gracefully instead of crying wolf.
//
// Each entry carries a human label so callers can name the exact construct they hit
// (and point at its line) instead of showing a generic "too complex" message. Order
// matters only for readability of the reported list — every match is reported once.
const ADVANCED_SYNTAX: { label: string; re: RegExp }[] = [
  { label: "window function (OVER …)", re: /\bOVER\s*\(/i },
  { label: "WITHIN GROUP ordered-set aggregate", re: /\bWITHIN\s+GROUP\b/i },
  { label: "ORDER BY inside an aggregate call", re: /\b[A-Za-z_]\w*\s*\([^()]*\bORDER\s+BY\b/i },
  { label: "aggregate FILTER (WHERE …)", re: /\bFILTER\s*\(\s*WHERE\b/i },
  { label: "ordered-set / statistical aggregate", re: /\b(PERCENTILE_CONT|PERCENTILE_DISC|MODE|CUME_DIST)\b/i },
  { label: "JSON / JSONB function", re: /\b(JSONB?_[A-Z_]+)\s*\(/i },
  { label: "array/string aggregate", re: /\b(ARRAY_AGG|STRING_AGG|GROUP_CONCAT)\s*\(/i },
  { label: "PostgreSQL JSON operator", re: /->>|->|#>>|#>|@>|<@|\?\||\?&|#-/ },
  { label: "PostgreSQL :: cast", re: /::\s*[A-Za-z]/ },
  { label: "DISTINCT ON", re: /\bDISTINCT\s+ON\b/i },
  { label: "LATERAL join", re: /\bLATERAL\b/i },
  { label: "TABLESAMPLE", re: /\bTABLESAMPLE\b/i },
  { label: "GROUPING SETS / ROLLUP / CUBE", re: /\bGROUPING\s+SETS\b|\bROLLUP\b|\bCUBE\b/i },
];

/** True if the query uses syntax our parser is known to reject even when it's valid. */
export function usesAdvancedSyntax(query: string): boolean {
  return ADVANCED_SYNTAX.some(({ re }) => re.test(query));
}

export interface AdvancedFeature {
  label: string;
  /** 1-based line number of the first occurrence. */
  line: number;
}

/**
 * List the advanced constructs a query uses, each with the line it first appears on,
 * so an engine that can't handle them (e.g. the MongoDB converter) can tell the user
 * exactly what to remove instead of a vague "too complex". Each construct is reported
 * once, in the order listed above.
 */
export function detectAdvancedFeatures(query: string): AdvancedFeature[] {
  const out: AdvancedFeature[] = [];
  for (const { label, re } of ADVANCED_SYNTAX) {
    const m = re.exec(query);
    if (m) out.push({ label, line: query.slice(0, m.index).split("\n").length });
  }
  return out;
}
