// DuckDB-WASM engine — the browser and mobile backend.
//
// The single decision that makes this competitive with a desktop tool is
// `DuckDBDataProtocol.BROWSER_FILEREADER`. The obvious way to hand a dropped file to
// DuckDB-WASM is `registerFileBuffer`, which reads the whole thing into an
// ArrayBuffer and copies it into WASM linear memory — at which point a 1.5 GB CSV
// needs 1.5 GB for the buffer plus DuckDB's own working set, and you hit the 4 GB
// wall well before the file does. Registering the `File` *handle* instead lets
// DuckDB issue range reads against the browser's own file object and stream the
// scan, so memory tracks the query's working set rather than the file size.
//
// That is why the ceiling advertised here is a working-set estimate rather than a
// file-size cap, and why a 3 GB Parquet aggregate can run in a tab that a
// buffer-copying implementation could not survive.

import {
  type ColumnInfo,
  type EngineCapabilities,
  type QueryEngine,
  type QueryOptions,
  type QueryResult,
  type SourceFile,
  type TableHandle,
  FileTooLargeError,
  UnsupportedFormatError,
} from "./types.js";
import { detectFormat, readHead } from "./detect.js";
import {
  applyRowLimit,
  buildCountStatement,
  buildDescribeStatement,
  buildViewStatement,
  quoteIdent,
  tableNameFor,
} from "./sql.js";

/**
 * Where the .wasm and worker assets come from.
 *
 * The default pulls DuckDB's jsDelivr bundles, which is the zero-config path. Any
 * app that needs to work offline — the desktop shell, the mobile shell, and
 * glitchbong under a strict CSP — passes `selfHosted()` and serves the files itself.
 */
export interface WasmBundle {
  mainModule: string;
  mainWorker: string;
  pthreadWorker?: string | null;
}

export interface WasmEngineOptions {
  /** Supply the bundle explicitly. Omit to auto-select from jsDelivr. */
  bundle?: WasmBundle;
  /**
   * Working-set ceiling in bytes, used for the pre-flight size check.
   *
   * Not the file size limit — see the note at the top. Files are streamed, so this
   * is about how much DuckDB needs in flight. 3.5 GB leaves headroom under the
   * 4 GB WASM address space for the runtime itself.
   */
  memoryCeilingBytes?: number;
  /** Route DuckDB's own logs somewhere. Defaults to silence. */
  onLog?: (message: string) => void;
}

const DEFAULT_CEILING = 3.5 * 1024 * 1024 * 1024;

/** Build a bundle descriptor pointing at files the app serves itself. */
export function selfHosted(baseUrl: string): WasmBundle {
  const base = baseUrl.replace(/\/$/, "");
  return {
    mainModule: `${base}/duckdb-eh.wasm`,
    mainWorker: `${base}/duckdb-browser-eh.worker.js`,
    pthreadWorker: null,
  };
}

interface DuckDbModule {
  AsyncDuckDB: new (logger: unknown, worker: Worker) => AsyncDuckDb;
  ConsoleLogger: new () => unknown;
  VoidLogger: new () => unknown;
  getJsDelivrBundles: () => unknown;
  selectBundle: (bundles: unknown) => Promise<WasmBundle>;
  DuckDBDataProtocol: { BROWSER_FILEREADER: number };
}

interface AsyncDuckDb {
  instantiate(mainModule: string, pthreadWorker?: string | null): Promise<void>;
  connect(): Promise<DuckDbConnection>;
  registerFileHandle(name: string, handle: unknown, protocol: number, directIo: boolean): Promise<void>;
  dropFile(name: string): Promise<void>;
  terminate(): Promise<void>;
}

interface DuckDbConnection {
  query(sql: string): Promise<ArrowTable>;
  send(sql: string): Promise<AsyncIterable<ArrowTable>>;
  close(): Promise<void>;
  cancelSent?(): Promise<boolean>;
}

