// Deterministic query optimizer. Suggests concrete rewrites and index candidates
// from static analysis of the query text. Runs server-side only.
import type { OptimizeResult, StudioNote } from "./types";

function stripNoise(sql: string): string {
  return sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/'(?:[^'\\]|\\.|'')*'/g, "''");
}

/** Pull `table.column` / `column` tokens that appear in WHERE / JOIN … ON as index candidates. */
function indexCandidates(sql: string): string[] {
  const cols = new Set<string>();
  const grab = (clause: string) => {
    const re = /([a-z_][\w]*\.[a-z_][\w]*|\b[a-z_][\w]*)\s*(=|<|>|<=|>=|<>|!=|\bLIKE\b|\bIN\b)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(clause))) {
      const col = m[1];
      if (!/^\d/.test(col) && !["and", "or", "on", "where", "not"].includes(col.toLowerCase())) cols.add(col);
    }
  };
  const where = /\bWHERE\b([\s\S]*?)(\bGROUP\b|\bORDER\b|\bHAVING\b|\bLIMIT\b|;|$)/i.exec(sql)?.[1];
  const ons = [...sql.matchAll(/\bON\b([\s\S]*?)(\bJOIN\b|\bWHERE\b|\bGROUP\b|\bORDER\b|\bLIMIT\b|;|$)/gi)].map((m) => m[1]);
  if (where) grab(where);
  ons.forEach(grab);
  return [...cols];
}

export function runOptimize(query: string): OptimizeResult {
  const notes: StudioNote[] = [];
  if (!query.trim()) {
    return { action: "optimize", suggestions: [], indexes: [], notes: [{ kind: "info", message: "Nothing to optimize yet — write a query first." }] };
  }

  const sql = stripNoise(query);
  const upper = sql.toUpperCase();
  const suggestions: { title: string; detail: string }[] = [];

  if (/\bSELECT\s+\*/i.test(sql)) {
    suggestions.push({ title: "Replace SELECT * with explicit columns", detail: "Return only the columns you need. This reduces I/O, enables covering indexes, and keeps the query stable when the table gains columns." });
  }
  if (/\bIN\s*\(\s*SELECT\b/i.test(upper)) {
    suggestions.push({ title: "Rewrite IN (SELECT …) as a JOIN or EXISTS", detail: "EXISTS can short-circuit and a JOIN gives the planner more freedom, both usually beating a correlated subquery on large tables." });
  }
  if (/\bWHERE\b[\s\S]*\bOR\b/i.test(upper)) {
    suggestions.push({ title: "Collapse OR into IN (…) or UNION ALL", detail: "For the same column, `col = a OR col = b` → `col IN (a, b)`. For different columns, UNION ALL of two index-friendly queries is often faster." });
  }
  if (/\bORDER\s+BY\b/i.test(upper) && !/\bLIMIT\b|\bTOP\b|\bFETCH\b/i.test(upper)) {
    suggestions.push({ title: "Add a row limit to the sort", detail: "If you only need the top rows, LIMIT/TOP/FETCH lets the engine use a top-N sort instead of ordering the whole result set." });
  }
  if (/\bDISTINCT\b/i.test(upper)) {
    suggestions.push({ title: "Question the DISTINCT", detail: "DISTINCT forces a de-duplication pass. Often it hides a join that fans out rows — fixing the join removes the need for it." });
  }
  if (/\bLIKE\s+['\"]%/i.test(query)) {
    suggestions.push({ title: "Avoid the leading wildcard", detail: "`LIKE '%term'` can't use a normal index. Use a full-text/trigram index, or anchor the pattern (`'term%'`)." });
  }
  if (/\bCOUNT\s*\(\s*\*\s*\)/i.test(sql) && /\bLEFT\s+JOIN\b/i.test(upper)) {
    suggestions.push({ title: "Count the right side of the LEFT JOIN", detail: "COUNT(*) counts NULL-padded rows too. COUNT(right_table.pk) counts only matched rows, which is usually what you want." });
  }

  const indexes = indexCandidates(sql).slice(0, 6).map((c) => {
    const [tbl, col] = c.includes(".") ? c.split(".") : ["your_table", c];
    return `CREATE INDEX idx_${tbl}_${col} ON ${tbl} (${col});`;
  });

  if (suggestions.length === 0) suggestions.push({ title: "Query looks lean", detail: "No rule-based rewrites apply. For deeper gains, check the execution plan and make sure the filtered/joined columns are indexed." });
  if (indexes.length) notes.push({ kind: "info", message: "Index suggestions are derived from filtered/joined columns — verify selectivity before creating them; unused indexes slow writes." });
  notes.push({ kind: "info", message: "These are rule-based suggestions from static analysis — always confirm against your real execution plan and data volumes." });

  return { action: "optimize", suggestions, indexes, notes };
}
