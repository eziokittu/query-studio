// The sidebar: what is loaded, what is in it, and what to ask it.
//
// Each table expands to its columns, and each column carries the profile badges
// once a profile has been run — unique, constant, mostly-null and friends. Those
// badges are the answer to the question people actually open a strange 4 GB export
// to ask, and putting them next to the column name means you get the answer while
// deciding what to query rather than after three failed attempts.

import { useState } from "react";
import { formatBytes, FLAG_COPY, suggestQueries, type TableHandle } from "@query-studio/core/workbench";
import type { Workbench } from "../hooks/useWorkbench";

export default function TableList({ workbench }: { workbench: Workbench }) {
  const { tables, profiles, previewTable, removeTable, profileFor, setSql, run } = workbench;
  const [expanded, setExpanded] = useState<string | null>(tables[0]?.id ?? null);
  const [profiling, setProfiling] = useState<string | null>(null);

  if (tables.length === 0) {
    return (
      <div className="sidebar-empty">
        <p>No files loaded yet.</p>
      </div>
    );
  }

  const runProfile = async (table: TableHandle) => {
    setProfiling(table.id);
    await profileFor(table);
    setProfiling(null);
  };

  return (
    <ul className="tables">
      {tables.map((table) => {
        const open = expanded === table.id;
        const profile = profiles[table.id];

        return (
          <li key={table.id} className={`table-item${open ? " table-open" : ""}`}>
            <div className="table-head">
              <button
                type="button"
                className="table-toggle"
                onClick={() => setExpanded(open ? null : table.id)}
                aria-expanded={open}
              >
                <span className={`chevron${open ? " chevron-open" : ""}`} aria-hidden>
                  ›
                </span>
                <span className="table-name">{table.name}</span>
              </button>

              <button
                type="button"
                className="btn-icon"
                title={`Remove ${table.fileName}`}
                aria-label={`Remove ${table.fileName}`}
                onClick={() => void removeTable(table.id)}
              >
                ×
              </button>
            </div>

            <div className="table-meta">
              <span className={`badge badge-${table.format}`}>{table.format}</span>
              <span>{formatBytes(table.sizeBytes)}</span>
              <span>{table.columns.length} cols</span>
              {table.rowCount != null && <span>{table.rowCount.toLocaleString()} rows</span>}
            </div>

            {open && (
              <div className="table-body">
                <div className="table-actions">
                  <button type="button" className="btn btn-small" onClick={() => previewTable(table)}>
                    Preview
                  </button>
                  <button
                    type="button"
                    className="btn btn-small"
                    onClick={() => void runProfile(table)}
                    disabled={profiling === table.id}
                  >
                    {profiling === table.id ? "Profiling…" : profile ? "Profiled" : "Profile columns"}
                  </button>
                </div>

                <ul className="columns">
                  {table.columns.map((column) => {
                    const stats = profile?.columns.find((c) => c.name === column.name);
                    return (
                      <li key={column.name} className="column">
                        <button
                          type="button"
                          className="column-name"
                          title={`Insert "${column.name}" into the query`}
                          onClick={() => setSql((current) => insertAtEnd(current, `"${column.name}"`))}
                        >
                          {column.name}
                        </button>
                        <span className="column-type">{column.type.replace(/\(.*\)$/, "").toLowerCase()}</span>

                        {stats && (
                          <span className="column-flags">
                            {stats.flags.map((flag) => (
                              <span key={flag} className={`flag flag-${flag}`} title={FLAG_COPY[flag]}>
                                {flagLabel(flag)}
                              </span>
                            ))}
                            {stats.nullFraction > 0 && stats.nullFraction < 0.5 && (
                              <span className="flag flag-nulls" title={`${stats.nullCount.toLocaleString()} empty values`}>
                                {formatPercent(stats.nullFraction)} null
                              </span>
                            )}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>

                {profile && (
                  <div className="suggestions">
                    <p className="suggestions-title">Queries worth running</p>
                    {suggestQueries(profile).map((suggestion) => (
                      <button
                        key={suggestion.label}
                        type="button"
                        className="suggestion"
                        onClick={() => {
                          setSql(suggestion.sql);
                          void run(suggestion.sql);
                        }}
                      >
                        {suggestion.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Short badge text. The full sentence lives in the tooltip. */
function flagLabel(flag: string): string {
  switch (flag) {
    case "all-null": return "empty";
    case "no-nulls": return "no nulls";
    case "unique": return "unique";
    case "constant": return "constant";
    case "low-cardinality": return "groupable";
    case "mostly-null": return "sparse";
    default: return flag;
  }
}

function formatPercent(fraction: number): string {
  const pct = fraction * 100;
  return pct < 1 ? "<1%" : `${Math.round(pct)}%`;
}

/** Append a column reference without clobbering what is already written. */
function insertAtEnd(current: string, snippet: string): string {
  if (!current.trim()) return snippet;
  return current.endsWith(" ") || current.endsWith("\n") ? `${current}${snippet}` : `${current} ${snippet}`;
}
