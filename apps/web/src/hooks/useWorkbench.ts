// All workbench state in one hook.
//
// The components below it are dumb on purpose: every piece of state that more than
// one of them touches — the engine, the loaded tables, the current query, the last
// result — lives here, so there is exactly one place where "what is the app doing
// right now" is answered. That matters more than usual in this app because the same
// hook drives four platforms, and a bug that only reproduces on Android is much
// easier to find when the state machine is not scattered across ten components.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildPreviewQuery,
  buildSharePayload,
  buildStarterQuery,
  checkFileSize,
  createEngine,
  describeRuntime,
  matchSources,
  profileTable,
  readShareUrl,
  selfHosted,
  type QueryEngine,
  type QueryResult,
  type RuntimeDescription,
  type SharePayload,
  type SourceMatch,
  type SourceFile,
  type TableHandle,
  type TableProfile,
} from "@query-studio/core/workbench";
import { desktopApi, platformProfile, wasmAssetBase } from "../platform";

export interface LoadingFile {
  name: string;
  sizeBytes: number;
  /** Set when the file was refused before any work started. */
  error?: string;
}

export interface WorkbenchState {
  ready: boolean;
  runtime: RuntimeDescription | null;
  tables: TableHandle[];
  sql: string;
  result: QueryResult | null;
  error: string | null;
  running: boolean;
  loadingFiles: LoadingFile[];
  profiles: Record<string, TableProfile>;
  /** Set when the session was opened from a share link. */
  sharedFrom: SharePayload | null;
  /** How the loaded tables line up with what a share link expected. */
  sourceMatches: SourceMatch[];
}

