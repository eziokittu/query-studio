// Deterministic SQL formatter — beautify or compress — built on sql-formatter.
// Runs server-side (imported only by the API route).
import { format as sqlFormat } from "sql-formatter";
import type { SqlLanguage } from "sql-formatter";
import { getDialect } from "./databases";
import type { FormatResult, StudioNote } from "./types";

/** Collapse a query onto as few lines as possible (whitespace-safe). */
function compress(sql: string): string {
  return sql
    // Drop -- line comments and /* */ block comments.
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    // Collapse all runs of whitespace to a single space.
    .replace(/\s+/g, " ")
    // Tighten spaces around punctuation.
    .replace(/\s*([(),;])\s*/g, "$1")
    .replace(/\(\s+/g, "(")
    .trim();
}

export function runFormat(
  query: string,
  sourceId: string,
  mode: "beautify" | "compress" = "beautify",
): FormatResult {
  const notes: StudioNote[] = [];
  const dialect = getDialect(sourceId);

  if (!query.trim()) {
    return { action: "format", output: "", notes: [{ kind: "info", message: "Nothing to format yet — write a query first." }] };
  }

  if (mode === "compress") {
    return { action: "format", output: compress(query), notes };
  }

  if (!dialect?.formatter) {
    notes.push({
      kind: "warning",
      message: `${dialect?.label ?? sourceId} can't be pretty-printed for this dialect. Showing a whitespace-normalised version.`,
    });
    return { action: "format", output: compress(query), notes };
  }

  try {
    const output = sqlFormat(query, {
      language: dialect.formatter as SqlLanguage,
      keywordCase: "upper",
      tabWidth: 2,
      linesBetweenQueries: 2,
    });
    return { action: "format", output, notes };
  } catch (err) {
    notes.push({
      kind: "warning",
      message: `Couldn't fully parse this as ${dialect.label}; applied a best-effort format. ${(err as Error).message}`,
    });
    return { action: "format", output: compress(query), notes };
  }
}
