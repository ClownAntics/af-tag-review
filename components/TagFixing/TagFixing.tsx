"use client";

/**
 * Tag fixing tab shell.
 *
 * Owns the active-tile state and the per-tile counts. Each tile's body is
 * rendered by a child component (Phase 3 / Phase 4 work); this file stays
 * small and wires them together.
 */
import { useCallback, useEffect, useState } from "react";
import { StatusTiles } from "./StatusTiles";
import { PendingReview } from "./PendingReview";
import { TileGrid } from "./TileGrid";
import { PasteSkusPanel } from "./PasteSkusPanel";
import type { Design, ReviewCounts, ReviewStatus } from "@/lib/types";

interface Props {
  onOpenDetail: (design: Design) => void;
  // Bumped by the parent when a mutation happens outside this subtree
  // (e.g. flag from DetailModal). Triggers counts + queue re-fetch.
  externalDataVersion?: number;
}

export function TagFixing({ onOpenDetail, externalDataVersion = 0 }: Props) {
  const [tile, setTile] = useState<ReviewStatus>("pending");
  const [counts, setCounts] = useState<ReviewCounts | null>(null);
  const [countsRev, setCountsRev] = useState(0);

  const refreshCounts = useCallback(() => setCountsRev((r) => r + 1), []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/review/counts")
      .then((r) => (r.ok ? r.json() : Promise.reject(r.statusText)))
      .then((d: ReviewCounts) => {
        if (!cancelled) setCounts(d);
      })
      .catch(() => {
        // Swallow — counts fetch failing is non-fatal, tiles just show "—".
      });
    return () => {
      cancelled = true;
    };
  }, [countsRev, externalDataVersion]);

  return (
    <div className="space-y-4">
      <PasteSkusPanel
        onFlagged={() => {
          refreshCounts();
          setTile("flagged");
        }}
      />

      <p className="text-[11px] text-muted">
        Pipeline:{" "}
        <strong className="text-zinc-600 font-medium">Flag</strong> → vision runs →{" "}
        <strong className="text-zinc-600 font-medium">Pending</strong> → you review →{" "}
        <strong className="text-zinc-600 font-medium">Ready to send</strong> → push →{" "}
        <strong className="text-zinc-600 font-medium">Updated</strong>
      </p>

      <StatusTiles value={tile} onChange={setTile} counts={counts} />

      <div className="pt-2">
        {tile === "pending" && (
          <PendingReview
            key={`pending-${externalDataVersion}`}
            onOpenDetail={onOpenDetail}
            onCountsChanged={refreshCounts}
          />
        )}
        {tile !== "pending" && (
          <TileGrid
            key={`${tile}-${externalDataVersion}`}
            status={tile}
            count={counts?.[tile] ?? null}
            onOpenDetail={onOpenDetail}
            onCountsChanged={refreshCounts}
          />
        )}
      </div>
    </div>
  );
}
