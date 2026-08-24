// Deterministic cross-dialect translator.
//
// This is NOT a full transpiler. What it does is apply a curated set of high-value,
// well-understood rewrites that
// cover the divergences developers hit most often (identifier quoting, row limiting,
// null-coalescing, current-timestamp, …), then re-pretty-print in the target dialect.
// Every rewrite it makes is reported back as a "change" note, and it is honest about
// what it can't verify. Runs server-side only.
import { format as sqlFormat } from "sql-formatter";
import type { SqlLanguage } from "sql-formatter";
import { getDialect, dialectLabel } from "./databases";
import { tryParse, usesAdvancedSyntax } from "./parse";
import type { StudioNote, TranslateResult } from "./types";

type QuoteStyle = "backtick" | "bracket" | "double";
type LimitStyle = "limit" | "top" | "fetch";

function quoteStyle(id: string): QuoteStyle {
  if (id === "mysql" || id === "mariadb") return "backtick";
  if (id === "sqlserver") return "bracket";
  return "double";
}

function limitStyle(id: string): LimitStyle {
  if (id === "sqlserver") return "top";
  if (id === "db2") return "fetch";
  return "limit";
}

function nowIdiom(id: string): string {
  if (id === "sqlserver") return "GETDATE()";
  if (id === "mysql" || id === "mariadb") return "NOW()";
  return "CURRENT_TIMESTAMP";
}

function wrapIdent(name: string, style: QuoteStyle): string {
  if (style === "backtick") return "`" + name + "`";
  if (style === "bracket") return "[" + name + "]";
  return '"' + name + '"';
}

