// Deterministic (no-AI, no external service) engines for a subset of NoSQL dialects:
//   • SQL → MongoDB find/aggregate via @synatic/noql (itself built on node-sql-parser)
//   • GraphQL format + validate via the official `graphql` package (parse/print)
//   • Elasticsearch / OpenSearch DSL (JSON) format + validate via JSON
// These give the most-requested NoSQL conversions for free, instantly, offline.
// Everything here is server-only — imported solely by engine.ts (the API route).
import { parse as gqlParse, print as gqlPrint } from "graphql";
import { getDialect, dialectLabel } from "./databases";
import { detectAdvancedFeatures } from "./parse";
import type { FormatResult, StudioNote, StudioRequest, StudioResult, TranslateResult, ValidateResult } from "./types";

// @synatic/noql ships as CommonJS; normalise the default/namespace shape.
import * as noqlNs from "@synatic/noql";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const SQLParser: any = (noqlNs as { default?: unknown }).default ?? noqlNs;

function cleanErr(e: unknown): string {
  return (e as Error)?.message?.replace(/\s+/g, " ").trim() || "unknown error";
}

// ── MongoDB (SQL → find / aggregate) ─────────────────────────────────────────

/** Serialize a value as a Mongo-shell-style literal: unquoted identifier keys, 2-space indent. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mongoLiteral(v: any, indent = 0): string {
  const pad = "  ".repeat(indent);
  const pad1 = "  ".repeat(indent + 1);
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    return "[\n" + v.map((x) => pad1 + mongoLiteral(x, indent + 1)).join(",\n") + "\n" + pad + "]";
  }
  if (v && typeof v === "object") {
    const keys = Object.keys(v);
    if (keys.length === 0) return "{}";
    return "{\n" + keys.map((k) => {
      const key = /^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k);
      return pad1 + key + ": " + mongoLiteral(v[k], indent + 1);
    }).join(",\n") + "\n" + pad + "}";
  }
  if (typeof v === "string") return JSON.stringify(v);
  return String(v);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function baseCollection(parsed: any): string {
  const c = parsed.collection ?? parsed.collections;
  if (Array.isArray(c)) return c[0] ?? "collection";
  return c ?? "collection";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderMongo(parsed: any): string {
  const coll = baseCollection(parsed);
  if (parsed.type === "query") {
    const args: string[] = [mongoLiteral(parsed.query ?? {})];
    if (parsed.projection && Object.keys(parsed.projection).length) args.push(mongoLiteral(parsed.projection));
    let s = `db.${coll}.find(${args.join(", ")})`;
    if (parsed.sort && Object.keys(parsed.sort).length) s += `.sort(${mongoLiteral(parsed.sort)})`;
    if (parsed.skip) s += `.skip(${parsed.skip})`;
    if (parsed.limit) s += `.limit(${parsed.limit})`;
    return s + ";";
  }
  // Aggregation pipeline.
  return `db.${coll}.aggregate(${mongoLiteral(parsed.pipeline ?? [])});`;
}

// ── NoQL recovery rewrites ───────────────────────────────────────────────────
// NoQL insists on standard-SQL shapes that MySQL/ANSI writers routinely diverge
// from — HAVING that references the SELECT alias (not the repeated aggregate) and
// `LIMIT count OFFSET offset` (not MySQL's `LIMIT offset, count`). Both rewrites are
// semantically identical to the original, so we apply them as a *recovery* only when
// the raw query fails to parse, leaving already-working queries untouched.

const AGG_FN = /\b(COUNT|SUM|AVG|MIN|MAX|TOTAL|GROUP_CONCAT|STDDEV|STDEV|VARIANCE|VAR|BIT_AND|BIT_OR)\s*\(/i;

function unquoteIdent(s: string): string {
  return s.trim().replace(/^[`"[]/, "").replace(/[`"\]]$/, "").trim();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Locate the first top-level occurrence of each SQL clause keyword (ignoring
 *  keywords nested in parens or string/identifier literals). */
