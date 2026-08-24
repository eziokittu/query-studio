// Shareable query permalinks.
//
// This is the growth mechanic, and it only works if it is trustworthy: the link
// carries the *question*, never the answer. SQL, table names, column names and
// types go in. Not one cell of data does — not a sample row, not a min/max, not a
// distinct count. A person pasting a link into a work Slack has to be able to do it
// without thinking about whether their customer table just leaked, and the only way
// to earn that is for the payload to be structurally incapable of holding data.
//
// Everything is encoded into the URL fragment. Fragments are never sent to a server
// in an HTTP request, so even the SQL stays on the two machines that matter.

import type { ColumnInfo, FileFormat, TableHandle } from "./types.js";

const VERSION = 1;

/** Keep links pasteable. Beyond this, chat clients and mail wrap or truncate them. */
export const MAX_LINK_BYTES = 8_000;

/** A table as described in a share link: shape only, no contents. */
export interface SharedSource {
  /** SQL identifier the query refers to. */
  name: string;
  /** Original filename, so the recipient knows what to open. */
  fileName: string;
  format: FileFormat;
  /** Column names and types — the schema the query was written against. */
  columns: { n: string; t: string }[];
  /** Size in bytes, so the recipient knows what they are in for. Never contents. */
  sizeBytes: number;
}

export interface SharePayload {
  v: number;
  /** The query being shared. */
  sql: string;
  /** Schemas the query expects to find. */
  sources: SharedSource[];
  /** Optional one-line note from the sender. */
  note?: string;
  /** Unix seconds, for showing "shared 3 days ago". */
  ts: number;
}

/** Build a payload from live workbench state. */
export function buildSharePayload(
  sql: string,
  tables: TableHandle[],
  note?: string,
): SharePayload {
  return {
    v: VERSION,
    sql: sql.trim(),
    sources: tables.map(toSharedSource),
    ...(note ? { note: note.slice(0, 280) } : {}),
    ts: Math.floor(Date.now() / 1000),
  };
}

function toSharedSource(table: TableHandle): SharedSource {
  return {
    name: table.name,
    fileName: table.fileName,
    format: table.format,
    // Deliberately lossy: `{n, t}` and nothing else. Adding a `sample` field here
    // later would silently turn every existing link into a data leak, so the
    // narrowness is the safety property, not an optimisation.
    columns: table.columns.map((c) => ({ n: c.name, t: c.type })),
    sizeBytes: table.sizeBytes,
  };
}

/** Schema back out of a share payload, for the "expected columns" panel. */
export function sharedColumnsToInfo(source: SharedSource): ColumnInfo[] {
  return source.columns.map((c) => ({ name: c.n, type: c.t, nullable: true }));
}

/**
 * Encode a payload into a URL fragment value.
 *
 * Deflate then base64url. SQL is extremely compressible — repeated keywords, column
 * names appearing in both SELECT and GROUP BY — so a 6 KB query with a wide schema
 * typically lands around 1.2 KB, well inside every client's URL handling.
 */
export async function encodeShare(payload: SharePayload): Promise<string> {
  const json = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(json);

  const compressed = await deflate(bytes);
  if (compressed) return `z${base64UrlEncode(compressed)}`;

  // No CompressionStream (older WebViews). Still works, just longer.
  return `r${base64UrlEncode(bytes)}`;
}

/** Decode a fragment value produced by `encodeShare`. Returns null if it is not ours. */
export async function decodeShare(fragment: string): Promise<SharePayload | null> {
  if (!fragment) return null;

  const marker = fragment[0];
  const body = fragment.slice(1);
  if (marker !== "z" && marker !== "r") return null;

  try {
    const raw = base64UrlDecode(body);
    const bytes = marker === "z" ? await inflate(raw) : raw;
    if (!bytes) return null;

    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as SharePayload;
    if (typeof parsed?.sql !== "string" || !Array.isArray(parsed.sources)) return null;
    if (parsed.v > VERSION) return null; // A newer sender; we cannot promise to read it.

    return parsed;
  } catch {
    // Truncated or hand-edited link. The UI treats null as "start a fresh session".
    return null;
  }
}

