// Contracts for the large-file query workbench.
//
// The workbench runs the same SQL against the same files on three very different
// runtimes — DuckDB-WASM in a browser tab, DuckDB-WASM in a mobile webview, and a
// native DuckDB process behind Electron IPC. Everything above this file is written
// against `QueryEngine` and never learns which one it got, so the React UI in
// apps/web is byte-identical across all three targets.
//
// The one thing callers *do* need to branch on is `EngineCapabilities`, because the
// honest answer to "how big a file can I open?" genuinely differs: WebAssembly has a
// hard 4 GB address space (and needs headroom on top of the file), while the native
// engine is bounded only by the disk. Surfacing that as data rather than hiding it
// is the point — the UI tells you *before* you drop a 12 GB file that this runtime
// cannot take it, and which one can.

/** File formats the workbench can read directly, with no conversion step. */
export type FileFormat =
  | "csv"
  | "tsv"
  | "json"
  | "ndjson"
  | "parquet"
  | "arrow"
  | "log";

/** Which runtime is backing the engine. */
export type EngineKind = "wasm" | "native";

/**
 * What this runtime can actually do.
 *
 * Read as a promise to the user, not a hint: the UI refuses a file that exceeds
 * `maxFileBytes` up front rather than letting DuckDB die halfway through a load,
 * because an out-of-memory crash three minutes into a 6 GB read is the exact
 * experience the competing tools deliver and the one worth not reproducing.
 */
export interface EngineCapabilities {
  kind: EngineKind;
  /**
   * Largest single file this runtime will accept, in bytes.
   *
   * WASM: the 4 GB linear-memory ceiling minus working headroom. DuckDB needs
   * roughly the file size again for its own buffers during a scan, so the usable
   * figure is well under the theoretical maximum.
   *
   * Native: `Number.POSITIVE_INFINITY`. DuckDB memory-maps and spills to disk, so
   * the file never has to fit in RAM at all.
   */
  maxFileBytes: number;
  /** True when results arrive in batches instead of one materialised array. */
  streaming: boolean;
  /** True when registered tables survive a reload (OPFS or a real database file). */
  persistence: boolean;
  /** True when the engine can attach a persistent .duckdb database on disk. */
  attachDatabase: boolean;
  /** Human-readable one-liner for the UI's runtime badge. */
  label: string;
}

/** A column as DuckDB describes it. */
export interface ColumnInfo {
  name: string;
  /** DuckDB's own type name — VARCHAR, BIGINT, TIMESTAMP, DOUBLE, … */
  type: string;
  nullable: boolean;
}

/**
 * A file that has been registered with the engine and is queryable by name.
 *
 * `name` is the SQL identifier — the thing you type in FROM. It is derived from the
 * filename and sanitised, because `2024 sales (final).csv` is not an identifier and
 * making the user quote it every time is a papercut.
 */
export interface TableHandle {
  /** Stable id for UI keys and the share payload. */
  id: string;
  /** SQL identifier: what you write after FROM. */
  name: string;
  /** Original filename, shown in the UI. */
  fileName: string;
  format: FileFormat;
  sizeBytes: number;
  columns: ColumnInfo[];
  /**
   * Exact row count, or null when it has not been computed yet.
   *
   * Counting rows in a 40 GB CSV is itself a full scan, so it is deliberately
   * deferred and requested explicitly rather than run on registration.
   */
  rowCount: number | null;
  /** How the engine addresses the bytes: an OPFS handle name, or an absolute path. */
  locator: string;
}

/** One page of query output. */
export interface QueryResult {
  columns: ColumnInfo[];
  /** Row-major values. JS-native types; BIGINT arrives as a string to stay exact. */
  rows: unknown[][];
  /** Rows in this page. */
  rowCount: number;
  /** True when a LIMIT was appended and more rows exist upstream. */
  truncated: boolean;
  /** Wall-clock milliseconds inside the engine, excluding UI rendering. */
  elapsedMs: number;
  /** The SQL that actually ran, after any limit injection. */
  executedSql: string;
}

/** Options for a single query run. */
export interface QueryOptions {
  /**
   * Cap on rows returned to the UI. The workbench always sets one — rendering
   * 90 million rows into a table is not a feature, and the browser will die first.
   * Pass `null` for an uncapped run (exports use this).
   */
  limit?: number | null;
  /** Aborts a long-running scan. Native honours it; WASM cancels at batch edges. */
  signal?: AbortSignal;
  /** Called with progress updates during long scans, where the runtime reports them. */
  onProgress?: (pct: number) => void;
}

/** Input to `registerFile`, normalised across runtimes. */
export type SourceFile =
  /** Browser and mobile: a File or Blob straight out of a drop or file picker. */
  | { kind: "blob"; file: File; name: string }
  /** Desktop: an absolute path the native engine reads directly, never copied. */
  | { kind: "path"; path: string; name: string; sizeBytes: number };

/**
 * The single interface the whole workbench is written against.
 *
 * Both implementations (`WasmEngine`, `NativeEngine`) satisfy this, and
 * `createEngine()` picks one by sniffing the runtime.
 */
export interface QueryEngine {
  readonly capabilities: EngineCapabilities;

  /** Boot the engine. Idempotent — safe to await from several places at once. */
  init(): Promise<void>;

  /**
   * Make a file queryable. Returns the handle whose `name` you put in FROM.
   *
   * This reads the header and a sample to infer the schema; it does not read the
   * whole file, so registering a 30 GB Parquet is effectively instant.
   */
  registerFile(source: SourceFile): Promise<TableHandle>;

  /** Forget a table and release whatever the runtime was holding for it. */
  unregister(tableId: string): Promise<void>;

  /** Everything currently registered. */
  tables(): TableHandle[];

  /** Run SQL and get one page back. */
  query(sql: string, options?: QueryOptions): Promise<QueryResult>;

  /**
   * Run SQL and receive batches as they are produced.
   *
   * This is how exports and 100-million-row scans stay flat in memory: the caller
   * writes each batch out and never holds the full result.
   */
  stream(
    sql: string,
    onBatch: (batch: QueryResult) => void | Promise<void>,
    options?: QueryOptions,
  ): Promise<void>;

  /** Exact row count for a table, computed on demand and cached on the handle. */
  countRows(tableId: string): Promise<number>;

  /** Release the runtime. */
  dispose(): Promise<void>;
}

/** Thrown when a file is too large for the *current* runtime but fine on another. */
export class FileTooLargeError extends Error {
  constructor(
    readonly sizeBytes: number,
    readonly limitBytes: number,
    readonly kind: EngineKind,
  ) {
    super(
      kind === "wasm"
        ? `This file is ${formatBytes(sizeBytes)}, above the ${formatBytes(limitBytes)} ceiling a browser tab can address. The desktop app reads it natively with no size limit.`
        : `This file is ${formatBytes(sizeBytes)}, above the configured ${formatBytes(limitBytes)} limit.`,
    );
    this.name = "FileTooLargeError";
  }
}

/** Thrown when the file extension and the bytes disagree, or neither is readable. */
export class UnsupportedFormatError extends Error {
  constructor(readonly fileName: string) {
    super(
      `Could not read "${fileName}". The workbench opens CSV, TSV, JSON, NDJSON, Parquet, Arrow and plain log files.`,
    );
    this.name = "UnsupportedFormatError";
  }
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return "unlimited";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
