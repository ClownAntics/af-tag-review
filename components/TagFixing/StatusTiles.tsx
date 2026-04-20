"use client";

import type { ReviewCounts, ReviewStatus } from "@/lib/types";

type TileStatus = ReviewStatus;

interface TileSpec {
  id: TileStatus;
  label: string;
  subtitle: string;
  color: string;
}

const TILES: TileSpec[] = [
  { id: "flagged",     label: "Flagged",       subtitle: "waiting on vision",         color: "text-[#A32D2D]" },
  { id: "pending",     label: "Pending",       subtitle: "ready for you",             color: "text-[#BA7517]" },
  { id: "readytosend", label: "Ready to send", subtitle: "reviewed, not yet pushed",  color: "text-[#185FA5]" },
  { id: "updated",     label: "Updated",       subtitle: "live on Shopify",           color: "text-[#0F6E56]" },
  { id: "novision",    label: "No vision yet", subtitle: "not yet flagged",           color: "text-zinc-400" },
];

export function StatusTiles({
  value,
  onChange,
  counts,
}: {
  value: TileStatus;
  onChange: (t: TileStatus) => void;
  counts: ReviewCounts | null;
}) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
      {TILES.map((t) => {
        const active = t.id === value;
        const n = counts?.[t.id] ?? null;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onChange(t.id)}
            className={[
              "bg-card rounded-lg px-4 py-3 text-left border transition-colors",
              active
                ? "border-foreground border-2 -m-px"
                : "border-border hover:border-zinc-300",
            ].join(" ")}
          >
            <p className="text-[11px] text-muted tracking-wide uppercase mb-1">
              {t.label}
            </p>
            <p className={`text-2xl font-medium leading-tight tabular-nums ${t.color}`}>
              {n === null ? "—" : n.toLocaleString()}
            </p>
            <p className="text-[10px] text-muted-2 mt-1">{t.subtitle}</p>
          </button>
        );
      })}
    </div>
  );
}
