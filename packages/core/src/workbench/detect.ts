// Working out what a file actually is, rather than what it claims to be.
//
// Extensions lie constantly in this problem space: exports land as `data.txt` that
// is really TSV, `records.json` that is really NDJSON (one object per line, which is
// *not* valid JSON and makes a strict parser fail on line 2), and `.csv` files that
// are semicolon-separated because they came out of a European Excel. Every one of
// those is a case where a tool that trusts the extension shows the user an error and
// a tool that reads 8 KB shows them their data.
//
// So: sniff first, fall back to the extension, and never guess silently — the
// detected format is surfaced in the UI so the user can override it.

import type { FileFormat } from "./types.js";

/** How many bytes we look at before deciding. Enough for a header plus rows. */
const SNIFF_BYTES = 16_384;

export interface DetectedFormat {
  format: FileFormat;
  /** Field delimiter for csv/tsv. Undefined for the other formats. */
  delimiter?: string;
  /** True when we read the bytes; false when we fell back to the extension alone. */
  sniffed: boolean;
  /** Shown in the UI next to the format badge so the guess is auditable. */
  reason: string;
}

const PARQUET_MAGIC = "PAR1";
const ARROW_MAGIC = "ARROW1";

/** Candidate delimiters, in the order we prefer them when scores tie. */
const DELIMITERS = [
  { char: ",", format: "csv" as const },
  { char: "\t", format: "tsv" as const },
  { char: ";", format: "csv" as const },
  { char: "|", format: "csv" as const },
];

/**
 * Decide a format from the filename and (optionally) the leading bytes.
 *
 * `head` is the first ~16 KB. Callers that have it should pass it; callers that
 * only have a path (the native engine, before it opens anything) can omit it and
 * take the extension-based answer.
 */
export function detectFormat(fileName: string, head?: Uint8Array): DetectedFormat {
  const ext = extensionOf(fileName);

  // Binary formats are unambiguous — check the magic bytes and stop.
  if (head && head.length >= 4) {
    const lead = latin1(head.subarray(0, 8));
    if (lead.startsWith(PARQUET_MAGIC)) {
      return { format: "parquet", sniffed: true, reason: "PAR1 magic bytes" };
    }
    if (lead.startsWith(ARROW_MAGIC)) {
      return { format: "arrow", sniffed: true, reason: "ARROW1 magic bytes" };
    }
  }

  // Extension-only path: no bytes to look at.
  if (!head || head.length === 0) {
    const byExt = formatFromExtension(ext);
    return byExt
      ? { format: byExt.format, delimiter: byExt.delimiter, sniffed: false, reason: `.${ext} extension` }
      : { format: "csv", delimiter: ",", sniffed: false, reason: "defaulted to CSV" };
  }

  const text = decodeUtf8(head);
  const lines = usableLines(text);

  if (lines.length === 0) {
    return { format: "csv", delimiter: ",", sniffed: true, reason: "file appears empty" };
  }

  // JSON family. The distinction that matters is whole-document vs one-per-line,
  // because DuckDB needs to be told which it is.
  const firstChar = text.trimStart()[0];
  if (firstChar === "{" || firstChar === "[") {
    if (looksLikeNdjson(lines)) {
      return { format: "ndjson", sniffed: true, reason: "one JSON object per line" };
    }
    return { format: "json", sniffed: true, reason: `document starts with "${firstChar}"` };
  }

  // Delimited text. Score each candidate on how consistently it splits the sample
  // into the same number of fields — a real CSV has a stable column count, prose
  // that happens to contain commas does not.
  const scored = DELIMITERS.map((d) => ({ ...d, ...scoreDelimiter(lines, d.char) })).sort(
    (a, b) => b.consistency - a.consistency || b.fields - a.fields,
  );

  const best = scored[0];
  if (best && best.fields >= 2 && best.consistency >= 0.75) {
    return {
      format: best.format,
      delimiter: best.char,
      sniffed: true,
      reason: `${best.fields} consistent ${describeDelimiter(best.char)}-separated fields`,
    };
  }

  // Nothing splits cleanly. If the extension insists on a delimited format, honour
  // it; otherwise treat it as a log — one line per row, which is exactly what you
  // want for grepping an nginx or application log with SQL.
  const byExt = formatFromExtension(ext);
  if (byExt && (byExt.format === "csv" || byExt.format === "tsv")) {
    return {
      format: byExt.format,
      delimiter: byExt.delimiter,
      sniffed: true,
      reason: `no clean delimiter found; trusting the .${ext} extension`,
    };
  }

  return { format: "log", sniffed: true, reason: "no delimiter structure — reading as one line per row" };
}

