// Electron main process — where the real DuckDB lives.
//
// The renderer never touches a file's bytes. It sends a path, gets back a schema,
// and from then on exchanges only SQL and result pages. That separation is what
// removes the size ceiling: DuckDB memory-maps the file and spills to disk in this
// process, so a 60 GB Parquet costs the WebView exactly as much memory as a 60 KB
// CSV — one page of rows.
//
// Everything runs locally. There is no network client in this process, no telemetry,
// no update ping, and no account. The app works with the machine offline, forever.

import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import { existsSync, statSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { cpus, totalmem } from "node:os";
import { normaliseRows } from "./values.js";
import { pathToFileURL } from "node:url";

// Loaded lazily: importing the native addon costs ~200ms and a user who opens the
// app to translate a query never needs it.
type DuckDbApi = typeof import("@duckdb/node-api");
let duckdb: DuckDbApi | null = null;

interface Connection {
  run(sql: string): Promise<unknown>;
  runAndReadAll(sql: string): Promise<ResultReader>;
  stream(sql: string): Promise<StreamingResult>;
  closeSync?(): void;
}

interface ResultReader {
  columnNames(): string[];
  columnTypes(): { toString(): string }[];
  getRows(): unknown[][];
}

interface StreamingResult {
  columnNames(): string[];
  columnTypes(): { toString(): string }[];
  fetchChunk(): Promise<{ getRows(): unknown[][] } | null>;
}

const isDev = process.argv.includes("--dev");

let mainWindow: BrowserWindow | null = null;
let connection: Connection | null = null;
let duckdbVersion = "";

/** Registered views, so `unregister` can drop the right thing. */
const registered = new Map<string, { path: string; locator: string }>();

/** In-flight streams, keyed by the subscription id handed to the renderer. */
const activeStreams = new Map<string, { cancelled: boolean }>();

// ── DuckDB ───────────────────────────────────────────────────────────────────

/**
 * DuckDB's memory ceiling, as an absolute size.
 *
 * The obvious spelling is `max_memory: "80%"`, which is what DuckDB's own docs use
 * for the CLI. It does not work here: DuckDB 1.4 accepts only KB/MB/GB/TB and their
 * KiB/MiB/GiB/TiB forms, and rejects `%` outright — at config time as an opaque
 * "Failed to set config", and via `SET` as "Unknown unit for memory: '%'". Since
 * this runs during `getConnection()`, that threw before the first query and took
 * the whole workbench with it.
 *
 * So the percentage is computed here instead. The floor matters as much as the
 * ratio: a machine reporting very little RAM should still get enough headroom for
 * DuckDB to spill rather than fail outright, and spilling is what `temp_directory`
 * above is for.
 */
function memoryBudget(): string {
  const mib = Math.floor((totalmem() * 0.8) / (1024 * 1024));
  return `${Math.max(1024, mib)}MiB`;
}

async function getConnection(): Promise<Connection> {
  if (connection) return connection;

  duckdb ??= await import("@duckdb/node-api");
  const instance = await duckdb.DuckDBInstance.create(":memory:", {
    // Let DuckDB use the machine. These are the settings that make the desktop
    // build meaningfully faster than the browser one on a large scan.
    threads: String(Math.max(2, Math.min(16, cpus().length))),
    max_memory: memoryBudget(),
    // Spilling is what lets a 40 GB aggregate finish on a 16 GB laptop instead of
    // dying. Without it, "no size limit" would be a marketing claim rather than true.
    temp_directory: join(app.getPath("temp"), "query-studio-spill"),
  });

  connection = (await instance.connect()) as unknown as Connection;

  const reader = await connection.runAndReadAll("SELECT version() AS v");
  duckdbVersion = String(reader.getRows()[0]?.[0] ?? "unknown");

  // httpfs lets the workbench read a Parquet straight off S3 or a URL. It is
  // optional — an offline machine simply skips it and everything local still works.
  await connection.run("INSTALL httpfs; LOAD httpfs;").catch(() => {});

  return connection;
}

/** DuckDB's table function for a path, chosen by extension. */
function scanExpressionFor(path: string): { sql: string; format: string } {
  const ext = extname(path).toLowerCase().replace(".", "");
  const literal = `'${path.replace(/'/g, "''")}'`;

  switch (ext) {
    case "parquet":
    case "pq":
      return { sql: `read_parquet(${literal})`, format: "parquet" };
    case "json":
      return { sql: `read_json(${literal}, format='array', ignore_errors=true)`, format: "json" };
    case "ndjson":
    case "jsonl":
      return {
        sql: `read_json(${literal}, format='newline_delimited', ignore_errors=true)`,
        format: "ndjson",
      };
    case "tsv":
    case "tab":
      return { sql: `read_csv(${literal}, delim='\t', header=true, ignore_errors=true)`, format: "tsv" };
    case "log":
    case "out":
      return {
        sql: `read_csv(${literal}, delim='', header=false, columns={'line':'VARCHAR'}, quote='', escape='', ignore_errors=true)`,
        format: "log",
      };
    default:
      // `auto_detect` handles the delimiter, so a mislabelled .txt still opens.
      return {
        sql: `read_csv(${literal}, auto_detect=true, header=true, ignore_errors=true, sample_size=32768)`,
        format: "csv",
      };
  }
}

function columnsFrom(reader: { columnNames(): string[]; columnTypes(): { toString(): string }[] }) {
  const names = reader.columnNames();
  const types = reader.columnTypes();
  return names.map((name, i) => ({
    name,
    type: types[i]?.toString() ?? "VARCHAR",
    nullable: true,
  }));
}

// ── IPC: the NativeBridge contract from @query-studio/core ────────────────────

ipcMain.handle("qs:version", async () => {
  await getConnection();
  return duckdbVersion;
});

ipcMain.handle("qs:register", async (_event, path: string, tableName: string) => {
  if (!existsSync(path)) throw new Error(`No file at ${path}`);

  const conn = await getConnection();
  const { sql: scan, format } = scanExpressionFor(path);
  const ident = `"${tableName.replace(/"/g, '""')}"`;

  await conn.run(`CREATE OR REPLACE VIEW ${ident} AS SELECT * FROM ${scan}`);
  const reader = await conn.runAndReadAll(`DESCRIBE SELECT * FROM ${ident}`);

  const columns = reader.getRows().map((row) => ({
    name: String(row[0] ?? ""),
    type: String(row[1] ?? "VARCHAR"),
    nullable: String(row[2] ?? "YES").toUpperCase() !== "NO",
  }));

  registered.set(tableName, { path, locator: path });

  return { columns, format, sizeBytes: statSync(path).size, locator: path };
});

ipcMain.handle("qs:unregister", async (_event, tableName: string) => {
  const conn = await getConnection();
  await conn.run(`DROP VIEW IF EXISTS "${tableName.replace(/"/g, '""')}"`);
  registered.delete(tableName);
});

ipcMain.handle("qs:query", async (_event, sql: string) => {
  const conn = await getConnection();
  const started = Date.now();
  const reader = await conn.runAndReadAll(sql);

  return {
    columns: columnsFrom(reader),
    rows: normaliseRows(reader.getRows()),
    elapsedMs: Date.now() - started,
  };
});

/**
 * Streaming: chunks go back over a dedicated channel keyed by subscription id.
 *
 * The renderer gets each chunk as DuckDB produces it, so a 90-million-row export
 * starts writing within a second instead of after the whole scan completes.
 */
ipcMain.handle("qs:stream-start", async (event, sql: string, limit: number | null) => {
  const conn = await getConnection();
  const id = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const state = { cancelled: false };
  activeStreams.set(id, state);

  const channel = `qs:batch:${id}`;
  const sender = event.sender;

  void (async () => {
    try {
      const result = await conn.stream(sql);
      const columns = columnsFrom(result);
      let sent = 0;

      for (;;) {
        if (state.cancelled || sender.isDestroyed()) break;

        const chunk = await result.fetchChunk();
        const rows = chunk ? chunk.getRows() : [];

        if (!chunk || rows.length === 0) {
          if (!sender.isDestroyed()) sender.send(channel, { columns, rows: [], done: true });
          break;
        }

        let out = normaliseRows(rows);
        if (limit != null && sent + out.length >= limit) {
          out = out.slice(0, Math.max(0, limit - sent));
          if (!sender.isDestroyed()) sender.send(channel, { columns, rows: out, done: true });
          break;
        }

        sent += out.length;
        if (!sender.isDestroyed()) sender.send(channel, { columns, rows: out, done: false });
      }
    } catch (error) {
      if (!sender.isDestroyed()) {
        sender.send(channel, null, error instanceof Error ? error.message : String(error));
      }
    } finally {
      activeStreams.delete(id);
    }
  })();

  return id;
});

ipcMain.handle("qs:stream-cancel", async (_event, id: string) => {
  const state = activeStreams.get(id);
  if (state) state.cancelled = true;
});

/** Native open dialog — the desktop path to getting a file in. */
ipcMain.handle("qs:open-files", async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    title: "Open data files",
    properties: ["openFile", "multiSelections"],
    filters: [
      { name: "Data files", extensions: ["csv", "tsv", "txt", "json", "ndjson", "jsonl", "parquet", "pq", "log", "arrow"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (result.canceled) return [];

  return result.filePaths.map((path) => ({
    path,
    name: basename(path),
    sizeBytes: statSync(path).size,
  }));
});

/** Native save dialog, for streaming an export straight to disk. */
ipcMain.handle("qs:save-dialog", async (_event, suggestedName: string) => {
  const result = await dialog.showSaveDialog(mainWindow!, {
    title: "Export results",
    defaultPath: suggestedName,
  });
  return result.canceled ? null : result.filePath;
});

/** `COPY … TO` writes the file inside DuckDB, so the rows never cross into JS at all. */
ipcMain.handle("qs:export", async (_event, sql: string, destination: string, format: string) => {
  const conn = await getConnection();
  const dest = `'${destination.replace(/'/g, "''")}'`;
  const inner = sql.trim().replace(/;\s*$/, "");

  const options =
    format === "parquet" ? "(FORMAT PARQUET)"
    : format === "json" ? "(FORMAT JSON, ARRAY true)"
    : format === "ndjson" ? "(FORMAT JSON)"
    : format === "tsv" ? "(FORMAT CSV, DELIMITER '\t', HEADER)"
    : "(FORMAT CSV, HEADER)";

  const started = Date.now();
  await conn.run(`COPY (${inner}) TO ${dest} ${options}`);
  return { path: destination, elapsedMs: Date.now() - started, sizeBytes: statSync(destination).size };
});

// ── Window ───────────────────────────────────────────────────────────────────

/**
 * Where the built web app lives.
 *
 * Packaged, electron-builder copies apps/web/dist to resources/app — that is the
 * `extraResources` entry in package.json. Unpackaged (`npm start`, which is how
 * anyone smoke-tests a production build before spending twenty minutes on an
 * installer), `process.resourcesPath` points at Electron's own resources
 * directory, where there is no `app/index.html` and never will be. The result was
 * a blank window with `ERR_FILE_NOT_FOUND` in a devtools console that is closed
 * outside dev mode.
 *
 * So the packaged location is tried first and the repo layout is the fallback.
 */
function rendererEntry(): string {
  const packaged = join(process.resourcesPath, "app", "index.html");
  if (existsSync(packaged)) return packaged;

  const fromRepo = join(__dirname, "..", "..", "web", "dist", "index.html");
  if (existsSync(fromRepo)) return fromRepo;

  // Neither exists: say which two places were checked rather than showing a blank
  // window. `npm run build` at the repo root is what fills the second one in.
  dialog.showErrorBox(
    "Query Studio could not start",
    `The app UI is missing. Looked in:

${packaged}
${fromRepo}

` +
      "Run `npm run build` at the repo root to build it.",
  );
  app.quit();
  return packaged;
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: "#0e0e12",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());

  if (isDev) {
    void mainWindow.loadURL("http://localhost:5173");
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    void mainWindow.loadFile(rendererEntry());
  }

  // Any http(s) link opens in the real browser, never inside the app shell.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http:") || url.startsWith("https:")) void shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function buildMenu(): void {
  const isMac = process.platform === "darwin";

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(isMac ? [{ role: "appMenu" as const }] : []),
      {
        label: "File",
        submenu: [
          {
            label: "Open Files…",
            accelerator: "CmdOrCtrl+O",
            click: () => mainWindow?.webContents.send("qs:menu", "open"),
          },
          {
            label: "Export Results…",
            accelerator: "CmdOrCtrl+E",
            click: () => mainWindow?.webContents.send("qs:menu", "export"),
          },
          { type: "separator" },
          isMac ? { role: "close" as const } : { role: "quit" as const },
        ],
      },
      { role: "editMenu" },
      {
        label: "Query",
        submenu: [
          {
            label: "Run",
            accelerator: "CmdOrCtrl+Return",
            click: () => mainWindow?.webContents.send("qs:menu", "run"),
          },
          {
            label: "Copy Share Link",
            accelerator: "CmdOrCtrl+Shift+C",
            click: () => mainWindow?.webContents.send("qs:menu", "share"),
          },
        ],
      },
      { role: "viewMenu" },
      { role: "windowMenu" },
      {
        role: "help",
        submenu: [
          {
            label: "Query Studio on the web",
            click: () => void shell.openExternal("https://glitchbong.com/tools/query-studio"),
          },
        ],
      },
    ]),
  );
}