export function runTranslate(query: string, sourceId: string, targetId: string): TranslateResult {
  const notes: StudioNote[] = [];
  const source = getDialect(sourceId);
  const target = getDialect(targetId);

  if (!query.trim()) {
    return { action: "translate", output: "", notes: [{ kind: "info", message: "Nothing to translate yet — write a query first." }] };
  }

  if (source?.category === "NoSQL" || target?.category === "NoSQL") {
    return {
      action: "translate",
      output: query,
      notes: [{ kind: "info", message: `Translating to/from ${(source?.category === "NoSQL" ? source : target)?.label} isn't supported. SQL-to-SQL translation works between every SQL dialect, and SQL can be translated to MongoDB.` }],
    };
  }

  // Verify the input actually parses as the chosen SOURCE dialect. If not, the
  // translation is unreliable — surface a clear error up front.
  const check = tryParse(query, sourceId);
  if (check.supported && !check.ok) {
    notes.push(
      usesAdvancedSyntax(query)
        ? { kind: "warning", message: `Couldn't fully verify this as ${dialectLabel(sourceId)} — it uses advanced syntax our parser doesn't cover (e.g. WITHIN GROUP, JSON aggregates). The translation below is best-effort; double-check the result.` }
        : { kind: "warning", message: `This may not be valid ${dialectLabel(sourceId)} (${check.error}). Check the source dialect — the translation below is best-effort and may be wrong.` },
    );
  } else if (!check.supported) {
    // A dialect without a parser can't be syntax-verified — say so instead of
    // implying success. (Every dialect in the registry currently has a parser, so
    // this branch is a safety net for any future parser-less additions.)
    notes.push({ kind: "warning", message: `Can't verify ${dialectLabel(sourceId)} syntax (no parser available for it yet), so this translation is best-effort. Double-check the result.` });
  }

  if (sourceId === targetId) {
    notes.push({ kind: "info", message: "Source and target are the same dialect — reformatting only." });
  }

  let sql = query;

  // ── 1. Identifier quoting ────────────────────────────────────────────────
  const srcQuote = quoteStyle(sourceId);
  const tgtQuote = quoteStyle(targetId);
  if (srcQuote !== tgtQuote) {
    const patterns: Record<QuoteStyle, RegExp> = {
      backtick: /`([^`]+)`/g,
      bracket: /\[([^\]]+)\]/g,
      double: /"([^"]+)"/g,
    };
    let changed = false;
    sql = sql.replace(patterns[srcQuote], (_m, name) => { changed = true; return wrapIdent(name, tgtQuote); });
    if (changed) {
      const nice: Record<QuoteStyle, string> = { backtick: "backticks", bracket: "square brackets", double: "double quotes" };
      notes.push({ kind: "change", message: `Quoted identifiers converted from ${nice[srcQuote]} to ${nice[tgtQuote]}.` });
    }
  }

  // ── 2. Null coalescing → COALESCE (portable, supported everywhere) ────────
  const nullFns = /\b(IFNULL|ISNULL|NVL)\s*\(/gi;
  if (nullFns.test(sql)) {
    sql = sql.replace(nullFns, "COALESCE(");
    notes.push({ kind: "change", message: "IFNULL / ISNULL / NVL rewritten to the ANSI-standard COALESCE, which every supported database understands." });
  }

  // ── 3. Current timestamp ─────────────────────────────────────────────────
  const targetNow = nowIdiom(targetId);
  // NOTE: the function-form idioms end in `)`, so a trailing \b would never match
  // (`)` is a non-word char followed by whitespace). Only the bare-word forms need a
  // closing boundary — otherwise NOW()/GETDATE() are silently left untranslated.
  const nowVariants = /\b(NOW\s*\(\s*\)|GETDATE\s*\(\s*\)|SYSDATE\b|CURRENT_TIMESTAMP\b)/gi;
  let nowChanged = false;
  sql = sql.replace(nowVariants, (m) => {
    const norm = m.replace(/\s+/g, "").toUpperCase();
    if (norm === targetNow.replace(/\s+/g, "").toUpperCase()) return m;
    nowChanged = true;
    return targetNow;
  });
  if (nowChanged) notes.push({ kind: "change", message: `Current-timestamp expression mapped to ${dialectLabel(targetId)}'s idiom (${targetNow}).` });

  // ── 4. Row limiting: LIMIT ↔ TOP ↔ FETCH ─────────────────────────────────
  sql = translateRowLimit(sql, sourceId, targetId, notes);

  // ── 5. Reformat in the target dialect ────────────────────────────────────
  if (target?.formatter) {
    try {
      sql = sqlFormat(sql, { language: target.formatter as SqlLanguage, keywordCase: "upper", tabWidth: 2 });
    } catch {
      /* keep the unformatted-but-translated SQL */
    }
  }

  notes.push({ kind: "info", message: "Translation covers the most common syntax differences (identifiers, row limiting, null handling, current-timestamp). It doesn't rewrite the full language surface — data types, functions and procedural code — so always test migrated queries." });

  return { action: "translate", output: sql.trim(), notes };
}

// Databases that accept MySQL's `LIMIT offset, count` shorthand.
const SHORTHAND_LIMIT = new Set(["mysql", "mariadb", "sqlite"]);

