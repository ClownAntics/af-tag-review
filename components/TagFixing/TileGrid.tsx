"use client";

/**
 * Generic grid view for the four non-Pending tiles.
 *
 * Status-specific config (header copy, primary/secondary actions, per-card
 * hover affordance) comes from TILE_CONFIGS. The grid is a compact 5-col
 * layout of mini flag cards; hover reveals an action overlay.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Design, ReviewStatus } from "@/lib/types";
import { DesignCard } from "@/components/DesignCard";
import { VisionPromptModal } from "./VisionPromptModal";

interface Props {
  status: ReviewStatus;
  count: number | null;
  onOpenDetail: (d: Design) => void;
  onCountsChanged: () => void;
  // Filter querystring from the parent FilterBar (may be empty).
  filterQs?: string;
}

const PAGE_SIZE = 40;

export function TileGrid({
  status,
  count,
  onOpenDetail,
  onCountsChanged,
  filterQs = "",
}: Props) {
  const [designs, setDesigns] = useState<Design[] | null>(null);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [runningVision, setRunningVision] = useState(false);
  const [runProgress, setRunProgress] = useState<{ done: number; total: number } | null>(null);
  const [processingFamilies, setProcessingFamilies] = useState<Set<string>>(new Set());
  const [doneFamilies, setDoneFamilies] = useState<Set<string>>(new Set());
  const [promptModalOpen, setPromptModalOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const loadPage = useCallback(
    async (newOffset: number) => {
      setLoading(true);
      try {
        const r = await fetch(
          `/api/review/queue?status=${status}&offset=${newOffset}&limit=${PAGE_SIZE}${filterQs ? `&${filterQs}` : ""}`,
        );
        if (!r.ok) throw new Error(await r.text());
        const d = (await r.json()) as { designs: Design[]; total: number };
        setDesigns(d.designs);
        setOffset(newOffset);
      } catch (e) {
        console.error("load failed:", e);
        setDesigns([]);
      } finally {
        setLoading(false);
      }
    },
    [status, filterQs],
  );

  useEffect(() => {
    setDesigns(null);
    setOffset(0);
    setProcessingFamilies(new Set());
    setDoneFamilies(new Set());
    loadPage(0);
  }, [loadPage]);

  const refresh = useCallback(() => {
    loadPage(offset);
    onCountsChanged();
  }, [loadPage, offset, onCountsChanged]);

  // ─── Per-card hover flag action (moves design into Flagged queue) ──────
  const flagOne = useCallback(
    async (family: string) => {
      try {
        await fetch(
          `/api/review/design/${encodeURIComponent(family)}/action`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "flag" }),
          },
        );
        refresh();
      } catch (e) {
        console.error(e);
      }
    },
    [refresh],
  );

  // ─── Flagged-tile actions ──────────────────────────────────────────────
  const removeFromFlagged = useCallback(
    async (family: string) => {
      // Going from flagged → novision via reset action.
      try {
        await fetch(
          `/api/review/design/${encodeURIComponent(family)}/action`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "reset" }),
          },
        );
        refresh();
      } catch (e) {
        console.error(e);
      }
    },
    [refresh],
  );

  const runVision = useCallback(async () => {
    if (!designs || runningVision) return;
    const families = designs
      .filter((d) => !doneFamilies.has(d.design_family))
      .map((d) => d.design_family);
    if (families.length === 0) return;
    setRunningVision(true);
    setRunProgress({ done: 0, total: families.length });
    abortRef.current = new AbortController();

    try {
      // Stream progress over a chunked fetch.
      const res = await fetch("/api/review/vision/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ design_families: families }),
        signal: abortRef.current.signal,
      });
      if (!res.ok || !res.body) throw new Error(await res.text());

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let done = 0;
      while (true) {
        const { done: finished, value } = await reader.read();
        if (finished) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const evt = JSON.parse(line) as
              | { type: "start"; family: string }
              | { type: "ok"; family: string }
              | { type: "error"; family: string; error: string };
            if (evt.type === "start") {
              setProcessingFamilies((s) => {
                const next = new Set(s);
                next.add(evt.family);
                return next;
              });
            } else if (evt.type === "ok" || evt.type === "error") {
              setProcessingFamilies((s) => {
                const next = new Set(s);
                next.delete(evt.family);
                return next;
              });
              if (evt.type === "ok") {
                setDoneFamilies((s) => {
                  const next = new Set(s);
                  next.add(evt.family);
                  return next;
                });
              }
              done++;
              setRunProgress({ done, total: families.length });
            }
          } catch {
            // Skip malformed lines.
          }
        }
      }
    } catch (e) {
      console.error("vision run failed:", e);
    } finally {
      setRunningVision(false);
      // All done — the server will have moved each design to pending. Reload.
      setTimeout(() => {
        setRunProgress(null);
        refresh();
      }, 600);
    }
  }, [designs, runningVision, doneFamilies, refresh]);

  const clearAllFlagged = useCallback(async () => {
    if (!designs || runningVision) return;
    if (!confirm("Clear all flagged designs back to No vision yet?")) return;
    await Promise.all(
      designs.map((d) =>
        fetch(`/api/review/design/${encodeURIComponent(d.design_family)}/action`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "reset" }),
        }),
      ),
    );
    refresh();
  }, [designs, runningVision, refresh]);

  const bulkFlagVisible = useCallback(async () => {
    if (!designs) return;
    await Promise.all(
      designs.map((d) =>
        fetch(`/api/review/design/${encodeURIComponent(d.design_family)}/action`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "flag" }),
        }),
      ),
    );
    refresh();
  }, [designs, refresh]);

  const cfg = TILE_CONFIGS[status];
  const total = count ?? 0;
  const waitingCount = designs
    ? designs.filter((d) => !doneFamilies.has(d.design_family) && !processingFamilies.has(d.design_family)).length
    : 0;

  return (
    <div className="space-y-4">
      {/* Header card */}
      <div className="flex items-center justify-between gap-4 px-5 py-4 bg-card border border-border rounded-lg">
        <div>
          <p className="text-sm font-medium">
            {total.toLocaleString()} {cfg.titleNoun}
          </p>
          <p className="text-xs text-muted mt-0.5">
            {cfg.subtitle}
            {status === "flagged" && (
              <>
                {" "}·{" "}
                <button
                  type="button"
                  onClick={() => setPromptModalOpen(true)}
                  className="underline decoration-dotted underline-offset-2 hover:text-foreground"
                >
                  Edit vision prompt
                </button>
              </>
            )}
          </p>
        </div>
        <div className="flex gap-2">
          {status === "flagged" && (
            <>
              <button
                type="button"
                onClick={clearAllFlagged}
                disabled={runningVision || !designs || designs.length === 0}
                className="text-sm px-3.5 py-2 rounded-md border border-border bg-white hover:bg-zinc-50 disabled:opacity-50"
              >
                Clear all
              </button>
              <button
                type="button"
                onClick={runVision}
                disabled={runningVision || waitingCount === 0}
                className="text-sm px-3.5 py-2 rounded-md bg-foreground text-background border border-foreground hover:bg-zinc-800 disabled:opacity-60"
              >
                ⚡ Run vision on {waitingCount} design{waitingCount === 1 ? "" : "s"} →
              </button>
            </>
          )}
          {status === "readytosend" && (
            <>
              <button
                type="button"
                disabled
                title="Phase 6 — Shopify write-back coming soon"
                className="text-sm px-3.5 py-2 rounded-md border border-border bg-white opacity-50 cursor-not-allowed"
              >
                Export CSV
              </button>
              <button
                type="button"
                disabled
                title="Phase 6 — Shopify write-back needs your custom-app token"
                className="text-sm px-3.5 py-2 rounded-md bg-foreground text-background border border-foreground opacity-60 cursor-not-allowed"
              >
                ↑ Push {total} to Shopify →
              </button>
            </>
          )}
          {status === "updated" && (
            <button
              type="button"
              disabled
              className="text-sm px-3.5 py-2 rounded-md border border-border bg-white opacity-50 cursor-not-allowed"
            >
              Export CSV
            </button>
          )}
          {status === "novision" && designs && designs.length > 0 && (
            <button
              type="button"
              onClick={bulkFlagVisible}
              className="text-sm px-3.5 py-2 rounded-md border border-border bg-white hover:bg-zinc-50"
            >
              ⚑ Flag all {designs.length} visible
            </button>
          )}
        </div>
      </div>

      {/* Progress bar (vision run) */}
      {runProgress && (
        <div className="px-5 py-3 bg-[#FAEEDA] border border-[#FAC775] rounded-lg flex items-center gap-3 text-sm text-[#633806]">
          <span>
            Analyzing <strong>{runProgress.done}</strong> of{" "}
            <strong>{runProgress.total}</strong>…
          </span>
          <div className="flex-1 h-1 bg-[#633806]/15 rounded-full overflow-hidden">
            <div
              className="h-full bg-[#BA7517] transition-all"
              style={{
                width: `${runProgress.total ? (runProgress.done / runProgress.total) * 100 : 0}%`,
              }}
            />
          </div>
          <span className="tabular-nums">
            {runProgress.total
              ? Math.round((runProgress.done / runProgress.total) * 100)
              : 0}
            %
          </span>
        </div>
      )}

      {/* Grid */}
      {loading && designs === null && (
        <div className="text-sm text-muted py-10 text-center">Loading…</div>
      )}

      {designs && designs.length === 0 && (
        <div className="text-sm text-muted py-14 text-center border border-dashed border-border rounded-lg">
          Nothing here.
        </div>
      )}

      {designs && designs.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
          {designs.map((d) => {
            const state: CardState = processingFamilies.has(d.design_family)
              ? "processing"
              : doneFamilies.has(d.design_family)
                ? "done"
                : status === "flagged"
                  ? "waiting"
                  : status === "readytosend" || status === "updated"
                    ? "approved"
                    : "neutral";
            const ringClass = STATE_BORDER[state];
            const showRemove =
              status === "flagged" && !runningVision && state === "waiting";
            const showFlagBtn = status === "readytosend" || status === "updated";
            // Which tag list to chip under each card:
            //   flagged → shopify_tags (current Shopify state — what you're about to re-review)
            //   readytosend / updated → approved_tags (your curated output)
            //   others → none
            const chipTags: string[] | null =
              status === "flagged"
                ? d.shopify_tags ?? []
                : status === "readytosend" || status === "updated"
                  ? d.approved_tags ?? []
                  : null;
            const chipColor =
              status === "flagged"
                ? "bg-transparent border-zinc-300 text-muted-2 border-dashed"
                : "bg-[#EAF3DE] border-[#C0DD97] text-[#27500A]";

            return (
              <DesignCard
                key={d.design_family}
                design={d}
                containerClassName={ringClass}
                onImageClick={
                  status === "novision"
                    ? () => flagOne(d.design_family)
                    : undefined
                }
                onOpenDetail={status === "novision" ? undefined : onOpenDetail}
                imageOverlay={
                  <CardImageOverlay
                    state={state}
                    showRemove={showRemove}
                    showFlagBtn={showFlagBtn}
                    onRemove={() => removeFromFlagged(d.design_family)}
                    onFlag={() => flagOne(d.design_family)}
                  />
                }
                hoverOverlay={
                  cfg.perCardHoverFlag &&
                  state !== "processing" &&
                  state !== "done" ? (
                    <div className="px-4 py-3 bg-black/65 rounded-md text-white text-center">
                      <div className="text-2xl leading-none mb-1">⚑</div>
                      <div className="text-xs font-medium">Flag for tag review</div>
                    </div>
                  ) : null
                }
                bodyExtra={
                  chipTags && chipTags.length > 0 ? (
                    <div
                      className="flex flex-wrap gap-1 mt-1"
                      title={chipTags.join(", ")}
                    >
                      {chipTags.slice(0, 5).map((t) => {
                        const isPrimary = t === d.vision_raw?.primary;
                        return (
                          <span
                            key={t}
                            className={`inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded border ${chipColor} leading-none lowercase`}
                            title={isPrimary ? `${t} (primary)` : undefined}
                          >
                            {isPrimary && <span className="normal-case">⭐</span>}
                            {t}
                          </span>
                        );
                      })}
                      {chipTags.length > 5 && (
                        <span className="text-[10px] text-muted-2 leading-none py-0.5">
                          +{chipTags.length - 5}
                        </span>
                      )}
                    </div>
                  ) : null
                }
              />
            );
          })}
        </div>
      )}

      {/* Vision-prompt editor modal — only relevant on Flagged */}
      <VisionPromptModal
        open={promptModalOpen}
        onClose={() => setPromptModalOpen(false)}
      />

      {/* Pager */}
      {total > PAGE_SIZE && (
        <div className="flex justify-center items-center gap-3 pt-4 text-xs text-muted">
          <button
            type="button"
            disabled={offset === 0 || loading}
            onClick={() => loadPage(Math.max(0, offset - PAGE_SIZE))}
            className="text-xs px-3 py-1.5 rounded-md border border-border bg-white hover:bg-zinc-50 disabled:opacity-40"
          >
            ← prev
          </button>
          <span>
            {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total.toLocaleString()}
          </span>
          <button
            type="button"
            disabled={offset + PAGE_SIZE >= total || loading}
            onClick={() => loadPage(offset + PAGE_SIZE)}
            className="text-xs px-3 py-1.5 rounded-md border border-border bg-white hover:bg-zinc-50 disabled:opacity-40"
          >
            next →
          </button>
        </div>
      )}
    </div>
  );
}

