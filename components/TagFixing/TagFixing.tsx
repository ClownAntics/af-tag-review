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
import { CardImageOverlay } from "./CardImageOverlay";
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
      <SearchResultsGrid
        searchState={searchState}
        onOpenDetail={onOpenDetail}
        onClearSearch={onClearSearch}
        onCountsChanged={refreshCounts}
      />
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

// ─── Search-mode grid ─────────────────────────────────────────────────────
// Renders the search-result matches as a flat grid of cards, each carrying
// the No-vision 3-button overlay (✓ Mark as fine · ⚑ Flag · × Exclude).
// `× Exclude` swaps to `↩ Include` when the design is already excluded.
// Tag chips reflect each design's current state (shopify_tags for
// novision/flagged, approved_tags for readytosend/updated/excluded).

interface SearchResultsGridProps {
  searchState: { query: string; matches: Design[] };
  onOpenDetail: (d: Design) => void;
  onClearSearch?: () => void;
  onCountsChanged: () => void;
}

function SearchResultsGrid({
  searchState,
  onOpenDetail,
  onClearSearch,
  onCountsChanged,
}: SearchResultsGridProps) {
  // Local mirror of the matches array so per-card actions can mutate the
  // visible state without re-fetching the entire search. Reset when the
  // parent supplies a new query.
  const [rows, setRows] = useState<Design[]>(searchState.matches);
  const [actedOn, setActedOn] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    setRows(searchState.matches);
    setActedOn(new Map());
  }, [searchState]);

  const post = useCallback(
    async (family: string, action: string, label: string) => {
      try {
        const res = await fetch(
          `/api/review/design/${encodeURIComponent(family)}/action`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action }),
          },
        );
        if (!res.ok) throw new Error(await res.text());
      } catch (e) {
        console.error(`${action} failed for ${family}:`, e);
        return;
      }
      // Mark the card as actioned so the user sees what happened. The card
      // stays visible (search results are reference; we don't yank rows out
      // from under the user) but its action buttons hide and a "✓ done"
      // badge replaces them.
      setActedOn((prev) => {
        const next = new Map(prev);
        next.set(family, label);
        return next;
      });
      onCountsChanged();
    },
    [onCountsChanged],
  );

  const onFlag = (f: string) => post(f, "flag", "flagged");
  const onMarkFine = (f: string) => post(f, "mark_fine", "marked fine");
  const onExclude = (f: string) => post(f, "exclude", "excluded");
  const onInclude = (f: string) => post(f, "include", "included");

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 bg-zinc-50 border border-border rounded-lg px-4 py-3">
        <div className="text-sm">
          <span className="text-muted-2">Search:</span>{" "}
          <span className="font-medium">&ldquo;{searchState.query}&rdquo;</span>
          <span className="text-muted-2"> · </span>
          <span className="tabular-nums">
            {rows.length} match{rows.length === 1 ? "" : "es"}
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

      {rows.length === 0 ? (
        <div className="text-sm text-muted px-2">No matches.</div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
          {rows.map((d) => {
            const acted = actedOn.get(d.design_family);
            // Chip tags reflect the design's current state — shopify_tags for
            // designs that haven't been curated yet, approved_tags otherwise.
            const isCurated =
              d.status === "readytosend" ||
              d.status === "updated" ||
              d.status === "excluded";
            const chipTags = isCurated
              ? d.approved_tags ?? []
              : d.shopify_tags ?? [];
            const chipColor = isCurated
              ? "bg-[#EAF3DE] border-[#C0DD97] text-[#27500A]"
              : "bg-transparent border-zinc-300 text-muted-2 border-dashed";
            const isExcluded = d.status === "excluded";
            return (
              <DesignCard
                key={d.design_family}
                design={d}
                onOpenDetail={onOpenDetail}
                imageOverlay={
                  acted ? (
                    <span className="absolute top-1.5 left-1.5 text-[10px] px-2 py-0.5 rounded-full bg-[#0F6E56] text-white font-medium pointer-events-none">
                      ✓ {acted}
                    </span>
                  ) : (
                    <CardImageOverlay
                      state="neutral"
                      showRemove={false}
                      showFlagBtn={!isExcluded}
                      showCheckbox={false}
                      showMarkFineBtn={!isExcluded}
                      showExcludeBtn={!isExcluded}
                      showIncludeBtn={isExcluded}
                      isSelected={false}
                      onRemove={() => {}}
                      onFlag={() => onFlag(d.design_family)}
                      onToggleSelect={() => {}}
                      onMarkFine={() => onMarkFine(d.design_family)}
                      onExclude={() => onExclude(d.design_family)}
                      onInclude={() => onInclude(d.design_family)}
                    />
                  )
                }
                bodyExtra={
                  chipTags.length > 0 ? (
                    <div
                      className="flex flex-wrap gap-1 mt-1"
                      title={chipTags.join(", ")}
                    >
                      {chipTags.map((t) => (
                        <span
                          key={t}
                          className={`inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded border ${chipColor} leading-none lowercase`}
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  ) : null
                }
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
