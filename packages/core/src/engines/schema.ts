// Schema → ER diagram engine. Parses CREATE TABLE statements (dialect-agnostic, via
// a forgiving hand-rolled parser rather than a strict SQL grammar) into tables,
// columns and foreign-key relations. The client renders the actual diagram.
// Runs server-side only.
import type { SchemaColumn, SchemaRelation, SchemaResult, SchemaTable, StudioNote } from "./types";

function unquote(s: string): string {
  return s.trim().replace(/^[`"\[]/, "").replace(/[`"\]]$/, "").trim();
}

/** Split on top-level commas (ignoring commas inside parentheses). */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) { parts.push(body.slice(start, i)); start = i + 1; }
  }
  parts.push(body.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Extract each CREATE TABLE name + its parenthesised body via balanced-paren scan. */
function findTables(sql: string): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = [];
  const re = /CREATE\s+(?:TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"\[]?[\w.]+[`"\]]?)\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) {
    const name = unquote(m[1]).split(".").pop()!;
    let depth = 1, i = re.lastIndex;
    for (; i < sql.length && depth > 0; i++) {
      if (sql[i] === "(") depth++;
      else if (sql[i] === ")") depth--;
    }
    out.push({ name, body: sql.slice(re.lastIndex, i - 1) });
    re.lastIndex = i;
  }
  return out;
}

const CONSTRAINT_START = /^(PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CONSTRAINT|CHECK|KEY|INDEX)\b/i;

export function runSchema(query: string): SchemaResult {
  if (!query.trim()) {
    return { action: "schema", tables: [], relations: [], notes: [{ kind: "info", message: "Paste one or more CREATE TABLE statements to generate a diagram." }] };
  }

  const sql = query.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
  const found = findTables(sql);
  const tables: SchemaTable[] = [];
  const relations: SchemaRelation[] = [];

  for (const { name, body } of found) {
    const columns: SchemaColumn[] = [];
    const pkCols = new Set<string>();

    for (const item of splitTopLevel(body)) {
      // Table-level PRIMARY KEY (col, …)
      const pkMatch = /^PRIMARY\s+KEY\s*\(([^)]+)\)/i.exec(item);
      if (pkMatch) { pkMatch[1].split(",").forEach((c) => pkCols.add(unquote(c))); continue; }

      // Table-level FOREIGN KEY (col) REFERENCES other(col)
      const fkMatch = /FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+([`"\[]?[\w.]+[`"\]]?)\s*\(([^)]+)\)/i.exec(item);
      if (fkMatch) {
        const fromColumn = unquote(fkMatch[1].split(",")[0]);
        relations.push({ fromTable: name, fromColumn, toTable: unquote(fkMatch[2]).split(".").pop()!, toColumn: unquote(fkMatch[3].split(",")[0]) });
        continue;
      }

      // Skip other table-level constraints.
      if (CONSTRAINT_START.test(item)) continue;

      // Column definition: name type [modifiers…]
      const tokMatch = /^([`"\[]?[\w]+[`"\]]?)\s+([\s\S]+)$/.exec(item);
      if (!tokMatch) continue;
      const colName = unquote(tokMatch[1]);
      const rest = tokMatch[2];
      const type = (rest.match(/^([\w]+(?:\s*\([^)]*\))?(?:\s+(?:UNSIGNED|VARYING))?)/i)?.[1] ?? rest.split(/\s+/)[0]).trim();
      const isPk = /\bPRIMARY\s+KEY\b/i.test(rest);
      if (isPk) pkCols.add(colName);
      const nullable = !/\bNOT\s+NULL\b/i.test(rest) && !isPk;

      // Inline REFERENCES other(col)
      const inlineFk = /\bREFERENCES\s+([`"\[]?[\w.]+[`"\]]?)\s*\(([^)]+)\)/i.exec(rest);
      if (inlineFk) relations.push({ fromTable: name, fromColumn: colName, toTable: unquote(inlineFk[1]).split(".").pop()!, toColumn: unquote(inlineFk[2].split(",")[0]) });

      columns.push({ name: colName, type, pk: isPk, fk: !!inlineFk, nullable });
    }

    // Fold table-level PKs back onto their columns.
    for (const col of columns) if (pkCols.has(col.name)) col.pk = true;
    // Flag FK columns discovered at table level.
    for (const rel of relations.filter((r) => r.fromTable === name)) {
      const col = columns.find((c) => c.name === rel.fromColumn);
      if (col) col.fk = true;
    }

    tables.push({ name, columns });
  }

  const notes: StudioNote[] = [];
  if (tables.length === 0) {
    notes.push({ kind: "warning", message: "No CREATE TABLE statements found. Paste a schema (DDL) — the diagram is built from CREATE TABLE definitions." });
  } else {
    notes.push({ kind: "info", message: `Parsed ${tables.length} table${tables.length === 1 ? "" : "s"} and ${relations.length} relationship${relations.length === 1 ? "" : "s"}.` });
  }

  return { action: "schema", tables, relations, notes };
}
