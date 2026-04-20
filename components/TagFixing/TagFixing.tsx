"use client";

/**
 * Tag fixing shell. Owns:
 *   - active-tile state (which status is being reviewed)
 *   - current filter set (Theme / Sub / … / Manufacturer)
 *   - counts (refreshed on mutation and when filters change)
 *
 * Filters apply to the whole subtree: status-tile counts reflect the filtered
 * subset, and the active tile's queue/review loads only filtered designs.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { StatusTiles } from "./StatusTiles";
import { PendingReview } from "./PendingReview";
import { TileGrid } from "./TileGrid";
import { PasteSkusPanel } from "./PasteSkusPanel";
import { FilterBar } from "./FilterBar";
import {
  EMPTY_REVIEW_FILTERS,
  type Design,
  type ReviewCounts,
  type ReviewFilters,
  type ReviewStatus,
} from "@/lib/types";
import { toQueryString } from "@/lib/review-filters";

interface Props {
  onOpenDetail: (design: Design) => void;
  // Bumped by the parent when a mutation happens outside this subtree
  // (e.g. flag from DetailModal). Triggers counts + queue re-fetch.
  externalDataVersion?: number;
}

export function TagFixing({ onOpenDetail, externalDataVersion = 0 }: Props) {
  const [tile, setTile] = useState<ReviewStatus>("pending");
  const [filters, setFilters] = useState<ReviewFilters>(EMPTY_REVIEW_FILTERS);
  const [counts, setCounts] = useState<ReviewCounts | null>(null);
  const [countsRev, setCountsRev] = useState(0);

  const refreshCounts = useCallback(() => setCountsRev((r) => r + 1), []);

  const filterQs = useMemo(() => toQueryString(filters), [filters]);

  useEffect(() => {
    let cancelled = false;
    const url = `/api/review/counts${filterQs ? `?${filterQs}` : ""}`;
    fetch(url)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.statusText)))
      .then((d: ReviewCounts) => {
        if (!cancelled) setCounts(d);
      })
      .catch(() => {
        // Non-fatal; tiles show "—".
      });
    return () => {
      cancelled = true;
    };
  }, [countsRev, externalDataVersion, filterQs]);

  // The filter querystring is part of child `key` so PendingReview/TileGrid
  // remount when filters change, re-firing their own fetches.
  const childKey = `${tile}-${externalDataVersion}-${filterQs}`;

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

      <FilterBar filters={filters} onChange={setFilters} />

      <StatusTiles value={tile} onChange={setTile} counts={counts} />

      <div className="pt-2">
        {tile === "pending" && (
          <PendingReview
            key={childKey}
            filterQs={filterQs}
            onOpenDetail={onOpenDetail}
            onCountsChanged={refreshCounts}
          />
        )}
        {tile !== "pending" && (
          <TileGrid
            key={childKey}
            status={tile}
            filterQs={filterQs}
            count={counts?.[tile] ?? null}
            onOpenDetail={onOpenDetail}
            onCountsChanged={refreshCounts}
          />
        )}
      </div>
    </div>
  );
}
