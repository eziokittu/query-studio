// Exporting results without ever holding them in memory.
//
// The naive export builds one giant string and calls it a day, which caps your
// export at whatever the runtime will let you concatenate — and the whole point of
// this tool is queries whose results are larger than that. So exports go through
// `engine.stream()` and are written batch by batch: memory tracks one batch, not the
// result, and a 40-million-row export costs the same RAM as a 40-row one.
//
// On the desktop the destination is a real file handle. In the browser it is a
// streaming download via the File System Access API where available, falling back to
// an in-memory Blob — with an honest cap on the fallback, because a browser that
// cannot stream genuinely cannot save 8 GB and pretending otherwise just crashes the
// tab at the end of a long wait.

import type { QueryEngine, QueryResult } from "./types.js";

export type ExportFormat = "csv" | "tsv" | "json" | "ndjson";

export interface ExportOptions {
  format: ExportFormat;
  /** Rows to export, or null for everything the query returns. */
  limit?: number | null;
  /** Include a header row for csv/tsv. Defaults to true. */
  header?: boolean;
  signal?: AbortSignal;
  onProgress?: (rowsWritten: number) => void;
}

/** Anything we can push text into, batch by batch. */
export interface TextSink {
  write(chunk: string): void | Promise<void>;
  close(): void | Promise<void>;
}

/** Cap for the non-streaming fallback. Past this the tab dies rather than saves. */
export const FALLBACK_MAX_ROWS = 1_000_000;

/**
 * Run a query and write every row into `sink`.
 *
 * Returns the number of rows written. Cancellation via `options.signal` stops at
 * the next batch boundary and leaves a valid, truncated file rather than a corrupt one.
 */
export async function exportQuery(
  engine: QueryEngine,
  sql: string,
  sink: TextSink,
  options: ExportOptions,
): Promise<number> {
  const { format, header = true } = options;
  let rowsWritten = 0;
  let wroteHeader = false;
  let firstJsonRow = true;

  if (format === "json") await sink.write("[\n");

  await engine.stream(
    sql,
    async (batch: QueryResult) => {
      if (options.signal?.aborted) return;

      if (format === "csv" || format === "tsv") {
        const delimiter = format === "tsv" ? "\t" : ",";
        if (header && !wroteHeader) {
          await sink.write(`${batch.columns.map((c) => escapeDelimited(c.name, delimiter)).join(delimiter)}\n`);
          wroteHeader = true;
        }
        for (const row of batch.rows) {
          await sink.write(`${row.map((v) => escapeDelimited(stringify(v), delimiter)).join(delimiter)}\n`);
        }
      } else {
        const names = batch.columns.map((c) => c.name);
        for (const row of batch.rows) {
          const obj: Record<string, unknown> = {};
          names.forEach((n, i) => {
            obj[n] = row[i];
          });
          const line = JSON.stringify(obj);
          if (format === "ndjson") {
            await sink.write(`${line}\n`);
          } else {
            await sink.write(firstJsonRow ? `  ${line}` : `,\n  ${line}`);
            firstJsonRow = false;
          }
        }
      }

      rowsWritten += batch.rows.length;
      options.onProgress?.(rowsWritten);
    },
    { limit: options.limit ?? null, signal: options.signal },
  );

  if (format === "json") await sink.write("\n]\n");
  await sink.close();
  return rowsWritten;
}

/**
 * A sink that streams straight to disk through the File System Access API.
 *
 * Returns null when the browser lacks it (Firefox, Safari at time of writing), so
 * the caller can fall back rather than this throwing mid-export.
 */
export async function createFileSink(suggestedName: string): Promise<TextSink | null> {
  const picker = (globalThis as { showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle> })
    .showSaveFilePicker;
  if (!picker) return null;

  try {
    const handle = await picker({
      suggestedName,
      types: [{ description: "Data file", accept: { "text/plain": [extensionOf(suggestedName)] } }],
    });
    const writable = await (handle as unknown as {
      createWritable(): Promise<{ write(c: string): Promise<void>; close(): Promise<void> }>;
    }).createWritable();

    return {
      write: (chunk) => writable.write(chunk),
      close: () => writable.close(),
    };
  } catch {
    // The user dismissed the picker. Not an error worth surfacing.
    return null;
  }
}

/** Buffering sink for browsers without the File System Access API. */
export function createBlobSink(fileName: string, mime = "text/plain"): TextSink & {
  finish(): Blob;
  download(): void;
} {
  const chunks: string[] = [];
  let blob: Blob | null = null;

  return {
    write(chunk) {
      chunks.push(chunk);
    },
    close() {
      blob = new Blob(chunks, { type: mime });
      chunks.length = 0;
    },
    finish() {
      if (!blob) blob = new Blob(chunks, { type: mime });
      return blob;
    },
    download() {
      const b = this.finish();
      const url = URL.createObjectURL(b);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      a.click();
      // Revoking immediately can cancel the download in some browsers.
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    },
  };
}

export function mimeFor(format: ExportFormat): string {
  switch (format) {
    case "csv": return "text/csv";
    case "tsv": return "text/tab-separated-values";
    case "json": return "application/json";
    case "ndjson": return "application/x-ndjson";
  }
}

export function extensionFor(format: ExportFormat): string {
  return format === "ndjson" ? "ndjson" : format;
}

/**
 * RFC 4180 quoting: quote when the value contains the delimiter, a quote or a
 * newline, and double any embedded quotes.
 */
function escapeDelimited(value: string, delimiter: string): string {
  if (value === "") return "";
  const needsQuotes = value.includes(delimiter) || value.includes('"') || /[\r\n]/.test(value);
  return needsQuotes ? `"${value.replace(/"/g, '""')}"` : value;
}

function stringify(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(dot) : ".txt";
}
