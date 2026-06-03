"use client";

/**
 * Header design lookup. Accepts any of:
 *   - variant SKU:    AFGFMS0278, AFHFMS0278, AFGFMS0278WH, AFGFMS0278-CF
 *   - bare family:    AFMS0278
 *   - name fragment:  "forever loved", "camel", "shell"
 *
 * Single SKU/family match → opens the detail modal immediately (fast path).
 * Name-fragment search → hands the full match set up to the page via
 *   `onSearchResults`, which clears the tile + filter selection and renders
 *   a flat results grid across all statuses. Drops the inline dropdown that
 *   used to live here.
 */
import { useEffect, useRef, useState } from "react";
import type { Design } from "@/lib/types";

interface Props {
  /** Called when a single exact match resolves (SKU or unique name). */
  onFound: (design: Design) => void;
  /** Called when a name-fragment search returns 2+ matches — caller is
   *  expected to clear filters/tile and show the full list as a grid. */
  onSearchResults?: (matches: Design[], query: string) => void;
}

export function SkuSearch({ onFound, onSearchResults }: Props) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) {
        // No-op now that there's no inline dropdown to dismiss.
      }
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, []);

  const submit = async () => {
    const q = value.trim();
    if (!q) return;
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/review/lookup?q=${encodeURIComponent(q)}`);
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        setError(body.error || `Lookup failed (${r.status})`);
        return;
      }
      const { matches: ms, kind } = (await r.json()) as {
        matches: Design[];
        kind: "sku" | "name";
      };
      if (kind === "sku" || ms.length === 1) {
        // Exact match (SKU resolution or single name hit) — open it directly.
        onFound(ms[0]);
        setValue("");
      } else if (onSearchResults) {
        // Multi-match name search — hand the list up so the page can clear
        // filters/tile and show the full grid.
        onSearchResults(ms, q);
        setValue("");
      } else {
        // Fallback when the parent hasn't wired onSearchResults — open the
        // top match so we don't silently swallow the result.
        onFound(ms[0]);
        setValue("");
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative flex items-center" ref={containerRef}>
      <span className="absolute left-3 text-muted-2 pointer-events-none" aria-hidden>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="7" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
      </span>
      <input
        type="search"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          if (error) setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void submit();
          }
        }}
        disabled={loading}
        placeholder="Search SKU or design name"
        className="bg-card border border-border rounded-full pl-9 pr-9 py-2 text-sm w-72 focus:outline-none focus:border-foreground focus:ring-2 focus:ring-foreground/10 transition-all placeholder:text-muted-2 disabled:opacity-60"
      />
      {value && !loading && (
        <button
          type="button"
          onClick={() => {
            setValue("");
            setError(null);
          }}
          className="absolute right-3 text-muted-2 hover:text-foreground"
          aria-label="Clear search"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      )}
      {error && (
        <span className="ml-2 text-xs text-[#A32D2D] whitespace-nowrap">{error}</span>
      )}
    </div>
  );
}
