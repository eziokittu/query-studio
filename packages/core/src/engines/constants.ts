// Shared constants safe to import from both client and server (no heavy deps here).
import type { StudioAction } from "./types";

/** Absolute hard ceiling on input size — a safety / abuse guard, not the everyday
 *  limit. Nothing legitimate comes close; the per-operation limits below are what
 *  users are actually held to. Enforced at the API boundary and in the editor so a
 *  pathological paste can't blow up memory. */
export const MAX_QUERY_LENGTH = 20_000;

/**
 * The largest input each operation reliably handles, tuned to what its engine can
 * actually chew on rather than one blunt global cap:
 *   • Schema diagrams and formatting are text-shaped and scale to big multi-table
 *     DDL, so they get the most room.
 *   • SQL→MongoDB runs through a fragile plain-SELECT-subset parser (@synatic/noql),
 *     so it gets a tighter budget — huge inputs there are almost always the advanced
 *     SQL it can't map anyway.
 *   • The analysis engines (validate / explain / analyze / optimize) sit in between.
 *
 * Oversized input is REJECTED with a clear "too large" message (see the API route
 * and the editor) — never silently truncated, which would corrupt the result.
 */
export function queryLimitFor(action: StudioAction, targetId?: string): number {
  switch (action) {
    case "schema":
      return 12_000; // multi-table DDL is the biggest legitimate input
    case "format":
      return 12_000; // pure text reflow scales fine
    case "translate":
      // SQL→MongoDB uses a limited SELECT-subset parser; keep expectations honest.
      return targetId === "mongodb" ? 6_000 : 10_000;
    case "validate":
    case "explain":
    case "analyze":
    case "optimize":
      return 8_000;
    default:
      return 8_000;
  }
}
