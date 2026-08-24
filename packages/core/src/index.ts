// @query-studio/core
//
// Two halves, deliberately separable:
//
//   ./engines    — the deterministic SQL toolkit (translate, explain, analyze,
//                  optimize, format, validate, diagram). Pure functions over
//                  strings. No I/O, no network, no AI.
//
//   ./workbench  — the large-file query engine. Registers files with DuckDB and
//                  runs SQL against them, picking a WASM or native backend to suit
//                  wherever it is running.
//
// Import the subpaths directly (`@query-studio/core/workbench`) when you only need
// one half — the workbench pulls DuckDB behind a dynamic import, and a page that
// only translates SQL should never pay for a database engine.
export * as engines from "./engines/index.js";
export * as workbench from "./workbench/index.js";

export { runStudio, MAX_QUERY_LENGTH } from "./engines/engine";
export type {
  StudioAction,
  StudioRequest,
  StudioResult,
  StudioNote,
} from "./engines/types";

export { createEngine, describeRuntime, checkFileSize } from "./workbench/runtime.js";
export type { QueryEngine, TableHandle, QueryResult } from "./workbench/types.js";

export const VERSION = "1.0.0";
