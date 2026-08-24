// The workbench shell.
//
// One layout for four platforms. Nothing here branches on "am I in Electron" beyond
// picking which export route to offer, because the engine abstraction already
// absorbed the difference — the desktop build is the same React tree talking to a
// different `QueryEngine`.

import { useCallback, useState } from "react";
import {
  createBlobSink,
  createFileSink,
  exportQuery,
  extensionFor,
  formatBytes,
  mimeFor,
  type ExportFormat,
} from "@query-studio/core/workbench";
import { useWorkbench } from "./hooks/useWorkbench";
import { desktopApi, modifierKey } from "./platform";
import DropZone from "./components/DropZone";
import TableList from "./components/TableList";
import SqlEditor from "./components/SqlEditor";
import ResultGrid from "./components/ResultGrid";
import ShareDialog from "./components/ShareDialog";

const EXPORT_FORMATS: { id: ExportFormat; label: string }[] = [
  { id: "csv", label: "CSV" },
  { id: "tsv", label: "TSV" },
  { id: "json", label: "JSON" },
  { id: "ndjson", label: "NDJSON" },
];

export default function App() {
  const workbench = useWorkbench();
  const {
    ready, runtime, tables, sql, result, error, running, sharedFrom, sourceMatches,
    setSql, run, cancel, sharePayload, engine, platform,
  } = workbench;

  const [showShare, setShowShare] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);
  const mod = modifierKey();
  const api = desktopApi();

  /**
   * Export the current query's full result — not the 1,000-row page on screen.
   *
   * Three routes, best first. On desktop DuckDB writes the file itself, so the rows
   * never enter the renderer and a 200-million-row export runs at disk speed. In a
   * Chromium browser the File System Access API streams batch by batch. Everywhere
   * else it buffers into a Blob, which is the only route that has a real ceiling —
   * so that is the one that warns.
   */
  const doExport = useCallback(
    async (format: ExportFormat) => {
      const current = engine.current;
      if (!current || !sql.trim()) return;

      setShowExport(false);
      setExporting(format);

      const fileName = `query-result.${extensionFor(format)}`;

      try {
        if (api) {
          const destination = await api.saveDialog(fileName);
          if (destination) {
            const written = await api.exportTo(sql, destination, format);
            setExporting(null);
            window.alert(`Exported ${formatBytes(written.sizeBytes)} to ${written.path}`);
          } else {
            setExporting(null);
          }
          return;
        }

        const streaming = await createFileSink(fileName);
        if (streaming) {
          await exportQuery(current, sql, streaming, { format, limit: null });
        } else {
          const sink = createBlobSink(fileName, mimeFor(format));
          await exportQuery(current, sql, sink, { format, limit: null });
          sink.download();
        }
      } catch (e) {
        window.alert(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setExporting(null);
      }
    },
    [engine, sql, api],
  );

  const hasTables = tables.length > 0;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <Mark />
          <div>
            <span className="brand-name">Query Studio</span>
            <span className="brand-sub">Workbench</span>
          </div>
        </div>

        {runtime && (
          <span
            className={`runtime runtime-${runtime.kind}`}
            title={runtime.limitText}
          >
            <span className="runtime-dot" aria-hidden />
            {runtime.label}
          </span>
        )}

        <div className="topbar-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => (running ? cancel() : run())}
            disabled={!ready || !sql.trim()}
            title={`${mod}+Enter`}
          >
            {running ? "Cancel" : "Run"}
          </button>

          <div className="menu-wrap">
            <button
              type="button"
              className="btn"
              onClick={() => setShowExport((v) => !v)}
              disabled={!result || running}
              aria-expanded={showExport}
            >
              {exporting ? `Exporting ${exporting.toUpperCase()}…` : "Export"}
            </button>
            {showExport && (
              <ul className="menu" role="menu">
                {EXPORT_FORMATS.map((format) => (
                  <li key={format.id} role="none">
                    <button type="button" role="menuitem" onClick={() => void doExport(format.id)}>
                      {format.label}
                      <span className="menu-hint">full result</span>
                    </button>
                  </li>
                ))}
                {api && (
                  <li role="none">
                    <button type="button" role="menuitem" onClick={() => void doExport("csv" as ExportFormat)}>
                      Parquet
                      <span className="menu-hint">written by DuckDB</span>
                    </button>
                  </li>
                )}
              </ul>
            )}
          </div>

          <button
            type="button"
            className="btn"
            onClick={() => setShowShare(true)}
            disabled={!sql.trim()}
            title="Share the query, never the data"
          >
            Share
          </button>
        </div>
      </header>

      {sharedFrom && (
        <SharedBanner matches={sourceMatches} hasTables={hasTables} note={sharedFrom.note} />
      )}

      <div className="layout">
        <aside className="sidebar">
          {hasTables ? (
            <>
              <div className="sidebar-head">
                <h2>Tables</h2>
                <span className="sidebar-count">{tables.length}</span>
              </div>
              <TableList workbench={workbench} />
              <div className="sidebar-foot">
                <DropZone workbench={workbench} />
              </div>
            </>
          ) : (
            <DropZone workbench={workbench} />
          )}
        </aside>

        <main className="main">
          <section className="editor-pane">
            <SqlEditor
              value={sql}
              onChange={setSql}
              onRun={() => void run()}
              tables={tables}
              disabled={!ready}
            />
            <p className="editor-hint">
              {ready ? (
                <>
                  <kbd>{mod}</kbd> + <kbd>Enter</kbd> to run
                  {platform.platform === "browser" && " · nothing leaves this tab"}
                </>
              ) : (
                "Starting the query engine…"
              )}
            </p>
          </section>

          <section className="result-pane">
            <ResultGrid
              result={result}
              running={running}
              error={error}
              emptyHint={
                hasTables
                  ? "Write a query and press Run."
                  : "Drop a file on the left to get started."
              }
            />
          </section>
        </main>
      </div>

      {showShare && <ShareDialog payload={sharePayload()} onClose={() => setShowShare(false)} />}
    </div>
  );
}

