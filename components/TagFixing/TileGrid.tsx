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
import { Toast } from "@/components/Toast";
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
  const [pushing, setPushing] = useState(false);
  const [pushProgress, setPushProgress] = useState<{ done: number; failed: number; total: number } | null>(null);
  const [pushToast, setPushToast] = useState<{ message: string; variant: "success" | "error" } | null>(null);
  const [promptModalOpen, setPromptModalOpen] = useState(false);
  // Readytosend selection — families user has checked for push. Persists
  // across pagination so multi-page batches work; cleared on status/filter
  // change and after a successful push.
  const [selected, setSelected] = useState<Set<string>>(new Set());
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
    setSelected(new Set());
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

  // ─── Per-card "Mark as fine" action (novision fast-path → Ready to send) ──
  // Skips vision entirely: trusts the current shopify_tags as-is, copies them
  // into approved_tags, refreshes the derived theme columns, and queues the
  // design for the same push flow that Approve feeds.
  const markFine = useCallback(
    async (family: string) => {
      try {
        const r = await fetch(
          `/api/review/design/${encodeURIComponent(family)}/action`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "mark_fine" }),
          },
        );
        if (!r.ok) throw new Error(await r.text());
        setPushToast({
          message: "✓ Marked fine — queued in Ready to send",
          variant: "success",
        });
        refresh();
      } catch (e) {
        console.error("mark_fine failed:", e);
        setPushToast({
          message: `Mark fine failed: ${(e as Error).message}`,
          variant: "error",
        });
      }
    },
    [refresh],
  );

  // ─── Flagged-tile actions ──────────────────────────────────────────────
  const removeFromFlagged = useCallback(
    async (family: string) => {
      // Flagged → novision via unflag (non-destructive). Prior vision/approved
      // tags are preserved so re-flagging later resumes where it left off.
      try {
        await fetch(
          `/api/review/design/${encodeURIComponent(family)}/action`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "unflag" }),
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

    // Soft cap warning at 100+ designs. Sonnet 4.6 runs ~$0.006/design and
    // ~3s/design at concurrency 3. Give the user explicit cost/time up front.
    if (families.length > 100) {
      const est$ = (families.length * 0.006).toFixed(2);
      const estMin = Math.max(1, Math.round((families.length * 3) / 60));
      const ok = window.confirm(
        `Run Claude vision on ${families.length} designs?\n\n` +
          `Estimated cost: ~$${est$}\n` +
          `Estimated time: ~${estMin} min\n\n` +
          `OK to proceed, Cancel to go back.`,
      );
      if (!ok) return;
    }

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
      // AbortError is expected when user clicks Cancel — don't log as crash.
      if ((e as Error).name !== "AbortError") {
        console.error("vision run failed:", e);
      }
    } finally {
      setRunningVision(false);
      // All done (or aborted) — reload so completed designs show as pending.
      setTimeout(() => {
        setRunProgress(null);
        refresh();
      }, 600);
    }
  }, [designs, runningVision, doneFamilies, refresh]);

  const pushToShopify = useCallback(async () => {
    if (!designs || pushing) return;
    const selectedFamilies = [...selected];
    const pushCount = selectedFamilies.length > 0 ? selectedFamilies.length : (count ?? designs.length);
    if (pushCount === 0) return;
    const label =
      selectedFamilies.length > 0
        ? `${selectedFamilies.length} selected design${selectedFamilies.length === 1 ? "" : "s"}`
        : `all ${pushCount} ready-to-send design${pushCount === 1 ? "" : "s"}`;
    if (
      !confirm(
        `Push ${label} to JFF Shopify?\n\nThis REPLACES each product's tags with its approved_tags — anything not in FL Themes will be removed.`,
      )
    ) {
      return;
    }
    setPushing(true);
    setPushProgress({ done: 0, failed: 0, total: pushCount });
    try {
      const res = await fetch("/api/review/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          selectedFamilies.length > 0 ? { design_families: selectedFamilies } : {},
        ),
      });
      if (!res.ok || !res.body) throw new Error(await res.text());
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let done = 0;
      let failed = 0;
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
              | { type: "error"; family: string; error: string }
              | { type: "skipped"; family: string; reason: string }
              | { type: "done"; families_pushed: number; products_failed: number };
            if (evt.type === "start") {
              setProcessingFamilies((s) => {
                const next = new Set(s);
                next.add(evt.family);
                return next;
              });
            } else if (evt.type === "ok" || evt.type === "error" || evt.type === "skipped") {
              setProcessingFamilies((s) => {
                const next = new Set(s);
                next.delete(evt.family);
                return next;
              });
              if (evt.type === "ok") done++;
              else failed++;
              setPushProgress({ done, failed, total: pushCount });
            }
          } catch {
            // Skip malformed lines.
          }
        }
      }
    } catch (e) {
      console.error("push failed:", e);
      setPushToast({
        message: `Push failed: ${(e as Error).message}`,
        variant: "error",
      });
    } finally {
      setPushing(false);
      setSelected(new Set());
      // Read final progress to compose the toast (push handles partial failure
      // per Q28 — others succeed even if some fail).
      setPushProgress((p) => {
        if (p) {
          if (p.failed > 0) {
            setPushToast({
              message: `Pushed ${p.done} to Shopify · ${p.failed} failed (see Updated tile + event log)`,
              variant: "error",
            });
          } else if (p.done > 0) {
            setPushToast({
              message: `Pushed ${p.done} design${p.done === 1 ? "" : "s"} to Shopify`,
              variant: "success",
            });
          }
        }
        return null;
      });
      setTimeout(refresh, 600);
    }
  }, [designs, pushing, count, selected, refresh]);

  const clearAllFlagged = useCallback(async () => {
    if (!designs || runningVision) return;
    if (
      !confirm(
        "Clear all flagged designs back to No vision yet?\n\n" +
          "(Vision suggestions and approved tags are preserved — re-flagging later resumes where it left off.)",
      )
    )
      return;
    await Promise.all(
      designs.map((d) =>
        fetch(`/api/review/design/${encodeURIComponent(d.design_family)}/action`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "unflag" }),
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

  const toggleSelected = useCallback((family: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(family)) next.delete(family);
      else next.add(family);
      return next;
    });
  }, []);

  const cfg = TILE_CONFIGS[status];
  const total = count ?? 0;
  const waitingCount = designs
    ? designs.filter((d) => !doneFamilies.has(d.design_family) && !processingFamilies.has(d.design_family)).length
    : 0;
  const visibleFamilies = designs?.map((d) => d.design_family) ?? [];
  const allVisibleSelected =
    visibleFamilies.length > 0 && visibleFamilies.every((f) => selected.has(f));
  const toggleSelectAllVisible = () => {
    setSelected((prev) => {
      if (allVisibleSelected) {
        // Deselect the visible page (leaves any prior cross-page picks intact).
        const next = new Set(prev);
        for (const f of visibleFamilies) next.delete(f);
        return next;
      }
      const next = new Set(prev);
      for (const f of visibleFamilies) next.add(f);
      return next;
    });
  };

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
              {pushProgress && (
                <span className="text-xs text-muted self-center">
                  {pushProgress.done}/{pushProgress.total} pushed
                  {pushProgress.failed > 0 && ` · ${pushProgress.failed} failed`}
                </span>
              )}
              {designs && designs.length > 0 && !pushing && (
                <button
                  type="button"
                  onClick={toggleSelectAllVisible}
                  className="text-sm px-3.5 py-2 rounded-md border border-border bg-white hover:bg-zinc-50"
                >
                  {allVisibleSelected
                    ? `Deselect ${visibleFamilies.length}`
                    : `Select all ${visibleFamilies.length} visible`}
                </button>
              )}
              <button
                type="button"
                onClick={pushToShopify}
                disabled={pushing || total === 0}
                className="text-sm px-3.5 py-2 rounded-md bg-foreground text-background border border-foreground hover:bg-zinc-800 disabled:opacity-60"
              >
                {pushing
                  ? "Pushing…"
                  : selected.size > 0
                    ? `↑ Push ${selected.size} selected to Shopify →`
                    : `↑ Push all ${total} to Shopify →`}
              </button>
            </>
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
          {runningVision && (
            <button
              type="button"
              onClick={() => abortRef.current?.abort()}
              className="text-xs px-2.5 py-1 rounded-md border border-[#BA7517]/40 bg-white text-[#633806] hover:bg-[#FAEEDA]"
              title="Cancel the vision run (already-completed designs stay in pending)"
            >
              Cancel
            </button>
          )}
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
            const showFlagBtn =
              status === "novision" ||
              status === "readytosend" ||
              status === "updated";
            // Novision gets a dedicated per-card "Mark as fine" checkbox
            // (fast path → ready to send). Shown next to the ⚑ button so the
            // two actions are equally discoverable without a hover overlay.
            const showMarkFineBtn = status === "novision";
            const showCheckbox =
              status === "readytosend" && !pushing && state === "approved";
            const isSelected = selected.has(d.design_family);
            // Which tag list to chip under each card:
            //   flagged  / novision → shopify_tags (Shopify's current state)
            //   readytosend / updated → approved_tags (your curated output)
            const chipTags: string[] | null =
              status === "flagged" || status === "novision"
                ? d.shopify_tags ?? []
                : status === "readytosend" || status === "updated"
                  ? d.approved_tags ?? []
                  : null;
            const chipColor =
              status === "flagged" || status === "novision"
                ? "bg-transparent border-zinc-300 text-muted-2 border-dashed"
                : "bg-[#EAF3DE] border-[#C0DD97] text-[#27500A]";

            return (
              <DesignCard
                key={d.design_family}
                design={d}
                containerClassName={ringClass}
                onOpenDetail={onOpenDetail}
                imageOverlay={
                  <CardImageOverlay
                    state={state}
                    showRemove={showRemove}
                    showFlagBtn={showFlagBtn}
                    showCheckbox={showCheckbox}
                    showMarkFineBtn={showMarkFineBtn}
                    isSelected={isSelected}
                    onRemove={() => removeFromFlagged(d.design_family)}
                    onFlag={() => flagOne(d.design_family)}
                    onToggleSelect={() => toggleSelected(d.design_family)}
                    onMarkFine={() => markFine(d.design_family)}
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
                    // Show all tags — no truncation. Grids can get tall when a
                    // design has 15+ tags, but that's the signal the user wants
                    // to see without hovering a "+N" bubble.
                    <div
                      className="flex flex-wrap gap-1 mt-1"
                      title={chipTags.join(", ")}
                    >
                      {chipTags.map((t) => {
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

      {/* Push completion toast (per Q20: only on push, not on per-design approve) */}
      <Toast
        message={pushToast?.message ?? null}
        variant={pushToast?.variant}
        onDismiss={() => setPushToast(null)}
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
    subtitle: "Per-card: ✓ (top-left) marks current Shopify tags fine → ready to send. ⚑ (top-right) sends through vision. Click the image for details.",
    perCardHoverFlag: false,
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
  showCheckbox,
  showMarkFineBtn,
  isSelected,
  onRemove,
  onFlag,
  onToggleSelect,
  onMarkFine,
}: {
  state: CardState;
  showRemove: boolean;
  showFlagBtn: boolean;
  showCheckbox: boolean;
  showMarkFineBtn: boolean;
  isSelected: boolean;
  onRemove: () => void;
  onFlag: () => void;
  onToggleSelect: () => void;
  onMarkFine: () => void;
}) {
  // On novision cards, the ✓ "Mark as fine" checkbox sits in the upper-left
  // (approve/keep affordance) and the ⚑ flag button in the upper-right (push
  // back through vision). Elsewhere the flag button stays in its traditional
  // upper-right spot.
  const flagBtnPosition = "top-1.5 right-1.5";
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
      {showCheckbox && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleSelect();
          }}
          title={isSelected ? "Deselect" : "Select for push"}
          aria-pressed={isSelected}
          className={`absolute top-2 left-2 w-7 h-7 rounded-md border-2 flex items-center justify-center text-base font-bold leading-none z-10 shadow-md transition-colors ${
            isSelected
              ? "bg-[#0F6E56] border-white text-white"
              : "bg-white border-[#0F6E56]/60 text-transparent hover:bg-[#0F6E56]/10 hover:border-[#0F6E56]"
          }`}
        >
          ✓
        </button>
      )}
      {showMarkFineBtn && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onMarkFine();
          }}
          title="Mark as fine — copy current Shopify tags to approved and queue for push"
          aria-label="Mark as fine"
          className="absolute top-1.5 left-1.5 w-5 h-5 rounded-sm border-2 border-[#0F6E56] bg-white hover:bg-[#0F6E56] text-[#0F6E56] hover:text-white flex items-center justify-center text-[11px] font-bold leading-none z-10 shadow-sm transition-colors"
        >
          ✓
        </button>
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
          className={`absolute ${flagBtnPosition} w-6 h-6 rounded-full bg-white/90 border border-border text-muted hover:text-[#A32D2D] hover:border-[#A32D2D] flex items-center justify-center text-xs leading-none z-10`}
        >
          ⚑
        </button>
      )}
    </>
  );
}
