// Deterministic query explainer. Splits a SELECT into its top-level clauses and
// walks them in *logical execution order* (the order the database actually applies
// them, which differs from the written order) with a plain-English note for each.
// Runs server-side only.
import { getDialect, dialectLabel } from "./databases";
import { tryParse, usesAdvancedSyntax } from "./parse";
import type { ExplainResult, ExplainStep, StudioNote } from "./types";

// Top-level clause keywords in the order they appear in written SQL.
const CLAUSE_KEYWORDS = [
  "SELECT",
  "FROM",
  "WHERE",
  "GROUP BY",
  "HAVING",
  "WINDOW",
  "ORDER BY",
  "LIMIT",
  "OFFSET",
  "FETCH",
] as const;

type ClauseName = (typeof CLAUSE_KEYWORDS)[number];

/** Slice a query into its top-level clauses (ignoring keywords inside parens/strings). */
function splitClauses(sql: string): Partial<Record<ClauseName, string>> {
  const found: { name: ClauseName; index: number; len: number }[] = [];
  let depth = 0;
  let quote: string | null = null;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") { quote = ch; continue; }
    if (ch === "(") { depth++; continue; }
    if (ch === ")") { depth = Math.max(0, depth - 1); continue; }
    if (depth !== 0) continue;

    // At depth 0 — test for a clause keyword starting here (word-boundary before).
    const before = i === 0 ? " " : sql[i - 1];
    if (!/\s/.test(before) && i !== 0) continue;
    const rest = sql.slice(i).toUpperCase();
    for (const kw of CLAUSE_KEYWORDS) {
      if (rest.startsWith(kw)) {
        const after = sql[i + kw.length];
        if (after === undefined || /\s/.test(after)) {
          found.push({ name: kw, index: i, len: kw.length });
          i += kw.length - 1;
          break;
        }
      }
    }
  }

  const clauses: Partial<Record<ClauseName, string>> = {};
  for (let k = 0; k < found.length; k++) {
    const start = found[k].index + found[k].len;
    const end = k + 1 < found.length ? found[k + 1].index : sql.length;
    const text = sql.slice(start, end).trim().replace(/;$/, "").trim();
    // First occurrence of each clause wins (subquery clauses are inside parens and skipped).
    if (!(found[k].name in clauses)) clauses[found[k].name] = text;
  }
  return clauses;
}

