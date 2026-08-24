// The SQL editor.
//
// A textarea with line numbers, tab handling and autocomplete for the loaded
// schema — not a full code editor. That is a deliberate trade: CodeMirror would add
// roughly 300 KB to a bundle that already carries a database engine, and the thing
// people actually miss when writing a quick query is not folding or multi-cursor,
// it is "I cannot remember whether the column is `user_id` or `userid`". So the
// schema completion is here and the rest is not.
//
// The highlight layer sits behind the textarea and mirrors its text exactly, which
// is the standard trick for getting syntax colour without giving up native text
// editing, undo history, spellcheck-off and mobile keyboard behaviour.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TableHandle } from "@query-studio/core/workbench";

const KEYWORDS = [
  "SELECT", "FROM", "WHERE", "GROUP", "BY", "ORDER", "HAVING", "LIMIT", "OFFSET",
  "JOIN", "LEFT", "RIGHT", "INNER", "OUTER", "FULL", "CROSS", "ON", "AS", "AND",
  "OR", "NOT", "NULL", "IS", "IN", "LIKE", "ILIKE", "BETWEEN", "CASE", "WHEN",
  "THEN", "ELSE", "END", "UNION", "ALL", "DISTINCT", "WITH", "OVER", "PARTITION",
  "ASC", "DESC", "CREATE", "VIEW", "TABLE", "COPY", "TO", "SUMMARIZE", "DESCRIBE",
  "QUALIFY", "USING", "EXCLUDE", "REPLACE", "PIVOT", "UNPIVOT",
];

const FUNCTIONS = [
  "count", "sum", "avg", "min", "max", "median", "mode", "stddev", "variance",
  "round", "floor", "ceil", "abs", "coalesce", "nullif", "cast", "try_cast",
  "length", "lower", "upper", "trim", "ltrim", "rtrim", "substring", "split_part",
  "regexp_matches", "regexp_extract", "regexp_replace", "strftime", "strptime",
  "date_trunc", "date_diff", "date_part", "epoch", "now", "today",
  "row_number", "rank", "dense_rank", "lag", "lead", "first_value", "last_value",
  "list", "unnest", "array_agg", "string_agg", "approx_count_distinct",
];

interface Props {
  value: string;
  onChange: (next: string) => void;
  onRun: () => void;
  tables: TableHandle[];
  disabled?: boolean;
}

interface Completion {
  label: string;
  detail: string;
  kind: "table" | "column" | "keyword" | "function";
}

