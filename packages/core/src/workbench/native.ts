// Native DuckDB engine — the desktop backend.
//
// This class holds no database. It is a thin, typed client for a bridge that the
// Electron preload script exposes on `window.queryStudioNative`; the real DuckDB
// instance lives in the main process, where it can memory-map files, spill to disk
// and use every core on the machine.
//
// The split matters for one reason beyond architecture: it is what removes the size
// ceiling entirely. The renderer never sees the file's bytes, so nothing has to fit
// in the WebView's address space. A 60 GB Parquet directory is the same amount of
// renderer memory as a 6 MB CSV — only the result page crosses the bridge.
//
// The bridge contract is deliberately small (six calls). Anything the UI needs
// beyond it is expressed as SQL, which the main process runs verbatim.

import {
  type ColumnInfo,
  type EngineCapabilities,
  type QueryEngine,
  type QueryOptions,
  type QueryResult,
  type SourceFile,
  type TableHandle,
} from "./types.js";
import { applyRowLimit, buildCountStatement, quoteIdent, tableNameFor } from "./sql.js";

/**
 * What the Electron preload must provide.
 *
 * Kept structural rather than importing from the desktop app so `@query-studio/core`
 * has no dependency on Electron and still typechecks in a browser-only build.
 */
export interface NativeBridge {
  /** Engine version string, used for the runtime badge. Also a liveness check. */
  version(): Promise<string>;
  /** Register a file by absolute path and return its schema. No bytes are copied. */
  register(path: string, tableName: string): Promise<{
    columns: ColumnInfo[];
    format: string;
    sizeBytes: number;
    locator: string;
  }>;
  /** Drop a registered view. */
  unregister(tableName: string): Promise<void>;
  /** Run SQL, get one page. */
  query(sql: string, limit: number | null): Promise<{
    columns: ColumnInfo[];
    rows: unknown[][];
    elapsedMs: number;
  }>;
  /**
   * Run SQL and receive batches over a channel.
   *
   * Returns a subscription id so the caller can cancel; batches arrive through
   * `onBatch`, which the preload wires to an ipcRenderer listener.
   */
  streamStart(sql: string, limit: number | null): Promise<string>;
  streamCancel(subscriptionId: string): Promise<void>;
  onBatch(
    subscriptionId: string,
    handler: (batch: { columns: ColumnInfo[]; rows: unknown[][]; done: boolean } | null, error?: string) => void,
  ): () => void;
}

declare global {
  interface Window {
    queryStudioNative?: NativeBridge;
  }
}

/** True when running inside the desktop shell with the bridge attached. */
export function hasNativeBridge(): boolean {
  return typeof window !== "undefined" && typeof window.queryStudioNative?.query === "function";
}

export class NativeEngine implements QueryEngine {
  readonly capabilities: EngineCapabilities = {
    kind: "native",
    // The honest number. DuckDB streams from disk; the machine's storage is the
    // only limit, and pretending otherwise would just reintroduce a fake ceiling.
    maxFileBytes: Number.POSITIVE_INFINITY,
    streaming: true,
    persistence: true,
    attachDatabase: true,
    label: "Native DuckDB (no size limit)",
  };

  private readonly bridge: NativeBridge;
  private readonly handles = new Map<string, TableHandle>();
  private initPromise: Promise<void> | null = null;
  private engineVersion = "";

  constructor(bridge?: NativeBridge) {
    const resolved = bridge ?? (typeof window !== "undefined" ? window.queryStudioNative : undefined);
    if (!resolved) {
      throw new Error("NativeEngine needs the desktop bridge. Use createEngine() to pick a backend.");
    }
    this.bridge = resolved;
  }

  init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.bridge.version().then((v) => {
        this.engineVersion = v;
      });
    }
    return this.initPromise;
  }

  /** DuckDB version, once `init()` has resolved. Shown in the runtime badge. */
  get version(): string {
    return this.engineVersion;
  }

  async registerFile(source: SourceFile): Promise<TableHandle> {
    await this.init();
    if (source.kind !== "path") {
      // A dropped File in Electron still carries `.path`; the UI is expected to
      // convert it before calling. Failing loudly beats silently buffering 40 GB.
      throw new Error("The desktop engine takes a file path. Pass { kind: 'path', path }.");
    }

    const taken = new Set([...this.handles.values()].map((h) => h.name));
    const tableName = tableNameFor(source.name, taken);

    const meta = await this.bridge.register(source.path, tableName);

    const handle: TableHandle = {
      id: `${tableName}-${Date.now().toString(36)}`,
      name: tableName,
      fileName: source.name,
      format: meta.format as TableHandle["format"],
      sizeBytes: meta.sizeBytes || source.sizeBytes,
      columns: meta.columns,
      rowCount: null,
      locator: meta.locator,
    };
    this.handles.set(handle.id, handle);
    return handle;
  }

  async unregister(tableId: string): Promise<void> {
    const handle = this.handles.get(tableId);
    if (!handle) return;
    await this.bridge.unregister(handle.name);
    this.handles.delete(tableId);
  }

  tables(): TableHandle[] {
    return [...this.handles.values()];
  }

  async query(sql: string, options: QueryOptions = {}): Promise<QueryResult> {
    await this.init();
    const limit = options.limit === undefined ? 1000 : options.limit;
    const executedSql = applyRowLimit(sql, limit);

    const res = await this.bridge.query(executedSql, limit);
    return {
      columns: res.columns,
      rows: res.rows,
      rowCount: res.rows.length,
      truncated: executedSql !== sql.trim().replace(/;\s*$/, ""),
      elapsedMs: res.elapsedMs,
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
    const started = Date.now();
    const subscriptionId = await this.bridge.streamStart(executedSql, options.limit ?? null);

    await new Promise<void>((resolve, reject) => {
      const stop = this.bridge.onBatch(subscriptionId, (batch, error) => {
        if (error) {
          stop();
          reject(new Error(error));
          return;
        }
        if (!batch) return;

        if (options.signal?.aborted) {
          void this.bridge.streamCancel(subscriptionId);
          stop();
          resolve();
          return;
        }

        void Promise.resolve(
          onBatch({
            columns: batch.columns,
            rows: batch.rows,
            rowCount: batch.rows.length,
            truncated: false,
            elapsedMs: Date.now() - started,
            executedSql,
          }),
        ).then(() => {
          if (batch.done) {
            stop();
            resolve();
          }
        }, reject);
      });

      options.signal?.addEventListener("abort", () => {
        void this.bridge.streamCancel(subscriptionId);
        stop();
        resolve();
      });
    });
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
    for (const handle of [...this.handles.values()]) {
      await this.bridge.unregister(handle.name).catch(() => {});
    }
    this.handles.clear();
    this.initPromise = null;
  }

  /** Escape hatch for desktop-only features (ATTACH, COPY … TO, EXPORT DATABASE). */
  async exec(sql: string): Promise<QueryResult> {
    return this.query(sql, { limit: null });
  }

  /** `DROP VIEW` without going through the bridge's unregister bookkeeping. */
  async dropView(name: string): Promise<void> {
    await this.query(`DROP VIEW IF EXISTS ${quoteIdent(name)}`, { limit: null });
  }
}