// ─── per-tile config ──────────────────────────────────────────────────────

interface TileConfig {
  titleNoun: string;
  subtitle: string;
  perCardHoverFlag: boolean;
}

const TILE_CONFIGS: Record<ReviewStatus, TileConfig> = {
  novision: {
    titleNoun: "designs with no vision analysis",
    subtitle: "Hover any design to flag it. Or bulk-flag visible to queue them all up.",
    perCardHoverFlag: true,
  },
  flagged: {
    titleNoun: "designs flagged",
    subtitle: "Vision analysis required before review. API cost ~$0.006/design (Sonnet 4.6).",
    perCardHoverFlag: false,
  },
  pending: {
    titleNoun: "designs pending review",
    subtitle: "",
    perCardHoverFlag: false,
  },
  readytosend: {
    titleNoun: "designs ready to send",
    subtitle:
      "Reviewed and waiting to push to Shopify. Click a card to see the tags queued. Use the ⚑ button to send back through review.",
    perCardHoverFlag: false,
  },
  updated: {
    titleNoun: "designs updated on Shopify",
    subtitle: "Tags are live. Click a card to see details. Use the ⚑ button to send back through review.",
    perCardHoverFlag: false,
  },
};

// ─── state helpers ────────────────────────────────────────────────────────

type CardState = "waiting" | "processing" | "done" | "approved" | "neutral";