export default function SqlEditor({ value, onChange, onRun, tables, disabled }: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLPreElement>(null);
  const [completions, setCompletions] = useState<Completion[]>([]);
  const [selected, setSelected] = useState(0);

  const lineCount = useMemo(() => Math.max(value.split("\n").length, 1), [value]);

  /** Everything the current schema makes available, built once per schema change. */
  const vocabulary = useMemo<Completion[]>(() => {
    const out: Completion[] = [];
    for (const table of tables) {
      out.push({ label: table.name, detail: `table · ${table.columns.length} columns`, kind: "table" });
      for (const column of table.columns) {
        out.push({
          label: column.name,
          detail: `${table.name} · ${column.type.replace(/\(.*\)$/, "").toLowerCase()}`,
          kind: "column",
        });
      }
    }
    for (const keyword of KEYWORDS) out.push({ label: keyword, detail: "keyword", kind: "keyword" });
    for (const fn of FUNCTIONS) out.push({ label: fn, detail: "function", kind: "function" });
    return out;
  }, [tables]);

  /** Keep the highlight layer aligned with the textarea while scrolling. */
  const syncScroll = useCallback(() => {
    const textarea = textareaRef.current;
    const highlight = highlightRef.current;
    if (!textarea || !highlight) return;
    highlight.scrollTop = textarea.scrollTop;
    highlight.scrollLeft = textarea.scrollLeft;
  }, []);

  const wordAtCursor = useCallback((): { word: string; start: number } | null => {
    const textarea = textareaRef.current;
    if (!textarea) return null;

    const caret = textarea.selectionStart;
    const before = value.slice(0, caret);
    const match = before.match(/[A-Za-z_][A-Za-z0-9_]*$/);
    if (!match) return null;
    return { word: match[0], start: caret - match[0].length };
  }, [value]);

  const refreshCompletions = useCallback(() => {
    const context = wordAtCursor();
    if (!context || context.word.length < 2) {
      setCompletions([]);
      return;
    }

    const needle = context.word.toLowerCase();
    // Prefix matches first, then contains — a person typing `us` means `user_id`
    // far more often than `status`, and ranking accordingly avoids a wrong default.
    const prefix: Completion[] = [];
    const contains: Completion[] = [];

    for (const entry of vocabulary) {
      const label = entry.label.toLowerCase();
      if (label === needle) continue;
      if (label.startsWith(needle)) prefix.push(entry);
      else if (label.includes(needle)) contains.push(entry);
    }

    const ranked = [...prefix, ...contains]
      .sort((a, b) => kindRank(a.kind) - kindRank(b.kind))
      .slice(0, 8);

    setCompletions(ranked);
    setSelected(0);
  }, [wordAtCursor, vocabulary]);

  const applyCompletion = useCallback(
    (completion: Completion) => {
      const context = wordAtCursor();
      const textarea = textareaRef.current;
      if (!context || !textarea) return;

      const caret = textarea.selectionStart;
      const next = `${value.slice(0, context.start)}${completion.label}${value.slice(caret)}`;
      onChange(next);
      setCompletions([]);

      // Put the caret after the inserted word on the next frame, once React has
      // written the new value into the DOM.
      requestAnimationFrame(() => {
        const position = context.start + completion.label.length;
        textarea.setSelectionRange(position, position);
        textarea.focus();
      });
    },
    [value, onChange, wordAtCursor],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (completions.length > 0) {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setSelected((i) => (i + 1) % completions.length);
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          setSelected((i) => (i - 1 + completions.length) % completions.length);
          return;
        }
        if (event.key === "Tab" || (event.key === "Enter" && !event.metaKey && !event.ctrlKey)) {
          event.preventDefault();
          applyCompletion(completions[selected]);
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          setCompletions([]);
          return;
        }
      }

      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        onRun();
        return;
      }

      // Tab indents instead of leaving the field. Shift+Tab still escapes, so the
      // editor never becomes a keyboard trap.
      if (event.key === "Tab" && !event.shiftKey) {
        event.preventDefault();
        const textarea = event.currentTarget;
        const { selectionStart: start, selectionEnd: end } = textarea;
        onChange(`${value.slice(0, start)}  ${value.slice(end)}`);
        requestAnimationFrame(() => textarea.setSelectionRange(start + 2, start + 2));
      }
    },
    [completions, selected, applyCompletion, onRun, onChange, value],
  );

  useEffect(() => {
    syncScroll();
  }, [value, syncScroll]);

  return (
    <div className="editor">
      <div className="editor-gutter" aria-hidden>
        {Array.from({ length: lineCount }, (_, i) => (
          <span key={i}>{i + 1}</span>
        ))}
      </div>

      <div className="editor-surface">
        <pre className="editor-highlight" ref={highlightRef} aria-hidden>
          <code dangerouslySetInnerHTML={{ __html: highlight(value) }} />
        </pre>

        <textarea
          ref={textareaRef}
          className="editor-input"
          value={value}
          disabled={disabled}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          placeholder="SELECT * FROM your_table LIMIT 100;"
          aria-label="SQL query"
          onChange={(e) => {
            onChange(e.target.value);
            requestAnimationFrame(refreshCompletions);
          }}
          onKeyDown={onKeyDown}
          onScroll={syncScroll}
          onBlur={() => setTimeout(() => setCompletions([]), 120)}
        />

        {completions.length > 0 && (
          <ul className="completions" role="listbox">
            {completions.map((completion, i) => (
              <li key={`${completion.kind}-${completion.label}`} role="option" aria-selected={i === selected}>
                <button
                  type="button"
                  className={i === selected ? "completion completion-on" : "completion"}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    applyCompletion(completion);
                  }}
                >
                  <span className={`completion-kind completion-${completion.kind}`} aria-hidden />
                  <span className="completion-label">{completion.label}</span>
                  <span className="completion-detail">{completion.detail}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** Schema first: a real column beats a keyword that happens to share a prefix. */
function kindRank(kind: Completion["kind"]): number {
  switch (kind) {
    case "column": return 0;
    case "table": return 1;
    case "function": return 2;
    default: return 3;
  }
}

/**
 * Minimal SQL highlighting.
 *
 * Escapes first, then wraps tokens — doing it the other way round would let a value
 * like `'<script>'` inside a string literal reach the DOM as markup. The regex order
 * matters too: strings and comments are consumed before keywords, so `-- SELECT` is
 * a comment rather than a comment containing a keyword.
 */
function highlight(source: string): string {
  const escaped = source
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  return escaped
    .replace(/(--[^\n]*)/g, '<span class="tok-comment">$1</span>')
    .replace(/(&#39;|')((?:[^']|'')*)(&#39;|')/g, '<span class="tok-string">$1$2$3</span>')
    .replace(/\b(\d+\.?\d*)\b/g, '<span class="tok-number">$1</span>')
    .replace(
      new RegExp(`\\b(${KEYWORDS.join("|")})\\b`, "gi"),
      '<span class="tok-keyword">$1</span>',
    )
    .replace(
      new RegExp(`\\b(${FUNCTIONS.join("|")})\\b(?=\\s*\\()`, "gi"),
      '<span class="tok-function">$1</span>',
    );
}
