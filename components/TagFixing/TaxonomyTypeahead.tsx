"use client";

/**
 * Controlled-vocabulary tag picker.
 *
 * - Data source: /api/taxonomy (baked FL Themes, 585 entries).
 * - Search: case-insensitive substring across the `label` (e.g. "Birds: Cardinals").
 *           Matches are ranked by: label-startsWith > word-startsWith > substring.
 * - Keyboard: ↓ / ↑ move highlight, Enter selects, Esc blurs, Tab commits first.
 * - Emits the canonical `term` (Search Term) via onPick.
 * - The `excluded` prop hides entries whose term is already on the tag list.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface TaxonomyEntry {
  term: string;
  name: string;
  sub: string | null;
  subSub: string | null;
  level: 1 | 2 | 3;
  label: string;
  conflicts?: string[];
}

type TaxonomyResponse = { entries: TaxonomyEntry[] };

let cachedPromise: Promise<TaxonomyEntry[]> | null = null;
export function loadTaxonomy(): Promise<TaxonomyEntry[]> {
  if (cachedPromise) return cachedPromise;
  cachedPromise = fetch("/api/taxonomy")
    .then((r) => (r.ok ? r.json() : Promise.reject(r.statusText)))
    .then((d: TaxonomyResponse) => d.entries)
    .catch(() => {
      cachedPromise = null;
      return [] as TaxonomyEntry[];
    });
  return cachedPromise;
}

/** Find conflict pairs present in the given tag set. Returns unique
 *  unordered pairs (a < b lexicographically) plus any unknown terms. */
export function findConflicts(
  tags: string[],
  taxonomy: TaxonomyEntry[],
): { pairs: Array<[string, string]> } {
  const present = new Set(tags);
  const byTerm = new Map(taxonomy.map((e) => [e.term, e]));
  const pairs: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (const t of tags) {
    const entry = byTerm.get(t);
    if (!entry?.conflicts) continue;
    for (const other of entry.conflicts) {
      if (!present.has(other)) continue;
      const key = t < other ? `${t}|${other}` : `${other}|${t}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push(t < other ? [t, other] : [other, t]);
    }
  }
  return { pairs };
}

interface Props {
  onPick: (term: string, entry: TaxonomyEntry) => void;
  excluded?: ReadonlySet<string>;
  placeholder?: string;
}

export function TaxonomyTypeahead({
  onPick,
  excluded,
  placeholder = "+ Add from taxonomy — type to search 585 entries…",
}: Props) {
  const [all, setAll] = useState<TaxonomyEntry[]>([]);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [rawHighlight, setRawHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    loadTaxonomy().then(setAll);
  }, []);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const pool = excluded
      ? all.filter((e) => !excluded.has(e.term))
      : all;
    if (!q) return pool.slice(0, 20);
    // Rank: exact-label > label-starts-with > word-starts-with > substring.
    type Ranked = { e: TaxonomyEntry; score: number };
    const out: Ranked[] = [];
    for (const e of pool) {
      const label = e.label.toLowerCase();
      const term = e.term.toLowerCase();
      let score = 0;
      if (label === q || term === q) score = 100;
      else if (label.startsWith(q) || term.startsWith(q)) score = 80;
      else if (label.split(/[:\s]+/).some((w) => w.startsWith(q))) score = 60;
      else if (label.includes(q) || term.includes(q)) score = 40;
      if (score > 0) out.push({ e, score });
    }
    out.sort((a, b) => b.score - a.score || a.e.label.localeCompare(b.e.label));
    return out.slice(0, 20).map((r) => r.e);
  }, [query, all, excluded]);

  // Effective highlight is clamped at render time to avoid cascading setState
  // from an effect when the match list shrinks.
  const highlight =
    matches.length === 0 ? 0 : Math.min(rawHighlight, matches.length - 1);

  // Scroll highlighted item into view.
  useEffect(() => {
    if (!open || !listRef.current) return;
    const node = listRef.current.children[highlight] as HTMLElement | undefined;
    node?.scrollIntoView({ block: "nearest" });
  }, [highlight, open]);

  const pick = useCallback(
    (entry: TaxonomyEntry) => {
      onPick(entry.term, entry);
      setQuery("");
      setOpen(false);
      setRawHighlight(0);
      // Keep focus so reviewer can keep adding tags without reaching for the mouse.
      inputRef.current?.focus();
    },
    [onPick],
  );

  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="text"
        value={query}
        placeholder={placeholder}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          // Delay close so a click on a list item still registers.
          setTimeout(() => setOpen(false), 120);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setRawHighlight((h) => Math.min(matches.length - 1, h + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setRawHighlight((h) => Math.max(0, h - 1));
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (matches[highlight]) pick(matches[highlight]);
          } else if (e.key === "Tab") {
            if (matches[highlight] && open) {
              e.preventDefault();
              pick(matches[highlight]);
            }
          } else if (e.key === "Escape") {
            setOpen(false);
            inputRef.current?.blur();
          }
        }}
        className="w-full text-sm px-3 py-2 border border-border rounded-md bg-white placeholder:text-muted focus:outline-none focus:border-zinc-400"
      />
      {open && matches.length > 0 && (
        <ul
          ref={listRef}
          className="absolute z-20 mt-1 max-h-80 overflow-y-auto bg-white border border-border rounded-md shadow-lg w-full left-0 text-sm"
        >
          {matches.map((m, i) => {
            const active = i === highlight;
            return (
              <li
                key={m.term}
                onMouseEnter={() => setRawHighlight(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(m);
                }}
                className={[
                  "px-3 py-1.5 cursor-pointer flex justify-between gap-3",
                  active ? "bg-zinc-100" : "",
                ].join(" ")}
              >
                <span>{m.label}</span>
                <span className="text-[11px] text-muted-2 font-mono shrink-0">
                  {m.term}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {open && matches.length === 0 && query.trim() && (
        <div className="absolute z-20 mt-1 bg-white border border-border rounded-md shadow-lg w-full left-0 text-xs text-muted px-3 py-2">
          No taxonomy entries match &ldquo;{query.trim()}&rdquo;.
        </div>
      )}
    </div>
  );
}
