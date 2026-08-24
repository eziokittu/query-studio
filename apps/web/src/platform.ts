// Which of the four platforms are we on, and what can it actually do?
//
// The same bundle ships to a browser tab, an Electron window, an Android WebView and
// an iOS WKWebView. The UI is identical everywhere; what differs is how files get in
// and how much memory there is to work with. Both of those are answered here, once,
// so no component has to sniff a user agent.

import type { NativeBridge } from "@query-studio/core/workbench";

export type Platform = "browser" | "desktop" | "android" | "ios";

declare global {
  interface Window {
    queryStudioNative?: NativeBridge;
    queryStudioDesktop?: DesktopApi;
    Capacitor?: { getPlatform(): string; isNativePlatform(): boolean };
  }
}

export interface DesktopApi {
  platform: "win32" | "darwin" | "linux";
  openFiles(): Promise<{ path: string; name: string; sizeBytes: number }[]>;
  saveDialog(suggestedName: string): Promise<string | null>;
  exportTo(
    sql: string,
    destination: string,
    format: "csv" | "tsv" | "json" | "ndjson" | "parquet",
  ): Promise<{ path: string; elapsedMs: number; sizeBytes: number }>;
  onOpenPaths(handler: (paths: string[]) => void): () => void;
  onMenu(handler: (command: "open" | "export" | "run" | "share") => void): () => void;
}

/**
 * Mobile memory ceiling.
 *
 * A phone WebView gets killed by the OS long before it reaches the 4 GB WASM limit —
 * iOS in particular terminates a tab that grows past roughly a gigabyte, with no
 * warning and no catchable error. Advertising 3.5 GB on a phone would mean the app
 * accepts a 2 GB file and then vanishes, which is worse than refusing it.
 *
 * 900 MB is conservative enough to survive on a mid-range Android and honest enough
 * that the "open this on desktop instead" nudge appears when it should.
 */
export const MOBILE_MEMORY_CEILING = 900 * 1024 * 1024;

export function detectPlatform(): Platform {
  if (typeof window === "undefined") return "browser";
  if (window.queryStudioDesktop) return "desktop";

  const cap = window.Capacitor;
  if (cap?.isNativePlatform?.()) {
    const name = cap.getPlatform();
    if (name === "android") return "android";
    if (name === "ios") return "ios";
  }
  return "browser";
}

export function isMobile(platform: Platform): boolean {
  return platform === "android" || platform === "ios";
}

/** The desktop bridge, or null in every other build. */
export function desktopApi(): DesktopApi | null {
  return typeof window !== "undefined" ? (window.queryStudioDesktop ?? null) : null;
}

export interface PlatformProfile {
  platform: Platform;
  /** How to describe this build in the UI. */
  label: string;
  /** Memory ceiling to hand the WASM engine. Ignored on desktop. */
  memoryCeilingBytes: number;
  /** True when files arrive as paths rather than File objects. */
  usesPaths: boolean;
  /** True when the platform can stream an export straight to disk. */
  canStreamToDisk: boolean;
  /** True when there is a more capable build worth pointing the user at. */
  suggestDesktop: boolean;
}

export function platformProfile(): PlatformProfile {
  const platform = detectPlatform();

  switch (platform) {
    case "desktop":
      return {
        platform,
        label: "Desktop",
        memoryCeilingBytes: Number.POSITIVE_INFINITY,
        usesPaths: true,
        canStreamToDisk: true,
        suggestDesktop: false,
      };

    case "android":
    case "ios":
      return {
        platform,
        label: platform === "ios" ? "iOS" : "Android",
        memoryCeilingBytes: MOBILE_MEMORY_CEILING,
        usesPaths: false,
        canStreamToDisk: false,
        suggestDesktop: true,
      };

    default:
      return {
        platform,
        label: "Browser",
        memoryCeilingBytes: 3.5 * 1024 * 1024 * 1024,
        usesPaths: false,
        // Chromium-family browsers have the File System Access API; Firefox and
        // Safari do not, and fall back to a buffered Blob download.
        canStreamToDisk: typeof (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker === "function",
        suggestDesktop: true,
      };
  }
}

/** Where the DuckDB-WASM assets live. Self-hosted everywhere except plain dev. */
export function wasmAssetBase(): string | null {
  const platform = detectPlatform();
  // Offline builds must never reach for a CDN — that would make the desktop and
  // mobile apps silently require a network connection to open a CSV.
  if (platform !== "browser") return `${import.meta.env.BASE_URL}duckdb`;
  return import.meta.env.PROD ? `${import.meta.env.BASE_URL}duckdb` : null;
}

/** `Cmd` on macOS and iOS, `Ctrl` everywhere else — for keyboard hints in the UI. */
export function modifierKey(): string {
  if (typeof navigator === "undefined") return "Ctrl";
  const apple = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
  return apple ? "⌘" : "Ctrl";
}
