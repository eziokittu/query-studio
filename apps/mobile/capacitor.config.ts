import type { CapacitorConfig } from "@capacitor/cli";

// Capacitor wraps the *same* build the browser gets — apps/web/dist, unmodified.
// There is no mobile fork of the UI and no mobile fork of the engine: DuckDB-WASM
// runs inside the WebView exactly as it runs in a tab, so a query that works on the
// website works on a phone.
//
// What does differ is the memory ceiling, and the app reports it honestly rather
// than letting the OS kill the process mid-scan. See `MOBILE_MEMORY_CEILING` in
// apps/web/src/platform.ts.
const config: CapacitorConfig = {
  appId: "com.glitchbong.querystudio",
  appName: "Query Studio",
  webDir: "../web/dist",

  // No account, no backend, so there is nothing for the app to phone home to.
  // Cleartext stays off; the app never makes an HTTP request of its own.
  server: {
    androidScheme: "https",
    cleartext: false,
  },

  android: {
    // The whole product is "open a big file", and the default heap is not enough
    // for DuckDB-WASM. `largeHeap` is requested in AndroidManifest.xml too.
    allowMixedContent: false,
    webContentsDebuggingEnabled: false,
  },

  ios: {
    contentInset: "always",
    limitsNavigationsToAppBoundDomains: true,
  },

  plugins: {
    // Files come in through a standard <input type="file">, which both WebViews
    // hand over as a real File object. That matters: Capacitor's Filesystem plugin
    // returns base64, which would mean holding the entire file in memory as a
    // string — the exact failure mode this tool exists to avoid.
    Filesystem: {
      iosDatabaseLocation: "Documents",
    },
  },
};

export default config;