/** Files opened via "Open with" or a command-line argument. */
function pendingFilesFromArgv(argv: string[]): string[] {
  return argv
    .slice(isDev ? 2 : 1)
    .filter((arg) => !arg.startsWith("-") && existsSync(arg) && statSync(arg).isFile());
}

// Single instance: a second launch hands its files to the running window rather
// than opening a second DuckDB.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    const files = pendingFilesFromArgv(argv);
    if (files.length) mainWindow.webContents.send("qs:open-paths", files);
  });

  void app.whenReady().then(() => {
    createWindow();
    buildMenu();

    const initial = pendingFilesFromArgv(process.argv);
    if (initial.length) {
      mainWindow?.webContents.once("did-finish-load", () => {
        mainWindow?.webContents.send("qs:open-paths", initial);
      });
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // macOS "Open with Query Studio".
  app.on("open-file", (event, path) => {
    event.preventDefault();
    if (mainWindow) mainWindow.webContents.send("qs:open-paths", [path]);
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    connection?.closeSync?.();
  });
}

// Nothing in this app talks to the network on its own. Refusing permission requests
// outright means a malicious CSV cannot turn the app into an exfiltration path.
app.on("web-contents-created", (_event, contents) => {
  contents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  contents.on("will-navigate", (event, url) => {
    const allowed = isDev ? url.startsWith("http://localhost:5173") : url.startsWith(pathToFileURL(process.resourcesPath).toString());
    if (!allowed) event.preventDefault();
  });
});