function translateRowLimit(sql: string, sourceId: string, targetId: string, notes: StudioNote[]): string {
  const src = limitStyle(sourceId);
  const tgt = limitStyle(targetId);

  // MySQL's `LIMIT offset, count` isn't portable — rewrite it to the standard
  // `LIMIT count OFFSET offset` whenever the target doesn't accept the shorthand.
  // This must run even when both dialects are LIMIT-style (e.g. MySQL → PostgreSQL).
  if (SHORTHAND_LIMIT.has(sourceId) && !SHORTHAND_LIMIT.has(targetId)) {
    const sh = /\bLIMIT\s+(\d+)\s*,\s*(\d+)/i.exec(sql);
    if (sh) {
      sql = sql.replace(/\bLIMIT\s+\d+\s*,\s*\d+/i, `LIMIT ${sh[2]} OFFSET ${sh[1]}`);
      notes.push({ kind: "change", message: `MySQL \`LIMIT offset, count\` shorthand rewritten to the portable \`LIMIT ${sh[2]} OFFSET ${sh[1]}\`.` });
    }
  }

  if (src === tgt) return sql;

  // Pull the row count (and any offset) out of the source syntax.
  let count: string | null = null;
  let offset: string | null = null;

  if (src === "limit") {
    // MySQL shorthand `LIMIT offset, count` comes first (both numbers, comma).
    const shorthand = /\bLIMIT\s+(\d+)\s*,\s*(\d+)/i.exec(sql);
    if (shorthand) {
      offset = shorthand[1];
      count = shorthand[2];
    } else {
      const m = /\bLIMIT\s+(\d+)/i.exec(sql);
      if (m) count = m[1];
      const off = /\bOFFSET\s+(\d+)/i.exec(sql);
      if (off) offset = off[1];
    }
  } else if (src === "top") {
    const m = /\bSELECT\s+(?:DISTINCT\s+)?TOP\s*\(?\s*(\d+)\s*\)?/i.exec(sql);
    if (m) count = m[1];
  } else if (src === "fetch") {
    const m = /\bFETCH\s+(?:FIRST|NEXT)\s+(\d+)\s+ROWS?\s+ONLY/i.exec(sql);
    if (m) count = m[1];
    const off = /\bOFFSET\s+(\d+)\s+ROWS?/i.exec(sql);
    if (off) offset = off[1];
  }

  if (!count) return sql; // nothing to convert

  // Remove the source limiter (and its offset) so we can re-emit cleanly.
  if (src === "limit") {
    sql = sql.replace(/\bLIMIT\s+\d+\s*,\s*\d+/i, "").replace(/\bLIMIT\s+\d+/i, "").replace(/\bOFFSET\s+\d+/i, "").trim();
  } else if (src === "top") {
    sql = sql.replace(/(\bSELECT\s+(?:DISTINCT\s+)?)TOP\s*\(?\s*\d+\s*\)?\s*/i, "$1").trim();
  } else if (src === "fetch") {
    sql = sql.replace(/\bFETCH\s+(?:FIRST|NEXT)\s+\d+\s+ROWS?\s+ONLY/i, "").replace(/\bOFFSET\s+\d+\s+ROWS?/i, "").trim();
  }

  // Re-add in the target syntax, preserving any offset.
  if (tgt === "limit") {
    const clause = `LIMIT ${count}` + (offset ? ` OFFSET ${offset}` : "");
    sql = sql.replace(/;?\s*$/, "") + ` ${clause}`;
    notes.push({ kind: "change", message: `Row limiting converted to \`${clause}\`.` });
  } else if (tgt === "top") {
    // SQL Server's TOP can't express an offset. Fall back to the ANSI OFFSET/FETCH
    // form (SQL Server 2012+) when paging, otherwise use the simpler TOP.
    if (offset) {
      const clause = `OFFSET ${offset} ROWS FETCH NEXT ${count} ROWS ONLY`;
      sql = sql.replace(/;?\s*$/, "") + ` ${clause}`;
      notes.push({ kind: "change", message: `Row limiting converted to SQL Server's \`${clause}\` (TOP can't express an offset — this needs an ORDER BY).` });
    } else {
      sql = sql.replace(/(\bSELECT\s+(?:DISTINCT\s+)?)/i, `$1TOP ${count} `);
      notes.push({ kind: "change", message: `Row limiting converted to SQL Server's \`TOP ${count}\` (moved into the SELECT list).` });
    }
  } else if (tgt === "fetch") {
    const clause = (offset ? `OFFSET ${offset} ROWS ` : "") + `FETCH FIRST ${count} ROWS ONLY`;
    sql = sql.replace(/;?\s*$/, "") + ` ${clause}`;
    notes.push({ kind: "change", message: `Row limiting converted to the ANSI \`${clause}\`${offset ? " (needs an ORDER BY)" : ""}.` });
  }

  return sql;
}
