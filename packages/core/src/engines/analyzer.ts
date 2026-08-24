// Deterministic performance analyzer. Scans a query for well-known performance and
// correctness smells, assigns a severity to each, and rolls them up into a 0–100
// score + letter grade. No database connection needed — these are static heuristics.
// Runs server-side only.
import type { AnalyzeIssue, AnalyzeResult, StudioNote } from "./types";

function stripNoise(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^'\\]|\\.|'')*'/g, "''");
}

const PENALTY: Record<AnalyzeIssue["severity"], number> = { high: 30, medium: 15, low: 6, good: 0 };

export function runAnalyze(query: string): AnalyzeResult {
  const notes: StudioNote[] = [];
  if (!query.trim()) {
    return { action: "analyze", score: 0, grade: "—", issues: [], notes: [{ kind: "info", message: "Nothing to analyze yet — write a query first." }] };
  }

  const sql = stripNoise(query);
  const upper = sql.toUpperCase();
  const issues: AnalyzeIssue[] = [];

  if (/\bSELECT\s+\*/i.test(sql)) {
    issues.push({ severity: "medium", title: "SELECT * projects every column", detail: "Reading all columns increases I/O and network transfer and breaks covering indexes. List only the columns you actually use." });
  }
  for (const kw of ["UPDATE", "DELETE"]) {
    if (new RegExp(`\\b${kw}\\b`, "i").test(sql) && !/\bWHERE\b/i.test(sql)) {
      issues.push({ severity: "high", title: `${kw} without WHERE`, detail: `This ${kw} scans and rewrites the entire table. Add a WHERE clause unless a full-table operation is intended.` });
    }
  }
  // Comma joins without a predicate → cartesian product.
  const fromClause = /\bFROM\b([\s\S]*?)(\bWHERE\b|\bGROUP\b|\bORDER\b|\bHAVING\b|\bLIMIT\b|;|$)/i.exec(sql)?.[1] ?? "";
  if (/,/.test(fromClause) && !/\bJOIN\b/i.test(fromClause.toUpperCase()) && !/\bWHERE\b/i.test(upper)) {
    issues.push({ severity: "high", title: "Possible cartesian join", detail: "Tables are combined with commas but there is no join predicate, so every row is paired with every other row. Use explicit JOIN … ON." });
  }
  if (/\bLIKE\s+'%/i.test(query) || /\bLIKE\s+"%/i.test(query)) {
    issues.push({ severity: "medium", title: "Leading-wildcard LIKE", detail: "A pattern that starts with % cannot use a B-tree index and forces a full scan. Consider a full-text index or a trailing-only wildcard." });
  }
  // Function applied to a column in WHERE → non-sargable.
  if (/\bWHERE\b[\s\S]*\b(LOWER|UPPER|DATE|YEAR|MONTH|CAST|CONVERT|SUBSTR|SUBSTRING|TRIM)\s*\(\s*[a-z_][\w.]*\s*\)/i.test(sql)) {
    issues.push({ severity: "medium", title: "Non-sargable predicate", detail: "Wrapping a column in a function inside WHERE prevents index use. Move the transformation to the constant side or store a computed column." });
  }
  if (/\bOR\b/i.test(fromClause) === false && /\bWHERE\b[\s\S]*\bOR\b/i.test(upper)) {
    issues.push({ severity: "low", title: "OR in WHERE", detail: "OR conditions can defeat index usage. If the branches target the same column, IN (…) is often faster; otherwise consider UNION ALL." });
  }
  if (/\bSELECT\b[\s\S]*\bSELECT\b/i.test(upper) && /\bIN\s*\(\s*SELECT\b/i.test(upper)) {
    issues.push({ severity: "low", title: "Correlated / nested subquery", detail: "IN (SELECT …) can run once per row. A JOIN or EXISTS is frequently faster and lets the planner optimize better." });
  }
  if (/\bORDER\s+BY\b/i.test(upper) && !/\bLIMIT\b/i.test(upper) && !/\bTOP\b/i.test(upper) && !/\bFETCH\b/i.test(upper)) {
    issues.push({ severity: "low", title: "ORDER BY without a row limit", detail: "Sorting the full result set is expensive when you only need the top rows. Add LIMIT/TOP/FETCH if appropriate." });
  }
  if (/\bDISTINCT\b/i.test(upper) && /\bGROUP\s+BY\b/i.test(upper)) {
    issues.push({ severity: "low", title: "DISTINCT together with GROUP BY", detail: "GROUP BY already produces distinct groups, so DISTINCT is usually redundant work." });
  }

  if (issues.length === 0) {
    issues.push({ severity: "good", title: "No obvious performance smells", detail: "This query passes the static best-practice checks. Real-world performance still depends on indexes, data volume and the execution plan." });
  }

  const penalty = issues.reduce((sum, i) => sum + PENALTY[i.severity], 0);
  const score = Math.max(0, Math.min(100, 100 - penalty));
  const grade = score >= 95 ? "A+" : score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 55 ? "D" : "F";

  notes.push({ kind: "info", message: "Scores are heuristic — they flag common anti-patterns but can't replace EXPLAIN ANALYZE on your real data." });
  return { action: "analyze", score, grade, issues, notes };
}