/** Full URL for a payload, given the page that renders shared queries. */
export async function buildShareUrl(baseUrl: string, payload: SharePayload): Promise<string> {
  const encoded = await encodeShare(payload);
  return `${baseUrl.replace(/#.*$/, "")}#q=${encoded}`;
}

/** Pull a payload out of a full URL or a bare `#q=…` fragment. */
export async function readShareUrl(url: string): Promise<SharePayload | null> {
  const hash = url.includes("#") ? url.slice(url.indexOf("#") + 1) : url;
  const params = new URLSearchParams(hash.startsWith("?") ? hash.slice(1) : hash);
  const q = params.get("q");
  return q ? decodeShare(q) : null;
}

/** Whether a link built from this payload will survive being pasted around. */
export async function checkShareSize(payload: SharePayload): Promise<{
  bytes: number;
  ok: boolean;
  advice?: string;
}> {
  const encoded = await encodeShare(payload);
  const bytes = encoded.length;
  if (bytes <= MAX_LINK_BYTES) return { bytes, ok: true };

  return {
    bytes,
    ok: false,
    advice:
      payload.sources.length > 3
        ? "Too long to paste reliably. Removing tables the query does not reference will shorten it."
        : "Too long to paste reliably. Shortening the query or trimming comments will help.",
  };
}

// ── compression ──────────────────────────────────────────────────────────────
//
// CompressionStream is in every current browser, Node 18+, and Electron. The
// fallback path exists for older mobile WebViews, where a longer link beats no link.

async function deflate(bytes: Uint8Array): Promise<Uint8Array | null> {
  const CS = (globalThis as { CompressionStream?: typeof CompressionStream }).CompressionStream;
  if (!CS) return null;
  try {
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CS("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array | null> {
  const DS = (globalThis as { DecompressionStream?: typeof DecompressionStream }).DecompressionStream;
  if (!DS) return null;
  try {
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DS("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

// ── base64url ────────────────────────────────────────────────────────────────
//
// Standard base64 puts `+`, `/` and `=` in the string, all of which get mangled
// somewhere between a URL bar, a chat client and an email. base64url avoids all three.

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  // Chunked because `String.fromCharCode(...bytes)` blows the argument limit
  // somewhere north of 100 KB, which a big schema can reach.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * How a recipient's loaded files line up with what the link expects.
 *
 * Shown as a checklist when a shared link opens: which tables are present, which
 * are missing, and which have drifted. Without this the recipient just gets a red
 * SQL error and no idea that their `orders.csv` is missing three columns.
 */
export interface SourceMatch {
  expected: SharedSource;
  matched: TableHandle | null;
  missingColumns: string[];
  typeMismatches: { column: string; expected: string; actual: string }[];
}

export function matchSources(payload: SharePayload, loaded: TableHandle[]): SourceMatch[] {
  return payload.sources.map((expected) => {
    const matched =
      loaded.find((t) => t.name === expected.name) ??
      loaded.find((t) => t.fileName === expected.fileName) ??
      null;

    if (!matched) return { expected, matched: null, missingColumns: [], typeMismatches: [] };

    const actual = new Map(matched.columns.map((c) => [c.name, c.type]));
    const missingColumns: string[] = [];
    const typeMismatches: SourceMatch["typeMismatches"] = [];

    for (const col of expected.columns) {
      const actualType = actual.get(col.n);
      if (actualType === undefined) missingColumns.push(col.n);
      else if (actualType !== col.t) {
        typeMismatches.push({ column: col.n, expected: col.t, actual: actualType });
      }
    }

    return { expected, matched, missingColumns, typeMismatches };
  });
}