function locateClauses(sql: string): { name: string; kwStart: number; contentStart: number }[] {
  const KWS = ["SELECT", "FROM", "WHERE", "GROUP BY", "HAVING", "ORDER BY", "LIMIT", "OFFSET", "FETCH"];
  const found: { name: string; kwStart: number; contentStart: number }[] = [];
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"' || ch === "`") { quote = ch; continue; }
    if (ch === "(") { depth++; continue; }
    if (ch === ")") { depth = Math.max(0, depth - 1); continue; }
    if (depth !== 0) continue;
    const before = i === 0 ? " " : sql[i - 1];
    if (i !== 0 && !/\s/.test(before)) continue;
    const rest = sql.slice(i).toUpperCase();
    for (const kw of KWS) {
      if (rest.startsWith(kw)) {
        const after = sql[i + kw.length];
        if (after === undefined || /\s/.test(after)) {
          found.push({ name: kw, kwStart: i, contentStart: i + kw.length });
          i += kw.length - 1;
          break;
        }
      }
    }
  }
  return found;
}

/** Pull `<aggregate expr> AS <alias>` pairs out of a SELECT list (top-level commas only). */
function aggregateAliases(selectList: string): { expr: string; alias: string }[] {
  const out: { expr: string; alias: string }[] = [];
  const parts: string[] = [];
  let depth = 0, start = 0, quote: string | null = null;
  for (let i = 0; i < selectList.length; i++) {
    const ch = selectList[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"' || ch === "`") { quote = ch; continue; }
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === "," && depth === 0) { parts.push(selectList.slice(start, i)); start = i + 1; }
  }
  parts.push(selectList.slice(start));
  for (const raw of parts) {
    // `expr AS alias` (explicit) or `expr alias` (implicit) — alias is a bare identifier.
    const m = /^([\s\S]+?)\s+(?:AS\s+)?([`"[]?\w+[`"\]]?)\s*$/i.exec(raw.trim());
    if (m && AGG_FN.test(m[1])) out.push({ expr: m[1].trim(), alias: unquoteIdent(m[2]) });
  }
  return out;
}

/** Apply the safe recovery rewrites, reporting what changed (empty = nothing applied). */
function rewriteForNoql(sql: string): { sql: string; changes: string[] } {
  const changes: string[] = [];
  let out = sql;

  // 1) MySQL `LIMIT offset, count` → portable `LIMIT count OFFSET offset`.
  const sh = /\bLIMIT\s+(\d+)\s*,\s*(\d+)/i.exec(out);
  if (sh) {
    out = out.replace(/\bLIMIT\s+\d+\s*,\s*\d+/i, `LIMIT ${sh[2]} OFFSET ${sh[1]}`);
    changes.push(`rewrote MySQL \`LIMIT ${sh[1]}, ${sh[2]}\` to the portable \`LIMIT ${sh[2]} OFFSET ${sh[1]}\``);
  }

  // 2) HAVING <aggregate> → HAVING <select alias>.
  const clauses = locateClauses(out);
  const sel = clauses.find((c) => c.name === "SELECT");
  const from = clauses.find((c) => c.name === "FROM");
  const having = clauses.find((c) => c.name === "HAVING");
  if (sel && from && having && from.kwStart > sel.contentStart && having.contentStart > from.kwStart) {
    const selectList = out.slice(sel.contentStart, from.kwStart);
    const enders = clauses
      .filter((c) => ["ORDER BY", "LIMIT", "OFFSET", "FETCH"].includes(c.name) && c.kwStart > having.contentStart)
      .map((c) => c.kwStart);
    const havingEnd = enders.length ? Math.min(...enders) : out.replace(/;\s*$/, "").length;
    const originalHaving = out.slice(having.contentStart, havingEnd);
    let havingText = originalHaving;
    for (const { expr, alias } of aggregateAliases(selectList)) {
      const pattern = escapeRegex(expr)
        .replace(/\s+/g, "\\s*")
        .replace(/\\\(/g, "\\s*\\(\\s*")
        .replace(/\\\)/g, "\\s*\\)")
        .replace(/,/g, "\\s*,\\s*");
      havingText = havingText.replace(new RegExp(pattern, "gi"), alias);
    }
    if (havingText !== originalHaving) {
      out = out.slice(0, having.contentStart) + havingText + out.slice(havingEnd);
      changes.push("rewrote HAVING to reference the SELECT alias(es) instead of repeating the aggregate");
    }
  }

  return { sql: out, changes };
}

function mongoSuccess(query: string, sourceId: string, extraNotes: StudioNote[] = []): TranslateResult {
  const parsed = SQLParser.parseSQL(query);
  const output = renderMongo(parsed);
  return {
    action: "translate",
    output,
    notes: [
      { kind: "change", message: `Converted ${dialectLabel(sourceId)} SELECT to a MongoDB ${parsed.type === "query" ? "find() query" : "aggregation pipeline"}.` },
      ...extraNotes,
      { kind: "info", message: "Deterministic SQL→MongoDB via the NoQL engine (SELECT statements only — WHERE, JOIN→$lookup, GROUP BY→$group, ORDER BY, LIMIT). Verify field names and types against your collections." },
    ],
  };
}

export function sqlToMongo(query: string, sourceId: string): TranslateResult {
  if (!query.trim()) {
    return { action: "translate", output: "", notes: [{ kind: "info", message: "Nothing to translate yet — write a SQL SELECT to convert to MongoDB." }] };
  }
  try {
    return mongoSuccess(query, sourceId);
  } catch (e) {
    // Recovery: NoQL rejects some valid SQL over shape alone (HAVING that repeats the
    // aggregate, MySQL LIMIT shorthand). Try the safe rewrites and, if they parse,
    // return the pipeline with a note explaining exactly what we adjusted.
    const { sql: rewritten, changes } = rewriteForNoql(query);
    if (changes.length && rewritten !== query) {
      try {
        return mongoSuccess(rewritten, sourceId, [
          { kind: "change", message: `Applied a safe, equivalent rewrite so MongoDB conversion could proceed: ${changes.join("; ")}.` },
        ]);
      } catch {
        /* rewrite didn't help — fall through to the sharp error below */
      }
    }

    // The NoQL grammar covers a practical SELECT subset (WHERE, JOIN→$lookup,
    // GROUP BY→$group, ORDER BY, LIMIT). Postgres-flavoured advanced syntax —
    // WITHIN GROUP, aggregate-internal ORDER BY (e.g. jsonb_object_agg(… ORDER BY …)),
    // jsonb builders, ::casts, window functions — is beyond it. When we can pinpoint
    // which of those the query uses, name each one and its line so the user knows
    // exactly what to remove, rather than emitting a guessed (wrong) pipeline.
    const features = detectAdvancedFeatures(query);
    const raw = cleanErr(e);
    let message: string;
    if (features.length) {
      message = `Couldn't convert this to MongoDB — the deterministic converter maps plain SELECTs only (WHERE, JOIN→$lookup, GROUP BY→$group, ORDER BY, LIMIT). It found ${features.length} construct${features.length === 1 ? "" : "s"} it can't safely map: ${features.map((f) => `${f.label} (line ${f.line})`).join("; ")}. Precompute or remove these, or run the query on your database directly — converting them correctly needs case-by-case judgement, so the tool won't guess a pipeline for you.`;
    } else if (/aggregate function not allowed in where/i.test(raw)) {
      // Almost always a HAVING that references an aggregate not exposed in the SELECT
      // list — the one shape our rewrite can't recover without changing the output.
      message = "Couldn't convert this to MongoDB: the HAVING clause filters on an aggregate that isn't in the SELECT list. Add it as an aliased column (e.g. `COUNT(*) AS n`) and filter on that alias (`HAVING n > 5`) — MongoDB's $group must materialise the value before it can filter on it.";
    } else {
      message = `Couldn't convert this to MongoDB: ${raw}. The converter supports SELECT queries; very complex expressions (some aggregates in HAVING, window functions, CTEs) aren't supported yet — try simplifying the query.`;
    }
    return {
      action: "translate",
      output: "",
      notes: [{ kind: "error", message }],
    };
  }
}

// ── GraphQL (format / validate) ──────────────────────────────────────────────

export function formatGraphQL(query: string): FormatResult {
  if (!query.trim()) return { action: "format", output: "", notes: [{ kind: "info", message: "Nothing to format yet — write a GraphQL query first." }] };
  try {
    return { action: "format", output: gqlPrint(gqlParse(query)), notes: [] };
  } catch (e) {
    return { action: "format", output: "", notes: [{ kind: "error", message: `Not valid GraphQL: ${cleanErr(e)}` }] };
  }
}

export function validateGraphQL(query: string): ValidateResult {
  if (!query.trim()) return { action: "validate", valid: false, notes: [{ kind: "info", message: "Nothing to validate yet — write a GraphQL query first." }] };
  try {
    gqlParse(query);
    return { action: "validate", valid: true, notes: [{ kind: "info", message: "Parsed successfully as valid GraphQL syntax." }, { kind: "info", message: "This checks syntax only — field/type correctness needs your GraphQL schema." }] };
  } catch (e) {
    return { action: "validate", valid: false, notes: [{ kind: "error", message: `Syntax error: ${cleanErr(e)}` }] };
  }
}

// ── Elasticsearch / OpenSearch (JSON DSL: format / validate) ─────────────────

/** ES requests are often written as `GET /index/_search\n{ …json… }`. Split the optional request line off the JSON body. */
function splitEsRequest(query: string): { head: string | null; body: string } {
  const trimmed = query.trim();
  const brace = trimmed.indexOf("{");
  if (brace <= 0) return { head: null, body: trimmed };
  const head = trimmed.slice(0, brace).trim();
  return { head: head || null, body: trimmed.slice(brace) };
}

export function formatEsJson(query: string, dialectId: string): FormatResult {
  if (!query.trim()) return { action: "format", output: "", notes: [{ kind: "info", message: `Nothing to format yet — paste an ${dialectLabel(dialectId)} request first.` }] };
  const { head, body } = splitEsRequest(query);
  try {
    const pretty = JSON.stringify(JSON.parse(body), null, 2);
    return { action: "format", output: (head ? head + "\n" : "") + pretty, notes: [] };
  } catch (e) {
    return { action: "format", output: "", notes: [{ kind: "error", message: `The request body isn't valid JSON: ${cleanErr(e)}. ${dialectLabel(dialectId)} queries are JSON — check for trailing commas or unquoted keys.` }] };
  }
}

export function validateEsJson(query: string, dialectId: string): ValidateResult {
  if (!query.trim()) return { action: "validate", valid: false, notes: [{ kind: "info", message: `Nothing to validate yet — paste an ${dialectLabel(dialectId)} request first.` }] };
  const { body } = splitEsRequest(query);
  try {
    JSON.parse(body);
    return { action: "validate", valid: true, notes: [{ kind: "info", message: `Well-formed JSON — a syntactically valid ${dialectLabel(dialectId)} request body.` }] };
  } catch (e) {
    return { action: "validate", valid: false, notes: [{ kind: "error", message: `Invalid JSON: ${cleanErr(e)}` }] };
  }
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

/**
 * Handle the deterministic NoSQL cases, or return null so the caller falls through
 * to the SQL deterministic engines (which then report the case as unsupported).
 */
export function runNoSqlDeterministic(req: StudioRequest): StudioResult | null {
  const source = getDialect(req.source);
  const target = req.target ? getDialect(req.target) : undefined;

  // SQL → MongoDB translation.
  if (req.action === "translate" && target?.id === "mongodb" && source?.category === "SQL") {
    return sqlToMongo(req.query, req.source);
  }
  // GraphQL / Elasticsearch / OpenSearch format + validate (as source).
  if (req.action === "format") {
    if (req.source === "graphql") return formatGraphQL(req.query);
    if (req.source === "elasticsearch" || req.source === "opensearch") return formatEsJson(req.query, req.source);
  }
  if (req.action === "validate") {
    if (req.source === "graphql") return validateGraphQL(req.query);
    if (req.source === "elasticsearch" || req.source === "opensearch") return validateEsJson(req.query, req.source);
  }
  return null;
}