// Ring classes applied to the DesignCard container (as containerClassName).
// They sit alongside the default `border border-border` already on the card.
const STATE_BORDER: Record<CardState, string> = {
  waiting: "ring-2 ring-[#A32D2D]",
  processing: "ring-2 ring-[#BA7517]",
  done: "ring-2 ring-[#0F6E56]",
  approved: "ring-2 ring-[#0F6E56]",
  neutral: "",
};

function CardImageOverlay({
  state,
  showRemove,
  showFlagBtn,
  onRemove,
  onFlag,
}: {
  state: CardState;
  showRemove: boolean;
  showFlagBtn: boolean;
  onRemove: () => void;
  onFlag: () => void;
}) {
  return (
    <>
      {state === "processing" && (
        <span className="absolute top-1.5 left-1.5 text-[10px] px-2 py-0.5 rounded-full bg-[#FAEEDA] text-[#BA7517] font-medium pointer-events-none">
          ⚙ analyzing
        </span>
      )}
      {state === "done" && (
        <span className="absolute top-1.5 left-1.5 text-[10px] px-2 py-0.5 rounded-full bg-[#0F6E56] text-white font-medium pointer-events-none">
          ✓ done
        </span>
      )}
      {showRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          title="Remove from flagged"
          className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-white/90 border border-border text-muted hover:text-[#A32D2D] hover:border-[#A32D2D] flex items-center justify-center text-[11px] leading-none z-10"
        >
          ×
        </button>
      )}
      {showFlagBtn && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onFlag();
          }}
          title="Flag for tag review (sends back through vision + review)"
          className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-white/90 border border-border text-muted hover:text-[#A32D2D] hover:border-[#A32D2D] flex items-center justify-center text-xs leading-none z-10"
        >
          ⚑
        </button>
      )}
    </>
  );
}
