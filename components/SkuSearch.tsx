"use client";

/**
 * Header SKU lookup. Type a SKU (any variant: AFGFMS0278, AFHFMS0278, AFMS0278,
 * AFGFMS0278WH etc.) and Enter opens that design's detail modal.
 */
import { useState } from "react";
import type { Design } from "@/lib/types";

interface Props {
  onFound: (design: Design) => void;
}

export function SkuSearch({ onFound }: Props) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    const sku = value.trim();
    if (!sku) return;
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/review/lookup?sku=${encodeURIComponent(sku)}`);
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        setError(body.error || `Lookup failed (${r.status})`);
        return;
      }
      const { design } = (await r.json()) as { design: Design };
      onFound(design);
      setValue("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative flex items-center">
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
        placeholder="Search SKU or design_family"
        className="bg-card border border-border rounded-full pl-9 pr-9 py-2 text-sm w-64 focus:outline-none focus:border-foreground focus:ring-2 focus:ring-foreground/10 transition-all placeholder:text-muted-2 disabled:opacity-60"
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
