"use client";

/**
 * Header design lookup. Accepts any of:
 *   - variant SKU:    AFGFMS0278, AFHFMS0278, AFGFMS0278WH, AFGFMS0278-CF
 *   - bare family:    AFMS0278
 *   - name fragment:  "forever loved", "camel", "shell"
 *
 * Single SKU match → opens the detail modal immediately.
 * Multiple name matches → shows a dropdown, pick one to open its modal.
 */
import { useEffect, useRef, useState } from "react";
import type { Design } from "@/lib/types";

interface Props {
  onFound: (design: Design) => void;
}

export function SkuSearch({ onFound }: Props) {
  const [value, setValue] = useState("");
  const [matches, setMatches] = useState<Design[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setMatches(null);
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, []);

  const submit = async () => {
    const q = value.trim();
    if (!q) return;
    setLoading(true);
    setError(null);
    setMatches(null);
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
      if (ms.length === 1 || kind === "sku") {
        onFound(ms[0]);
        setValue("");
        setMatches(null);
      } else {
        setMatches(ms);
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
        onFocus={() => {
          if (matches && matches.length > 0) {
            // Reopen the dropdown if user refocuses after clicking outside
            setMatches(matches);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void submit();
          } else if (e.key === "Escape") {
            setMatches(null);
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
            setMatches(null);
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

      {matches && matches.length > 1 && (
        <ul className="absolute z-30 top-full left-0 mt-1 bg-white border border-border rounded-md shadow-lg w-[360px] max-h-80 overflow-y-auto">
          <li className="px-3 py-2 text-[11px] text-muted-2 border-b border-border">
            {matches.length} matches — click to open
          </li>
          {matches.map((d) => (
            <li key={d.design_family}>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  onFound(d);
                  setValue("");
                  setMatches(null);
                }}
                className="w-full text-left px-3 py-2 hover:bg-zinc-50 flex justify-between items-center gap-3 border-b border-border/50 last:border-b-0"
              >
                <div className="min-w-0">
                  <p className="text-sm truncate">{d.design_name || d.design_family}</p>
                  <p className="text-[11px] text-muted-2 font-mono truncate">{d.design_family}</p>
                </div>
                <span className="text-[11px] text-muted tabular-nums shrink-0">
                  {d.units_total.toLocaleString()} units
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
