// Shared types for GlitchBong Query Studio.
// Every engine (format / validate / translate / explain / analyze / optimize /
// schema) is deterministic and runs server-side in the /api/tools/query-studio route
// so the browser bundle stays tiny. These types are the contract between that route
// and the client UI. There is no AI engine — all results are computed locally.

export type StudioAction =
  | "format"
  | "validate"
  | "translate"
  | "explain"
  | "analyze"
  | "optimize"
  | "schema";

/** A note surfaced to the user: a warning, a suggestion, or an applied change. */
export interface StudioNote {
  kind: "info" | "warning" | "error" | "change";
  message: string;
}

export interface FormatResult {
  action: "format";
  output: string;
  notes: StudioNote[];
}

export interface ValidateResult {
  action: "validate";
  valid: boolean;
  notes: StudioNote[];
}

export interface TranslateResult {
  action: "translate";
  output: string;
  /** Human-readable differences between the source and target dialects. */
  notes: StudioNote[];
}

export interface ExplainStep {
  clause: string;
  detail: string;
}

export interface ExplainResult {
  action: "explain";
  /** Ordered logical execution steps (FROM → WHERE → … → LIMIT). */
  steps: ExplainStep[];
  /** Plain-English summary of what the query does. */
  summary: string;
  notes: StudioNote[];
}

// ── Performance Analyzer ─────────────────────────────────────────────────────
export interface AnalyzeIssue {
  severity: "high" | "medium" | "low" | "good";
  title: string;
  detail: string;
}
export interface AnalyzeResult {
  action: "analyze";
  score: number; // 0–100
  grade: string; // A+ … F
  issues: AnalyzeIssue[];
  notes: StudioNote[];
}

// ── AI / rule-based Optimizer ────────────────────────────────────────────────
export interface OptimizeResult {
  action: "optimize";
  suggestions: { title: string; detail: string }[];
  /** Suggested CREATE INDEX statements. */
  indexes: string[];
  notes: StudioNote[];
}

// ── Schema diagram (DDL → tables + relations) ────────────────────────────────
export interface SchemaColumn {
  name: string;
  type: string;
  pk: boolean;
  fk: boolean;
  nullable: boolean;
}
export interface SchemaTable {
  name: string;
  columns: SchemaColumn[];
}
export interface SchemaRelation {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
}
export interface SchemaResult {
  action: "schema";
  tables: SchemaTable[];
  relations: SchemaRelation[];
  notes: StudioNote[];
}

export type StudioResult =
  | FormatResult
  | ValidateResult
  | TranslateResult
  | ExplainResult
  | AnalyzeResult
  | OptimizeResult
  | SchemaResult;

export interface StudioRequest {
  action: StudioAction;
  query: string;
  /** Source dialect id (see databases.ts). Used by format/validate/translate/explain. */
  source: string;
  /** Target dialect id — only used by translate. */
  target?: string;
  /** format-only: "beautify" (default) or "compress". */
  mode?: "beautify" | "compress";
  /** Selected dialect versions — shown in the UI; deterministic engines ignore them. */
  sourceVersion?: string;
  targetVersion?: string;
}