const CLAUSE_EXPLANATIONS: Record<string, (v: string) => string> = {
  FROM: (v) => `Reads the source rows from ${v ? `\`${v}\`` : "the table(s)"}. Joins are resolved here, combining rows from each table.`,
  WHERE: (v) => `Keeps only rows where ${v ? `\`${v}\`` : "the condition"} is true. Rows that fail are discarded before any grouping.`,
  "GROUP BY": (v) => `Collapses the surviving rows into groups sharing the same ${v ? `\`${v}\`` : "key"}. Aggregate functions (COUNT, SUM…) are computed per group.`,
  HAVING: (v) => `Filters the *groups* by ${v ? `\`${v}\`` : "the condition"} — like WHERE, but it runs after grouping so it can test aggregates.`,
  WINDOW: (v) => `Defines named window frames ${v ? `(${v})` : ""} used by window functions such as ROW_NUMBER() and RANK().`,
  SELECT: (v) => `Projects the output columns${v ? `: \`${v}\`` : ""}. Expressions and window functions are evaluated here.`,
  "ORDER BY": (v) => `Sorts the result set by ${v ? `\`${v}\`` : "the given columns"}. This is one of the last steps, so it sees the final column list.`,
  LIMIT: (v) => `Returns at most ${v ? `${v} ` : ""}rows — applied dead last, after sorting.`,
  OFFSET: (v) => `Skips the first ${v ? `${v} ` : ""}rows before returning results (used for pagination).`,
  FETCH: (v) => `Standard-SQL row limiting (${v ? `${v}` : "FETCH FIRST … ROWS ONLY"}) — applied last, like LIMIT.`,
};

// Logical execution order: the database applies clauses in this sequence, NOT the
// order they are written. This is the single most valuable thing to teach.
const EXECUTION_ORDER: ClauseName[] = [
  "FROM", "WHERE", "GROUP BY", "HAVING", "WINDOW", "SELECT", "ORDER BY", "LIMIT", "OFFSET", "FETCH",
];

export function runExplain(query: string, sourceId: string): ExplainResult {
  if (!query.trim()) {
    return { action: "explain", steps: [], summary: "", notes: [{ kind: "info", message: "Nothing to explain yet — write a query first." }] };
  }

  const dialect = getDialect(sourceId);
  const notes: StudioNote[] = [];

  if (dialect && dialect.category === "NoSQL") {
    return {
      action: "explain",
      steps: [],
      summary: "",
      notes: [{ kind: "info", message: `Step-by-step explanation isn't available for ${dialect.label} — the explainer walks SQL SELECT queries.` }],
    };
  }

  const firstWord = query.trim().split(/\s+/)[0].toUpperCase();
  if (firstWord !== "SELECT" && firstWord !== "WITH") {
    notes.push({ kind: "info", message: `The step-by-step explainer currently walks SELECT queries. This looks like a ${firstWord} statement — try a SELECT, or use Validate.` });
    return { action: "explain", steps: [], summary: "", notes };
  }

  // The explanation is derived from clause structure, not the AST, so a parse failure
  // never blocks it — we just note how confident we are. node-sql-parser rejects a lot
  // of valid advanced SQL, so a failure here is often a parser limitation, not an error.
  const check = tryParse(query, sourceId);
  if (!check.supported) {
    notes.push({ kind: "info", message: `Deep syntax checking for ${dialectLabel(sourceId)} isn't available, so this explanation is based on clause structure only.` });
  } else if (!check.ok) {
    notes.push(
      usesAdvancedSyntax(query)
        ? { kind: "info", message: `Couldn't fully verify this as ${dialectLabel(sourceId)} — it uses advanced syntax our parser doesn't cover (e.g. WITHIN GROUP, JSON aggregates, aggregate ORDER BY). The explanation below reads the top-level clauses directly.` }
        : { kind: "warning", message: `Couldn't parse this as ${dialectLabel(sourceId)} (${check.error}). This may be the wrong dialect or a syntax error — the explanation below is a best-effort read of the clause structure.` },
    );
  }

  const clauses = splitClauses(query);
  const steps: ExplainStep[] = [];
  for (const clause of EXECUTION_ORDER) {
    if (clause in clauses) {
      const value = clauses[clause] ?? "";
      steps.push({ clause, detail: CLAUSE_EXPLANATIONS[clause](value) });
    }
  }

  if (steps.length === 0) {
    notes.push({ kind: "info", message: "Couldn't identify any top-level clauses to walk through. Make sure this is a SELECT query." });
    return { action: "explain", steps: [], summary: "", notes };
  }

  const tables = clauses.FROM?.split(/\bJOIN\b/i)[0]?.split(",").map((t) => t.trim().split(/\s+/)[0]).filter(Boolean) ?? [];
  const hasJoin = /\bJOIN\b/i.test(clauses.FROM ?? "");
  const hasGroup = "GROUP BY" in clauses;

  const parts: string[] = [];
  parts.push(`This query reads from ${tables.length ? tables.map((t) => `\`${t}\``).join(", ") : "one or more tables"}`);
  if (hasJoin) parts.push("combines them with a join");
  if ("WHERE" in clauses) parts.push("filters the rows");
  if (hasGroup) parts.push("groups them and computes aggregates");
  if ("ORDER BY" in clauses) parts.push("sorts the output");
  if ("LIMIT" in clauses || "FETCH" in clauses) parts.push("and caps how many rows come back");
  const summary = (parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0] ?? "") + ".";

  notes.push({ kind: "info", message: "Remember: SQL is written SELECT-first but executed FROM-first. The steps above are in real execution order." });

  return { action: "explain", steps, summary, notes };
}
