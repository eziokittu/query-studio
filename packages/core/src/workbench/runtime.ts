// Picking a backend, and describing the one you got.
//
// The UI calls `createEngine()` and never branches on the answer again. The only
// thing it does surface is `describeRuntime()`, because "why can the desktop app
// open this and my browser can't?" deserves an answer in the interface rather than
// a support email.

import { type EngineCapabilities, type QueryEngine, formatBytes } from "./types.js";
import { NativeEngine, hasNativeBridge, type NativeBridge } from "./native.js";
import { WasmEngine, type WasmEngineOptions } from "./wasm.js";

export interface CreateEngineOptions extends WasmEngineOptions {
  /**
   * Force a backend instead of detecting one.
   *
   * Only really useful for testing the browser path inside the desktop shell, which
   * is worth doing before every release — the WASM path is what most users get.
   */
  force?: "wasm" | "native";
  /** Inject a bridge explicitly rather than reading `window.queryStudioNative`. */
  bridge?: NativeBridge;
}

/** Build the right engine for wherever this code is running. */
export function createEngine(options: CreateEngineOptions = {}): QueryEngine {
  const { force, bridge, ...wasmOptions } = options;

  if (force === "wasm") return new WasmEngine(wasmOptions);
  if (force === "native") return new NativeEngine(bridge);

  return bridge || hasNativeBridge() ? new NativeEngine(bridge) : new WasmEngine(wasmOptions);
}

export interface RuntimeDescription {
  kind: "wasm" | "native";
  /** Short label for the status bar. */
  label: string;
  /** What the size ceiling is, in words. */
  limitText: string;
  /**
   * Whether to nudge the user towards the desktop build.
   *
   * True only on the WASM path — and the UI is expected to show it once, near the
   * size indicator, not as a modal. A tool that works is a better advertisement for
   * the desktop version than a tool that interrupts.
   */
  suggestDesktop: boolean;
  /** Capabilities, passed through for feature gating. */
  capabilities: EngineCapabilities;
}

export function describeRuntime(engine: QueryEngine): RuntimeDescription {
  const c = engine.capabilities;
  return {
    kind: c.kind,
    label: c.label,
    limitText:
      c.kind === "native"
        ? "No file size limit — files are read from disk."
        : `Files up to about ${formatBytes(c.maxFileBytes)}, streamed rather than loaded.`,
    suggestDesktop: c.kind === "wasm",
    capabilities: c,
  };
}

/**
 * Whether a file of this size will work here, and what to say if it won't.
 *
 * Called before the file is touched. The competing tools all discover this three
 * minutes into a load, by crashing.
 */
export function checkFileSize(
  sizeBytes: number,
  engine: QueryEngine,
): { ok: true } | { ok: false; message: string; desktopWouldWork: boolean } {
  const c = engine.capabilities;
  if (sizeBytes <= c.maxFileBytes) return { ok: true };

  return {
    ok: false,
    message:
      c.kind === "wasm"
        ? `${formatBytes(sizeBytes)} is past what a browser tab can address (about ${formatBytes(c.maxFileBytes)}).`
        : `${formatBytes(sizeBytes)} is past the configured limit of ${formatBytes(c.maxFileBytes)}.`,
    desktopWouldWork: c.kind === "wasm",
  };
}