/** Lowercased extension without the dot, or "" when there isn't one. */
export function extensionOf(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

function formatFromExtension(ext: string): { format: FileFormat; delimiter?: string } | null {
  switch (ext) {
    case "csv":
      return { format: "csv", delimiter: "," };
    case "tsv":
    case "tab":
      return { format: "tsv", delimiter: "\t" };
    case "psv":
      return { format: "csv", delimiter: "|" };
    case "json":
      return { format: "json" };
    case "ndjson":
    case "jsonl":
    case "ldjson":
      return { format: "ndjson" };
    case "parquet":
    case "pq":
      return { format: "parquet" };
    case "arrow":
    case "feather":
      return { format: "arrow" };
    case "log":
    case "txt":
    case "out":
      return { format: "log" };
    default:
      return null;
  }
}

/**
 * NDJSON detection: at least two lines that each independently parse as JSON.
 *
 * The "at least two" matters. A single-line file starting with `{` is far more
 * likely to be a minified JSON document than an NDJSON file with one record, and
 * reading it as NDJSON would work but reading it as JSON is more useful.
 */
function looksLikeNdjson(lines: string[]): boolean {
  const candidates = lines.slice(0, 5).filter((l) => l.startsWith("{") || l.startsWith("["));
  if (candidates.length < 2) return false;
  let parsed = 0;
  for (const line of candidates) {
    try {
      JSON.parse(line);
      parsed++;
    } catch {
      // A truncated final line is expected — we only read the first 16 KB.
    }
  }
  return parsed >= 2;
}

/**
 * How well a delimiter explains the sample.
 *
 * `consistency` is the share of lines whose field count matches the most common
 * field count. Quoted fields containing the delimiter are respected, otherwise a
 * CSV with `"Smith, John"` in it would score terribly and lose to whitespace.
 */
function scoreDelimiter(lines: string[], delimiter: string): { fields: number; consistency: number } {
  const counts = lines.slice(0, 20).map((line) => splitRespectingQuotes(line, delimiter).length);
  if (counts.length === 0) return { fields: 0, consistency: 0 };

  const tally = new Map<number, number>();
  for (const c of counts) tally.set(c, (tally.get(c) ?? 0) + 1);

  let modeCount = 0;
  let modeFields = 0;
  for (const [fields, n] of tally) {
    if (n > modeCount) {
      modeCount = n;
      modeFields = fields;
    }
  }
  return { fields: modeFields, consistency: modeCount / counts.length };
}

/** Field-splitting that does not break inside "quoted, values". */
function splitRespectingQuotes(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      // A doubled quote inside a quoted field is an escaped quote, not a close.
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out;
}

/**
 * Complete lines from the sample, minus the last one.
 *
 * The final line of a 16 KB read is almost always cut mid-row, and letting a
 * truncated row into the delimiter scoring drags every candidate's consistency down.
 */
function usableLines(text: string): string[] {
  const all = text.split(/\r?\n/);
  const complete = all.length > 1 ? all.slice(0, -1) : all;
  return complete.map((l) => l.trim()).filter((l) => l.length > 0);
}

function describeDelimiter(ch: string): string {
  if (ch === "\t") return "tab";
  if (ch === ",") return "comma";
  if (ch === ";") return "semicolon";
  if (ch === "|") return "pipe";
  return ch;
}

function latin1(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

function decodeUtf8(bytes: Uint8Array): string {
  // `fatal: false` so a multi-byte character split across the 16 KB boundary
  // degrades to a replacement character instead of throwing away the whole sniff.
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/** Read the leading bytes of a browser File without pulling in the whole thing. */
export async function readHead(file: Blob, bytes = SNIFF_BYTES): Promise<Uint8Array> {
  const slice = file.slice(0, Math.min(bytes, file.size));
  return new Uint8Array(await slice.arrayBuffer());
}

export { SNIFF_BYTES };
