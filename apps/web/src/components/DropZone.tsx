// Getting files in, on all four platforms.
//
// Three routes end up in the same place:
//   • Drag and drop — browser and desktop.
//   • The native picker — desktop only, and the one that matters there, because it
//     hands back a path rather than a File and so never copies the bytes.
//   • `<input type="file">` — the fallback everywhere, and the *primary* route on
//     mobile, where both WebViews expose the OS file provider through it.
//
// The mobile case is worth stating explicitly: it would be tempting to reach for
// Capacitor's Filesystem plugin there, but it returns base64, which means holding
// the whole file in memory as a string before DuckDB ever sees it. A plain file
// input gives a real `File`, which streams. The boring option is the correct one.

import { useCallback, useRef, useState } from "react";
import { formatBytes } from "@query-studio/core/workbench";
import type { Workbench } from "../hooks/useWorkbench";
import { desktopApi } from "../platform";

const ACCEPT = ".csv,.tsv,.tab,.txt,.json,.ndjson,.jsonl,.parquet,.pq,.log,.out,.arrow";

export default function DropZone({ workbench }: { workbench: Workbench }) {
  const { addBlobs, addPaths, loadingFiles, dismissLoadError, platform, runtime } = workbench;
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const api = desktopApi();

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      setDragging(false);

      const files = Array.from(event.dataTransfer.files);
      if (files.length === 0) return;

      // In Electron a dropped File still carries an absolute `path`. Using it keeps
      // the desktop build on the zero-copy route even for drag and drop.
      if (api) {
        const withPaths = files
          .map((file) => ({
            path: (file as File & { path?: string }).path ?? "",
            name: file.name,
            sizeBytes: file.size,
          }))
          .filter((f) => f.path);

        if (withPaths.length === files.length) {
          void addPaths(withPaths);
          return;
        }
      }

      void addBlobs(files);
    },
    [addBlobs, addPaths, api],
  );

  const browse = useCallback(() => {
    if (api) {
      void api.openFiles().then((files) => { if (files.length > 0) void addPaths(files); });
      return;
    }
    inputRef.current?.click();
  }, [api, addPaths]);

  const hasErrors = loadingFiles.some((f) => f.error);

  return (
    <div
      className={`dropzone${dragging ? " dropzone-active" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPT}
        className="sr-only"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length) void addBlobs(files);
          // Reset so re-picking the same file fires change again.
          e.target.value = "";
        }}
      />

      <div className="dropzone-body">
        <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
          <path d="M12 16V4m0 0L8 8m4-4 4 4" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" strokeLinecap="round" />
        </svg>

        <p className="dropzone-title">Drop a data file</p>
        <p className="dropzone-formats">CSV · TSV · JSON · NDJSON · Parquet · Arrow · logs</p>

        <button type="button" className="btn btn-primary" onClick={browse}>
          Choose files
        </button>

        {runtime && (
          <p className="dropzone-limit">
            {runtime.limitText}
            {platform.suggestDesktop && runtime.kind === "wasm" && (
              <>
                {" "}
                <a href="https://glitchbong.com/tools/query-studio/download" target="_blank" rel="noreferrer">
                  Get the desktop app
                </a>{" "}
                for files of any size.
              </>
            )}
          </p>
        )}

        <p className="dropzone-privacy">
          Files are read on this device. Nothing is uploaded, and there is no account.
        </p>
      </div>

      {hasErrors && (
        <ul className="dropzone-errors">
          {loadingFiles
            .filter((f) => f.error)
            .map((file) => (
              <li key={file.name}>
                <div>
                  <strong>{file.name}</strong>
                  <span className="dropzone-error-size">{formatBytes(file.sizeBytes)}</span>
                  <p>{file.error}</p>
                </div>
                <button type="button" className="btn-icon" onClick={() => dismissLoadError(file.name)} aria-label={`Dismiss ${file.name}`}>
                  ×
                </button>
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}