interface ArrowField {
  name: string;
  type: { toString(): string };
  nullable: boolean;
}

interface ArrowTable {
  schema: { fields: ArrowField[] };
  numRows: number;
  toArray(): Record<string, unknown>[];
}

export class WasmEngine implements QueryEngine {
  readonly capabilities: EngineCapabilities;

  private duckdb: DuckDbModule | null = null;
  private db: AsyncDuckDb | null = null;
  private conn: DuckDbConnection | null = null;
  private initPromise: Promise<void> | null = null;
  private readonly handles = new Map<string, TableHandle>();
  private readonly options: WasmEngineOptions;

  constructor(options: WasmEngineOptions = {}) {
    this.options = options;
    const ceiling = options.memoryCeilingBytes ?? DEFAULT_CEILING;
    this.capabilities = {
      kind: "wasm",
      maxFileBytes: ceiling,
      streaming: true,
      persistence: false,
      attachDatabase: false,
      label: "In-browser (DuckDB-WASM)",
    };
  }

  /** Idempotent: concurrent callers share one boot. */
  init(): Promise<void> {
    if (!this.initPromise) this.initPromise = this.boot();
    return this.initPromise;
  }

  private async boot(): Promise<void> {
    // Dynamic so DuckDB (several MB) never lands in the initial bundle. A user who
    // only came for the SQL translator never downloads the database engine.
    const duckdb = (await import("@duckdb/duckdb-wasm")) as unknown as DuckDbModule;
    this.duckdb = duckdb;

    const bundle = this.options.bundle ?? (await duckdb.selectBundle(duckdb.getJsDelivrBundles()));

    // A same-origin worker script is required under most CSPs, and the blob shim is
    // the standard way to get one when the asset is served from elsewhere.
    const workerUrl = URL.createObjectURL(
      new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" }),
    );
    const worker = new Worker(workerUrl);
    const logger = this.options.onLog ? new duckdb.ConsoleLogger() : new duckdb.VoidLogger();

    const db = new duckdb.AsyncDuckDB(logger, worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker ?? null);
    URL.revokeObjectURL(workerUrl);

    this.db = db;
    this.conn = await db.connect();
  }

  async registerFile(source: SourceFile): Promise<TableHandle> {
    await this.init();
    if (source.kind !== "blob") {
      throw new Error("The in-browser engine takes a File. Paths are desktop-only.");
    }

    const { file, name } = source;
    if (file.size > this.capabilities.maxFileBytes) {
      throw new FileTooLargeError(file.size, this.capabilities.maxFileBytes, "wasm");
    }

    const head = await readHead(file);
    const detected = detectFormat(name, head);
    if (!detected.format) throw new UnsupportedFormatError(name);

    const taken = new Set([...this.handles.values()].map((h) => h.name));
    const tableName = tableNameFor(name, taken);
    // DuckDB addresses the bytes by this virtual filename; keeping the real
    // extension on it means DuckDB's own auto-detection agrees with ours.
    const locator = `${tableName}.${detected.format === "tsv" ? "tsv" : detected.format}`;

    const db = this.db!;
    const duckdb = this.duckdb!;

    // The important line: hand over the handle, not the bytes.
    await db.registerFileHandle(locator, file, duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, true);

    const scanOptions = { format: detected.format, delimiter: detected.delimiter };
    await this.exec(buildViewStatement(tableName, locator, scanOptions));

    const columns = await this.describe(tableName);

    const handle: TableHandle = {
      id: `${tableName}-${Date.now().toString(36)}`,
      name: tableName,
      fileName: name,
      format: detected.format,
      sizeBytes: file.size,
      columns,
      rowCount: null,
      locator,
    };
    this.handles.set(handle.id, handle);
    return handle;
  }

