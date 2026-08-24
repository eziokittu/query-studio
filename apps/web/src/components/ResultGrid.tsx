// The results table.
//
// Windowed, because the entire point of this tool is result sets that a normal table
// cannot render. A thousand rows across forty columns is forty thousand DOM nodes,
// which is already enough to make scrolling stutter on a laptop and janky on a
// phone; the pages this app produces go well past that.
//
// So only the rows inside the viewport (plus a small overscan) are mounted, and the
// scrollbar is faked with a spacer sized to the full row count. Memory and paint
// cost track the window, not the result — scrolling a 100,000-row page costs exactly
// what scrolling a 30-row page costs.
//
// Deliberately hand-rolled rather than pulled from a virtualisation library: the
// requirement is one fixed row height and one scroll container, and the whole
// implementation is shorter than the dependency's options object.

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { QueryResult } from "@query-studio/core/workbench";

const ROW_HEIGHT = 30;
/** Rows rendered beyond the viewport so a fast flick does not show blank space. */
const OVERSCAN = 8;

interface Props {
  result: QueryResult | null;
  running: boolean;
  error: string | null;
  /** Shown in the empty state, so a fresh session says something useful. */
  emptyHint?: string;
}

export default function ResultGrid({ result, running, error, emptyHint }: Props) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(400);

  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
  }, []);

  // Track the scroller's height so the window size adapts to a resized panel.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      setViewportHeight(entry.contentRect.height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Reset the scroll position when a new result arrives — staying at row 4,000 of a
  // result that no longer exists is disorienting.
  useLayoutEffect(() => {
    scrollerRef.current?.scrollTo({ top: 0 });
    setScrollTop(0);
  }, [result]);

  const rows = result?.rows ?? [];
  const columns = result?.columns ?? [];

  const { startIndex, endIndex, offsetY } = useMemo(() => {
    const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const visible = Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2;
    const end = Math.min(rows.length, start + visible);
    return { startIndex: start, endIndex: end, offsetY: start * ROW_HEIGHT };
  }, [scrollTop, viewportHeight, rows.length]);

  if (running) {
    return (
      <div className="grid-state">
        <div className="spinner" aria-hidden />
        <p>Running…</p>
        <p className="grid-state-hint">Press Esc to cancel.</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="grid-state grid-state-error" role="alert">
        <p className="grid-state-title">Query failed</p>
        <p className="grid-state-message">{error}</p>
      </div>
    );
  }

  if (!result) {
    return (
      <div className="grid-state">
        <p>{emptyHint ?? "Results appear here."}</p>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="grid-state">
        <p className="grid-state-title">No rows</p>
        <p className="grid-state-hint">The query ran in {formatMs(result.elapsedMs)} and matched nothing.</p>
      </div>
    );
  }

  return (
    <div className="grid-wrap">
      <div className="grid-scroller" ref={scrollerRef} onScroll={onScroll} tabIndex={0}>
        <table className="grid" style={{ width: "max-content", minWidth: "100%" }}>
          <thead>
            <tr>
              <th className="grid-rownum" scope="col">
                <span className="sr-only">Row</span>
              </th>
              {columns.map((column) => (
                <th key={column.name} scope="col" title={`${column.name} · ${column.type}`}>
                  <span className="grid-colname">{column.name}</span>
                  <span className="grid-coltype">{shortType(column.type)}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {/* Spacer above the window, so the rendered rows sit at the right offset. */}
            {startIndex > 0 && <tr style={{ height: offsetY }} aria-hidden />}

            {rows.slice(startIndex, endIndex).map((row, i) => {
              const rowIndex = startIndex + i;
              return (
                <tr key={rowIndex} style={{ height: ROW_HEIGHT }}>
                  <td className="grid-rownum">{(rowIndex + 1).toLocaleString()}</td>
                  {row.map((value, c) => (
                    <Cell key={c} value={value} />
                  ))}
                </tr>
              );
            })}

            {/* Spacer below, so the scrollbar reflects the full result. */}
            {endIndex < rows.length && (
              <tr style={{ height: (rows.length - endIndex) * ROW_HEIGHT }} aria-hidden />
            )}
          </tbody>
        </table>
      </div>

      <footer className="grid-footer">
        <span>
          <strong>{rows.length.toLocaleString()}</strong> {rows.length === 1 ? "row" : "rows"}
        </span>
        <span>{columns.length} columns</span>
        <span>{formatMs(result.elapsedMs)}</span>
        {result.truncated && (
          <span
            className="grid-truncated"
            title={`A LIMIT was added so the page stays responsive. The statement that ran:\n\n${result.executedSql}`}
          >
            limited to 1,000 — export for everything
          </span>
        )}
      </footer>
    </div>
  );
}

/**
 * One cell.
 *
 * NULL renders as a dimmed marker rather than an empty cell, because "empty string"
 * and "no value" are different facts about the data and a blank cell hides which one
 * you are looking at.
 */
function Cell({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return (
      <td className="grid-null">
        <span>NULL</span>
      </td>
    );
  }

  const text = String(value);
  const numeric = typeof value === "number" || (typeof value === "string" && isNumericString(text));

  return (
    <td className={numeric ? "grid-numeric" : undefined} title={text.length > 60 ? text : undefined}>
      {text.length > 200 ? `${text.slice(0, 200)}…` : text}
    </td>
  );
}

/**
 * Whether to right-align a value.
 *
 * BIGINT arrives as a string to keep it exact, so a type check alone would
 * left-align ids and counts. Testing the string keeps columns lining up.
 */
function isNumericString(text: string): boolean {
  return text.length > 0 && text.length < 32 && /^-?\d+(\.\d+)?$/.test(text);
}

/** `DECIMAL(18,2)` → `DECIMAL`, so the header stays narrow. */
function shortType(type: string): string {
  return type.replace(/\(.*\)$/, "").replace(/^VARCHAR$/, "TEXT").toLowerCase();
}

function formatMs(ms: number): string {
  if (ms < 1) return "<1 ms";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}
