// The share dialog.
//
// This is the growth loop, so it has to be trustworthy before it is convenient. The
// dialog shows exactly what is about to be encoded — the SQL, and the table and
// column names it references — and says plainly that no data goes in. That claim is
// enforced in `buildSharePayload`, which physically cannot carry a cell value; the
// dialog just makes the guarantee visible at the moment someone is deciding whether
// to paste a link into a work channel.
//
// The link is a URL fragment, so even the SQL never reaches a server: fragments are
// not sent in HTTP requests. Two people can trade a query through a link that no
// third party ever sees.

import { useEffect, useState } from "react";
import { buildShareUrl, checkShareSize, type SharePayload } from "@query-studio/core/workbench";

interface Props {
  payload: SharePayload;
  /** Page the link should open. Defaults to this app's own URL. */
  baseUrl?: string;
  onClose: () => void;
}

export default function ShareDialog({ payload, baseUrl, onClose }: Props) {
  const [url, setUrl] = useState<string | null>(null);
  const [sizeWarning, setSizeWarning] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void (async () => {
      const base = baseUrl ?? window.location.href.split("#")[0];
      setUrl(await buildShareUrl(base, payload));

      const check = await checkShareSize(payload);
      setSizeWarning(check.ok ? null : (check.advice ?? "This link may be too long to paste reliably."));
    })();
  }, [payload, baseUrl]);

  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard is blocked in some WebViews and over plain http. The input is
      // selectable, so there is still a way through — just say so.
      setSizeWarning("Could not reach the clipboard. Select the link and copy it manually.");
    }
  };

  const columnCount = payload.sources.reduce((n, s) => n + s.columns.length, 0);

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <h2 id="share-title">Share this query</h2>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="modal-body">
          <p className="share-lede">
            Anyone opening this link gets your query and the schema it expects, ready to run against
            their own copy of the files.
          </p>

          <div className="share-contents">
            <p className="share-contents-title">What goes in the link</p>
            <ul className="share-in">
              <li>
                <span className="tick" aria-hidden>
                  ✓
                </span>
                The SQL, exactly as written
              </li>
              <li>
                <span className="tick" aria-hidden>
                  ✓
                </span>
                {payload.sources.length} {payload.sources.length === 1 ? "table" : "tables"} and{" "}
                {columnCount} column {columnCount === 1 ? "name" : "names"}, with their types
              </li>
            </ul>
            <ul className="share-out">
              <li>
                <span className="cross" aria-hidden>
                  ×
                </span>
                No rows, no cell values, not even a sample
              </li>
              <li>
                <span className="cross" aria-hidden>
                  ×
                </span>
                No file contents, and nothing uploaded anywhere
              </li>
            </ul>
          </div>

          <label className="share-url-label" htmlFor="share-url">
            Link
          </label>
          <div className="share-url-row">
            <input
              id="share-url"
              className="share-url"
              value={url ?? "Building link…"}
              readOnly
              onFocus={(e) => e.currentTarget.select()}
            />
            <button type="button" className="btn btn-primary" onClick={copy} disabled={!url}>
              {copied ? "Copied" : "Copy"}
            </button>
          </div>

          {sizeWarning && <p className="share-warning">{sizeWarning}</p>}

          <p className="share-note">
            The query travels in the part of the URL after <code>#</code>, which browsers never send
            to a server. It goes from your machine to theirs and nowhere else.
          </p>
        </div>
      </div>
    </div>
  );
}
