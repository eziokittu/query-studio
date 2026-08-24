// The large-file query workbench.
//
// Drop a CSV, TSV, JSON, NDJSON, Parquet, Arrow or log file and query it with SQL.
// Nothing is uploaded: the browser build streams the file through DuckDB-WASM in the
// tab, and the desktop build hands the path to a native DuckDB that reads it off
// disk with no size ceiling at all.
export * from "./types.js";
export * from "./detect.js";
export * from "./sql.js";
export * from "./runtime.js";
export * from "./share.js";
export * from "./profile.js";
export * from "./export.js";
export { WasmEngine, selfHosted, type WasmBundle, type WasmEngineOptions } from "./wasm.js";
export { NativeEngine, hasNativeBridge, type NativeBridge } from "./native.js";