export function useWorkbench() {
  const profile = useMemo(platformProfile, []);
  const engineRef = useRef<QueryEngine | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [ready, setReady] = useState(false);
  const [runtime, setRuntime] = useState<RuntimeDescription | null>(null);
  const [tables, setTables] = useState<TableHandle[]>([]);
  const [sql, setSql] = useState("");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [loadingFiles, setLoadingFiles] = useState<LoadingFile[]>([]);
  const [profiles, setProfiles] = useState<Record<string, TableProfile>>({});
  const [sharedFrom, setSharedFrom] = useState<SharePayload | null>(null);

  // ── engine boot ────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const assetBase = wasmAssetBase();
      const engine = createEngine({
        memoryCeilingBytes: profile.memoryCeilingBytes,
        ...(assetBase ? { bundle: selfHosted(assetBase) } : {}),
      });

      try {
        await engine.init();
        if (cancelled) {
          void engine.dispose();
          return;
        }
        engineRef.current = engine;
        setRuntime(describeRuntime(engine));
        setReady(true);
      } catch (e) {
        if (!cancelled) setError(describeError(e, "Could not start the query engine."));
      }
    })();

    return () => {
      cancelled = true;
      void engineRef.current?.dispose();
      engineRef.current = null;
    };
  }, [profile.memoryCeilingBytes]);

  // ── share link on open ─────────────────────────────────────────────────────
  useEffect(() => {
    void (async () => {
      const payload = await readShareUrl(window.location.href);
      if (!payload) return;
      setSharedFrom(payload);
      setSql(payload.sql);
    })();
  }, []);

  // ── loading files ──────────────────────────────────────────────────────────

  /**
   * Register files and open the first one.
   *
   * Files are checked against the runtime's ceiling *before* anything is read, so
   * an oversized drop produces an immediate, specific message instead of a crash
   * partway through a load.
   */
  const addFiles = useCallback(
    async (sources: SourceFile[]) => {
      const engine = engineRef.current;
      if (!engine) return;

      setError(null);
      setLoadingFiles(
        sources.map((s) => ({
          name: s.name,
          sizeBytes: s.kind === "blob" ? s.file.size : s.sizeBytes,
        })),
      );

      const added: TableHandle[] = [];

      for (const source of sources) {
        const size = source.kind === "blob" ? source.file.size : source.sizeBytes;
        const check = checkFileSize(size, engine);

        if (!check.ok) {
          setLoadingFiles((prev) =>
            prev.map((f) =>
              f.name === source.name
                ? {
                    ...f,
                    error: check.desktopWouldWork
                      ? `${check.message} The desktop app opens it with no limit.`
                      : check.message,
                  }
                : f,
            ),
          );
          continue;
        }

        try {
          added.push(await engine.registerFile(source));
        } catch (e) {
          setLoadingFiles((prev) =>
            prev.map((f) => (f.name === source.name ? { ...f, error: describeError(e, "Could not open this file.") } : f)),
          );
        }
      }

      if (added.length > 0) {
        const next = engine.tables();
        setTables(next);
        // Only seed the editor when the user has not written anything yet — a
        // second dropped file must never wipe a query someone is mid-way through.
        setSql((current) => (current.trim() ? current : buildStarterQuery(next)));
      }

      // Successful entries clear; refused ones stay visible until dismissed.
      setLoadingFiles((prev) => prev.filter((f) => f.error));
    },
    [],
  );

  /** Browser and mobile: File objects straight from a drop or picker. */
  const addBlobs = useCallback(
    (files: File[]) => addFiles(files.map((file) => ({ kind: "blob" as const, file, name: file.name }))),
    [addFiles],
  );

  /** Desktop: paths, so the bytes never enter the renderer. */
  const addPaths = useCallback(
    async (paths: { path: string; name: string; sizeBytes: number }[]) =>
      addFiles(paths.map((p) => ({ kind: "path" as const, ...p }))),
    [addFiles],
  );

  const removeTable = useCallback(async (tableId: string) => {
    const engine = engineRef.current;
    if (!engine) return;
    await engine.unregister(tableId);
    setTables(engine.tables());
    setProfiles((prev) => {
      const next = { ...prev };
      delete next[tableId];
      return next;
    });
  }, []);

  const dismissLoadError = useCallback((name: string) => {
    setLoadingFiles((prev) => prev.filter((f) => f.name !== name));
  }, []);

  // ── running queries ────────────────────────────────────────────────────────

  const run = useCallback(
    async (override?: string) => {
      const engine = engineRef.current;
      const statement = (override ?? sql).trim();
      if (!engine || !statement) return;

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setRunning(true);
      setError(null);

      try {
        const next = await engine.query(statement, { limit: 1000, signal: controller.signal });
        if (!controller.signal.aborted) setResult(next);
      } catch (e) {
        if (!controller.signal.aborted) {
          setError(describeError(e, "The query failed."));
          setResult(null);
        }
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
          setRunning(false);
        }
      }
    },
    [sql],
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setRunning(false);
  }, []);

  /** Preview a table — the click target on every row of the sidebar. */
  const previewTable = useCallback(
    (table: TableHandle) => {
      const statement = buildPreviewQuery(table.name);
      setSql(statement);
      void run(statement);
    },
    [run],
  );

  /** One-pass column profile. Cached — the second click is instant. */
  const profileFor = useCallback(
    async (table: TableHandle): Promise<TableProfile | null> => {
      const engine = engineRef.current;
      if (!engine) return null;
      if (profiles[table.id]) return profiles[table.id];

      try {
        const computed = await profileTable(engine, table);
        setProfiles((prev) => ({ ...prev, [table.id]: computed }));
        setTables(engine.tables());
        return computed;
      } catch (e) {
        setError(describeError(e, "Could not profile this table."));
        return null;
      }
    },
    [profiles],
  );

  // ── sharing ────────────────────────────────────────────────────────────────

  const sharePayload = useCallback(() => buildSharePayload(sql, tables), [sql, tables]);

  const sourceMatches = useMemo(
    () => (sharedFrom ? matchSources(sharedFrom, tables) : []),
    [sharedFrom, tables],
  );

  // ── desktop wiring ─────────────────────────────────────────────────────────
  //
  // "Open with Query Studio", the command line, and the native File menu all end up
  // here, so the desktop build behaves like a real application rather than a web
  // page in a frame.
  useEffect(() => {
    const api = desktopApi();
    if (!api) return;

    const offPaths = api.onOpenPaths((paths) => {
      void addPaths(
        paths.map((path) => ({
          path,
          name: path.split(/[\\/]/).pop() ?? path,
          sizeBytes: 0,
        })),
      );
    });

    const offMenu = api.onMenu((command) => {
      if (command === "open") void api.openFiles().then((files) => { if (files.length) void addPaths(files); });
      if (command === "run") void run();
    });

    return () => {
      offPaths();
      offMenu();
    };
  }, [addPaths, run]);

  // ── keyboard ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        void run();
      }
      if (e.key === "Escape" && running) cancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [run, running, cancel]);

  return {
    // state
    ready,
    runtime,
    tables,
    sql,
    result,
    error,
    running,
    loadingFiles,
    profiles,
    sharedFrom,
    sourceMatches,
    platform: profile,
    engine: engineRef,
    // actions
    setSql,
    addBlobs,
    addPaths,
    removeTable,
    dismissLoadError,
    run,
    cancel,
    previewTable,
    profileFor,
    sharePayload,
    clearError: () => setError(null),
  };
}

export type Workbench = ReturnType<typeof useWorkbench>;

/**
 * Turn an engine error into something a person can act on.
 *
 * DuckDB's messages are genuinely good — it names the column it could not find and
 * suggests the one you probably meant — so they are passed through rather than
 * replaced. What gets stripped is the binder/parser prefix noise, which is a fact
 * about DuckDB's internals and not about the user's query.
 */
function describeError(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  if (!raw) return fallback;

  return raw
    .replace(/^(Binder|Parser|Catalog|Conversion|IO|Invalid Input|Out of Memory)\s+Error:\s*/i, "")
    .replace(/^Error:\s*/i, "")
    .trim() || fallback;
}
