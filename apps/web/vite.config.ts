import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// DuckDB-WASM needs SharedArrayBuffer for its threaded bundle, which browsers only
// hand over on a cross-origin-isolated page. The two headers below provide that in
// dev; production hosts must send the same pair or DuckDB silently falls back to the
// single-threaded build (slower on big scans, but still correct — so this is a
// performance setting, not a correctness one).
const crossOriginIsolation = {
  name: "cross-origin-isolation",
  configureServer(server: { middlewares: { use: (fn: (req: unknown, res: { setHeader(k: string, v: string): void }, next: () => void) => void) => void } }) {
    server.middlewares.use((_req, res, next) => {
      res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
      next();
    });
  },
};

export default defineConfig({
  plugins: [react(), crossOriginIsolation],
  // Relative so the same build works from a file:// URL inside Electron and from a
  // Capacitor WebView, neither of which serves from a domain root.
  base: "./",
  build: {
    target: "es2022",
    outDir: "dist",
    // DuckDB's wasm is large and must not be inlined into the JS bundle.
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        manualChunks: {
          duckdb: ["@duckdb/duckdb-wasm"],
          react: ["react", "react-dom"],
        },
      },
    },
  },
  optimizeDeps: {
    // Pre-bundling DuckDB breaks its worker resolution.
    exclude: ["@duckdb/duckdb-wasm"],
  },
  worker: { format: "es" },
});
