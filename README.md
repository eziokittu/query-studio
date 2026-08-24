# Query Studio

SQL translator, analyzer and large-file workbench. Runs in a browser tab, as a
desktop app on Windows/macOS/Linux, and as an Android or iOS app.

**No account. No upload. No server.** Files are read on your own machine, and the
apps work with the network switched off.

---

## What it does

Two halves, deliberately separable.

### The deterministic SQL toolkit

Translate, explain, analyze, optimize, format, validate, diagram. Pure functions
over strings — real parsers and rule engines, no AI, no network call. The same
input gives the same output every time, which is the property a model cannot offer.

Supports 18 dialects: MySQL, PostgreSQL, SQLite, MariaDB, SQL Server, IBM DB2,
Snowflake, Redshift, BigQuery, DuckDB, Spark SQL, Hive, Trino, Presto, plus
SQL→MongoDB and GraphQL/Elasticsearch/OpenSearch formatting.

### The large-file workbench

Drop a CSV, TSV, JSON, NDJSON, Parquet, Arrow or log file and query it with SQL.
Column profiling in one pass. Shareable query links that carry the question and
never the data.

| Runtime | Backend | File size ceiling |
|---|---|---|
| Browser tab | DuckDB-WASM | ~3.5 GB, streamed |
| Desktop | Native DuckDB | **None** — bounded by disk |
| Android / iOS | DuckDB-WASM in WebView | ~900 MB |

Those numbers are enforced *before* a file is read, so an oversized file gets an
immediate, specific message instead of an out-of-memory crash three minutes into
a load.

---

## Why the size ceiling differs

This is the whole engineering story, so it is worth stating plainly.

**In the browser**, the obvious way to hand a file to DuckDB-WASM is
`registerFileBuffer`, which reads the whole thing into an ArrayBuffer and copies it
into WASM linear memory. A 1.5 GB CSV then needs 1.5 GB for the buffer plus
DuckDB's own working set, and you hit the 4 GB wall well before the file does.

Query Studio registers the `File` *handle* instead
(`DuckDBDataProtocol.BROWSER_FILEREADER`), so DuckDB issues range reads against the
browser's own file object and streams the scan. Memory tracks the query's working
set rather than the file size.

**On the desktop**, the renderer never touches the bytes at all. It sends a path
over IPC, gets back a schema, and from then on exchanges only SQL and result pages.
DuckDB memory-maps the file and spills to disk in the main process, so a 60 GB
Parquet costs the WebView exactly as much memory as a 60 KB CSV.

---

## Layout

```
query-studio/
├── packages/
│   └── core/                  @query-studio/core
│       └── src/
│           ├── engines/       the deterministic SQL toolkit
│           └── workbench/     the large-file query engine
│               ├── types.ts     QueryEngine contract + capabilities
│               ├── detect.ts    format sniffing (bytes, not extensions)
│               ├── sql.ts       DuckDB scan expressions, limit injection
│               ├── wasm.ts      browser + mobile backend
│               ├── native.ts    desktop backend (IPC client)
│               ├── runtime.ts   backend selection
│               ├── profile.ts   one-pass column profiling
│               ├── share.ts     permalinks — schema in, data never
│               └── export.ts    streaming export
└── apps/
    ├── web/                   Vite + React SPA — the UI all four platforms run
    ├── desktop/               Electron shell + native DuckDB
    └── mobile/                Capacitor shell
```

The UI is written against the `QueryEngine` interface and never learns which
backend it got. `apps/web` is byte-identical across browser, desktop and mobile.

---

## Getting started

```bash
npm install
npm run build:core        # the core package must build first
npm run dev               # web app on http://localhost:5173
```

### Desktop

```bash
npm run build             # core + web
npm run desktop           # dev, loads localhost:5173
npm run desktop:build     # installers into apps/desktop/release
```

Per-platform: `npm run dist:win`, `dist:mac`, `dist:linux` inside `apps/desktop`.
Targets are NSIS + portable (Windows), DMG (macOS, x64 + arm64), AppImage/deb/rpm
(Linux).

### Mobile

```bash
npm run build
cd apps/mobile
npm run add:android       # or add:ios — one time
npm run sync
npm run open:android      # or open:ios
```

Capacitor points `webDir` at `../web/dist`. There is no mobile fork of the UI or
the engine.

---

## Using the core package elsewhere

```ts
// Just the SQL toolkit — no database engine in the bundle.
import { runStudio } from "@query-studio/core/engines";

const result = runStudio({
  action: "translate",
  query: "SELECT * FROM users LIMIT 10",
  source: "mysql",
  target: "postgresql",
});
```

```ts
// The workbench.
import { createEngine, describeRuntime } from "@query-studio/core/workbench";

const engine = createEngine();          // picks WASM or native automatically
await engine.init();

const table = await engine.registerFile({ kind: "blob", file, name: file.name });
const rows = await engine.query(`SELECT * FROM ${table.name} LIMIT 100`);
```

Import the subpaths directly. The workbench pulls DuckDB behind a dynamic import,
so a page that only translates SQL never pays for a database engine.

---

## Share links

The growth mechanic, and it only works if it is trustworthy: **the link carries the
question, never the answer.**

SQL, table names, column names and types go in. Not one cell of data does — not a
sample row, not a min/max, not a distinct count. `buildSharePayload` is
structurally incapable of holding data, and the share dialog shows exactly what is
about to be encoded.

Everything rides in the URL fragment, which browsers never send to a server. A
query goes from one machine to another and nowhere else.

---

## Privacy

- No account, no sign-in, no user record.
- No analytics, no telemetry, no update ping.
- No network client in the Electron main process at all.
- Permission requests from the renderer are refused outright, so a malicious data
  file cannot turn the app into an exfiltration path.
- The desktop and mobile builds ship DuckDB's WASM assets locally rather than
  pulling them from a CDN, so opening a CSV never requires a connection.

---

## License

MIT
