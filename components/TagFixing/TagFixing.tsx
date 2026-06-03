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
import { DesignCard } from "@/components/DesignCard";
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
  /** Active search — when set, replaces the tile/filter/grid UI with a
   *  flat results grid scoped to `matches`. Filters and tile selection
   *  are reset so re-clearing search lands the user on a clean view. */
  searchState?: { query: string; matches: Design[] } | null;
  onClearSearch?: () => void;
}

const LAST_TILE_KEY = "tagReview.lastTile";
const VALID_STATUSES: ReviewStatus[] = [
  "flagged",
  "pending",
  "readytosend",
  "updated",
  "novision",
];

function readStoredTile(): ReviewStatus | null {
  if (typeof window === "undefined") return null;
  try {
    const saved = window.localStorage.getItem(LAST_TILE_KEY);
    if (saved && VALID_STATUSES.includes(saved as ReviewStatus)) {
      return saved as ReviewStatus;
    }
  } catch {
    // localStorage can throw in private browsing — ignore.
  }
  return null;
}

export function TagFixing({
  onOpenDetail,
  externalDataVersion = 0,
  searchState = null,
  onClearSearch,
}: Props) {
  // Default tile = last one the user was on. Initial state must be the same
  // on server and client (Next.js SSR-prerenders "use client" components) —
  // otherwise the localStorage-derived state on the client causes a React
  // hydration mismatch (#418). Start with "pending", then bump to the stored
  // value once mounted on the client.
  const [tile, setTileState] = useState<ReviewStatus>("pending");
  const [filters, setFilters] = useState<ReviewFilters>(EMPTY_REVIEW_FILTERS);
  const [counts, setCounts] = useState<ReviewCounts | null>(null);
  const [countsRev, setCountsRev] = useState(0);

  // Hydrate from localStorage after mount. setState in an effect is normally
  // discouraged, but for client-only-initial-state derived from a browser API
  // it's the correct pattern — there's no other way to defer the read past
  // the SSR-matched first render.
  useEffect(() => {
    const stored = readStoredTile();
    if (stored && stored !== "pending") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTileState(stored);
    }
  }, []);

  const setTile = useCallback((next: ReviewStatus) => {
    setTileState(next);
    try {
      window.localStorage.setItem(LAST_TILE_KEY, next);
    } catch {
      // Ignore write failures — tile state is non-critical.
    }
  }, []);

  const refreshCounts = useCallback(() => setCountsRev((r) => r + 1), []);

  // Entering search mode resets filters + tile so when the user clears the
  // search they don't land back in a filtered/staged view that may not
  // reflect what they want next. The reset doesn't loop because we only
  // fire when `searchState` flips from null → set.
  const inSearchMode = !!searchState;
  useEffect(() => {
    if (inSearchMode) {
      setFilters(EMPTY_REVIEW_FILTERS);
      setTileState("pending");
    }
  }, [inSearchMode]);

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

  if (searchState) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3 bg-zinc-50 border border-border rounded-lg px-4 py-3">
          <div className="text-sm">
            <span className="text-muted-2">Search:</span>{" "}
            <span className="font-medium">&ldquo;{searchState.query}&rdquo;</span>
            <span className="text-muted-2"> · </span>
            <span className="tabular-nums">
              {searchState.matches.length} match
              {searchState.matches.length === 1 ? "" : "es"}
            </span>
            <span className="text-muted-2"> across all statuses</span>
          </div>
          <button
            type="button"
            onClick={onClearSearch}
            className="text-xs px-3 py-1.5 rounded-md border border-border bg-white hover:bg-zinc-50"
          >
            ← Clear search
          </button>
        </div>

        {searchState.matches.length === 0 ? (
          <div className="text-sm text-muted px-2">No matches.</div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
            {searchState.matches.map((d) => (
              <DesignCard
                key={d.design_family}
                design={d}
                onOpenDetail={onOpenDetail}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

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