/**
 * The banner a shared link opens with.
 *
 * A recipient's first experience is otherwise a query referencing tables they have
 * not loaded, which fails with a catalog error and tells them nothing. This says
 * what to open, and once they have opened it, confirms the schema matches.
 */
function SharedBanner({
  matches,
  hasTables,
  note,
}: {
  matches: { expected: { fileName: string; name: string }; matched: unknown; missingColumns: string[] }[];
  hasTables: boolean;
  note?: string;
}) {
  const missing = matches.filter((m) => !m.matched);
  const drifted = matches.filter((m) => m.matched && m.missingColumns.length > 0);

  if (!hasTables) {
    return (
      <div className="banner banner-info">
        <strong>Shared query loaded.</strong>{" "}
        {note && <em>“{note}” </em>}
        Open{" "}
        {matches.map((m, i) => (
          <span key={m.expected.name}>
            {i > 0 && ", "}
            <code>{m.expected.fileName}</code>
          </span>
        ))}{" "}
        to run it. Your file never leaves this device.
      </div>
    );
  }

  if (missing.length > 0) {
    return (
      <div className="banner banner-warn">
        <strong>Still missing:</strong>{" "}
        {missing.map((m, i) => (
          <span key={m.expected.name}>
            {i > 0 && ", "}
            <code>{m.expected.fileName}</code>
          </span>
        ))}
      </div>
    );
  }

  if (drifted.length > 0) {
    return (
      <div className="banner banner-warn">
        <strong>Schema differs from the shared query.</strong> Missing{" "}
        {drifted.map((m, i) => (
          <span key={m.expected.name}>
            {i > 0 && "; "}
            <code>{m.missingColumns.join(", ")}</code> in {m.expected.name}
          </span>
        ))}
        . The query may need adjusting.
      </div>
    );
  }

  return (
    <div className="banner banner-ok">
      <strong>Ready.</strong> Your files match the shared query&rsquo;s schema.
    </div>
  );
}

function Mark() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <ellipse cx="12" cy="6" rx="7.5" ry="3" />
      <path d="M4.5 6v12c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3V6" strokeLinecap="round" />
      <path d="M4.5 12c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3" strokeLinecap="round" />
    </svg>
  );
}
