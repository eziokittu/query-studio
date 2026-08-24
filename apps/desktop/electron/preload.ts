// Preload — the only thing the renderer can see of Node.
//
// `contextIsolation` is on and `nodeIntegration` is off, so the renderer has no
// `require`, no `fs`, and no way to reach the filesystem except through the six
// functions exposed here. That is deliberate: the app opens files that arrived from
// somewhere else, and a data file should never be able to widen its own access.
//
// The shape below is exactly `NativeBridge` from `@query-studio/core/workbench`.
// The core package deliberately declares it structurally rather than importing from
// Electron, so this file is the one place the two halves have to agree.

import { contextBridge, ipcRenderer } from "electron";

interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
}

interface BatchMessage {
  columns: ColumnInfo[];
  rows: unknown[][];
  done: boolean;
}

const bridge = {
  version: (): Promise<string> => ipcRenderer.invoke("qs:version"),

  register: (
    path: string,
    tableName: string,
  ): Promise<{ columns: ColumnInfo[]; format: string; sizeBytes: number; locator: string }> =>
    ipcRenderer.invoke("qs:register", path, tableName),

  unregister: (tableName: string): Promise<void> => ipcRenderer.invoke("qs:unregister", tableName),

  query: (
    sql: string,
    limit: number | null,
  ): Promise<{ columns: ColumnInfo[]; rows: unknown[][]; elapsedMs: number }> =>
    ipcRenderer.invoke("qs:query", sql, limit),

  streamStart: (sql: string, limit: number | null): Promise<string> =>
    ipcRenderer.invoke("qs:stream-start", sql, limit),

  streamCancel: (subscriptionId: string): Promise<void> =>
    ipcRenderer.invoke("qs:stream-cancel", subscriptionId),

  /**
   * Subscribe to one stream's batches. Returns an unsubscribe function.
   *
   * Removing the listener on unsubscribe matters more than it looks: a user running
   * twenty exploratory queries would otherwise accumulate twenty live IPC listeners,
   * and every batch of the twentieth query would be delivered twenty times.
   */
  onBatch: (
    subscriptionId: string,
    handler: (batch: BatchMessage | null, error?: string) => void,
  ): (() => void) => {
    const channel = `qs:batch:${subscriptionId}`;
    const listener = (_event: unknown, batch: BatchMessage | null, error?: string) => handler(batch, error);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
};

/** Desktop-only extras the web build does not have. */
const desktop = {
  platform: process.platform as "win32" | "darwin" | "linux",

  /** Native open dialog. Returns paths, never bytes. */
  openFiles: (): Promise<{ path: string; name: string; sizeBytes: number }[]> =>
    ipcRenderer.invoke("qs:open-files"),

  /** Native save dialog. Returns the chosen path, or null if dismissed. */
  saveDialog: (suggestedName: string): Promise<string | null> =>
    ipcRenderer.invoke("qs:save-dialog", suggestedName),

  /**
   * Export via DuckDB's own `COPY … TO`.
   *
   * The rows are written by the database directly to disk and never enter the
   * renderer, so exporting 200 million rows costs the UI nothing and finishes at
   * disk speed rather than IPC speed.
   */
  exportTo: (
    sql: string,
    destination: string,
    format: "csv" | "tsv" | "json" | "ndjson" | "parquet",
  ): Promise<{ path: string; elapsedMs: number; sizeBytes: number }> =>
    ipcRenderer.invoke("qs:export", sql, destination, format),

  /** Files opened via "Open with", the command line, or a second launch. */
  onOpenPaths: (handler: (paths: string[]) => void): (() => void) => {
    const listener = (_event: unknown, paths: string[]) => handler(paths);
    ipcRenderer.on("qs:open-paths", listener);
    return () => ipcRenderer.removeListener("qs:open-paths", listener);
  },

  /** Menu commands, so the native menu drives the same actions as the toolbar. */
  onMenu: (handler: (command: "open" | "export" | "run" | "share") => void): (() => void) => {
    const listener = (_event: unknown, command: "open" | "export" | "run" | "share") => handler(command);
    ipcRenderer.on("qs:menu", listener);
    return () => ipcRenderer.removeListener("qs:menu", listener);
  },
};

contextBridge.exposeInMainWorld("queryStudioNative", bridge);
contextBridge.exposeInMainWorld("queryStudioDesktop", desktop);