  async unregister(tableId: string): Promise<void> {
    const handle = this.handles.get(tableId);
    if (!handle) return;
    await this.exec(`DROP VIEW IF EXISTS ${quoteIdent(handle.name)}`);
    await this.db?.dropFile(handle.locator).catch(() => {
      // Already gone, or DuckDB never took it. Nothing to recover from.
    });
    this.handles.delete(tableId);
  }

  tables(): TableHandle[] {
    return [...this.handles.values()];
  }

  async query(sql: string, options: QueryOptions = {}): Promise<QueryResult> {
    await this.init();
    const executedSql = applyRowLimit(sql, options.limit === undefined ? 1000 : options.limit);
    const started = performance.now();
    const table = await this.conn!.query(executedSql);
    const elapsedMs = performance.now() - started;

    const columns = arrowColumns(table);
    const rows = arrowRows(table, columns);

    return {
      columns,
      rows,
      rowCount: rows.length,
      truncated: executedSql !== sql.trim().replace(/;\s*$/, ""),
      elapsedMs,
      executedSql,
    };
  }

  async stream(
    sql: string,
    onBatch: (batch: QueryResult) => void | Promise<void>,
    options: QueryOptions = {},
  ): Promise<void> {
    await this.init();
    const executedSql = applyRowLimit(sql, options.limit ?? null);
    const started = performance.now();
    const reader = await this.conn!.send(executedSql);

    for await (const batch of reader) {
      if (options.signal?.aborted) {
        // DuckDB-WASM cancels between batches rather than mid-scan; close enough
        // that a runaway query stops within a few hundred milliseconds.
        await this.conn!.cancelSent?.();
        return;
      }
      const columns = arrowColumns(batch);
      const rows = arrowRows(batch, columns);
      await onBatch({
        columns,
        rows,
        rowCount: rows.length,
        truncated: false,
        elapsedMs: performance.now() - started,
        executedSql,
      });
    }
  }

  async countRows(tableId: string): Promise<number> {
    const handle = this.handles.get(tableId);
    if (!handle) throw new Error(`No table registered with id ${tableId}`);

    const result = await this.query(buildCountStatement(handle.name), { limit: null });
    const n = Number(result.rows[0]?.[0] ?? 0);
    handle.rowCount = n;
    return n;
  }

  async dispose(): Promise<void> {
    await this.conn?.close().catch(() => {});
    await this.db?.terminate().catch(() => {});
    this.conn = null;
    this.db = null;
    this.initPromise = null;
    this.handles.clear();
  }

  private async exec(sql: string): Promise<void> {
    await this.conn!.query(sql);
  }

  private async describe(tableName: string): Promise<ColumnInfo[]> {
    const table = await this.conn!.query(buildDescribeStatement(tableName));
    return table.toArray().map((row) => ({
      name: String(row.column_name ?? ""),
      type: String(row.column_type ?? "VARCHAR"),
      nullable: String(row.null ?? "YES").toUpperCase() !== "NO",
    }));
  }
}

/** Arrow schema → our ColumnInfo. */
function arrowColumns(table: ArrowTable): ColumnInfo[] {
  return table.schema.fields.map((f) => ({
    name: f.name,
    type: f.type.toString(),
    nullable: f.nullable,
  }));
}

/**
 * Arrow rows → row-major arrays of JS values.
 *
 * BIGINT comes back as a JavaScript BigInt, which `JSON.stringify` throws on and
 * React refuses to render. Converting to string here keeps the exact value (a
 * Number would silently lose precision above 2^53, and these are frequently ids).
 */
function arrowRows(table: ArrowTable, columns: ColumnInfo[]): unknown[][] {
  return table.toArray().map((record) => columns.map((c) => normalise(record[c.name])));
}

function normalise(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return `0x${Buffer_toHex(value)}`;
  if (value != null && typeof value === "object") {
    // Nested JSON / LIST / STRUCT columns. Render rather than showing [object Object].
    try {
      return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    } catch {
      return String(value);
    }
  }
  return value;
}

function Buffer_toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}
