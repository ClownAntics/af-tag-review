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
import { CardImageOverlay, STATE_BORDER, type CardState } from "./CardImageOverlay";

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
  // "N new since last sync" banner state (No-vision tile only). Refreshed
  // whenever the tile loads or after flag-all-new completes.
  const [newCount, setNewCount] = useState<number | null>(null);
  const [flaggingNew, setFlaggingNew] = useState(false);
  const NEW_WINDOW_DAYS = 7;

  // Random sample mode (audit-style spot-check). Available on Ready-to-send
  // + Updated tiles where browsing thousands sequentially is impractical.
  // When active, paginated browsing is suspended and clicking the button
  // re-shuffles the sample.
  const [sampleMode, setSampleMode] = useState(false);
  const [sampleTotal, setSampleTotal] = useState<number | null>(null);
  const SAMPLE_SIZE = 20;
  const SAMPLE_TILES: ReviewStatus[] = ["readytosend", "updated"];
  const sampleAvailable = SAMPLE_TILES.includes(status);

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

  const loadSample = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(
        `/api/review/queue?status=${status}&sample=${SAMPLE_SIZE}${filterQs ? `&${filterQs}` : ""}`,
      );
      if (!r.ok) throw new Error(await r.text());
      const d = (await r.json()) as { designs: Design[]; total: number };
      setDesigns(d.designs);
      setSampleTotal(d.total);
      setOffset(0);
    } catch (e) {
      console.error("sample load failed:", e);
      setDesigns([]);
    } finally {
      setLoading(false);
    }
  }, [status, filterQs]);

  useEffect(() => {
    setDesigns(null);
    setOffset(0);
    setProcessingFamilies(new Set());
    setDoneFamilies(new Set());
    setSelected(new Set());
    // A status / filter change exits sample mode automatically — the
    // shuffle was scoped to that tile's filtered set.
    setSampleMode(false);
    setSampleTotal(null);
    loadPage(0);
  }, [loadPage]);

  // Refresh the "new since" count whenever the user lands on No-vision.
  // Other tiles don't need it.
  useEffect(() => {
    if (status !== "novision") {
      setNewCount(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/review/new-designs?days=${NEW_WINDOW_DAYS}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.statusText)))
      .then((d: { count: number }) => {
        if (!cancelled) setNewCount(d.count);
      })
      .catch(() => {
        if (!cancelled) setNewCount(null);
      });
    return () => {
      cancelled = true;
    };
  }, [status, filterQs]);

  const flagAllNew = useCallback(async () => {
    if (status !== "novision" || flaggingNew || !newCount) return;
    if (
      !confirm(
        `Flag all ${newCount} new design${newCount === 1 ? "" : "s"} (added in the last ${NEW_WINDOW_DAYS} days) for vision review?`,
      )
    )
      return;
    setFlaggingNew(true);
    try {
      const res = await fetch(
        `/api/review/new-designs?days=${NEW_WINDOW_DAYS}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ confirm: "FLAG" }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `flag failed (${res.status})`);
      }
      // Banner disappears + tiles re-count; the Flagged tile will show the
      // newly-flagged designs.
      setNewCount(0);
      onCountsChanged();
      loadPage(0);
    } catch (e) {
      console.error("flag-all-new failed:", e);
      alert(`Flag failed: ${(e as Error).message}`);
    } finally {
      setFlaggingNew(false);
    }
  }, [status, newCount, flaggingNew, onCountsChanged, loadPage]);

  // Warn before unload while a push or vision run is active. The server keeps
  // working on Vercel even after the tab closes, but the in-flight progress
  // bar goes away and the user has no way to see what's happening. The
  // confirm dialog catches accidental navigation; for an intentional leave,
  // the work still completes and reloading later shows the result.
  useEffect(() => {
    if (!pushing && !runningVision) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Modern browsers ignore the custom string but require returnValue set
      // to trigger the native confirm. Keep the message anyway for older UAs.
      e.returnValue = "";
      return "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [pushing, runningVision]);

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

  // ─── Per-card "Exclude" (Novision tile → Excluded) ─────────────────────
  // Pulls a design out of the review pipeline entirely. Used for accessories
  // (poles, brackets, stakes), gift cards, and anything else that isn't
  // reviewable artwork. Reversible via "Include" on the Excluded tile.
  const excludeOne = useCallback(
    async (family: string) => {
      try {
        await fetch(
          `/api/review/design/${encodeURIComponent(family)}/action`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "exclude" }),
          },
        );
        refresh();
      } catch (e) {
        console.error(e);
      }
    },
    [refresh],
  );

  // ─── Per-card "Include" (Excluded tile → Novision) ─────────────────────
  const includeOne = useCallback(
    async (family: string) => {
      try {
        await fetch(
          `/api/review/design/${encodeURIComponent(family)}/action`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "include" }),
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
    const filterNote = filterQs && selectedFamilies.length === 0
      ? " (matching current filters)"
      : "";
    const label =
      selectedFamilies.length > 0
        ? `${selectedFamilies.length} selected design${selectedFamilies.length === 1 ? "" : "s"}`
        : `all ${pushCount} ready-to-send design${pushCount === 1 ? "" : "s"}${filterNote}`;
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
      // Forward filterQs so the push API can scope to the same subset the
      // user is looking at. When the user has manually selected designs the
      // explicit list wins and filters are ignored server-side.
      const pushUrl = filterQs && selectedFamilies.length === 0
        ? `/api/review/push?${filterQs}`
        : "/api/review/push";
      const res = await fetch(pushUrl, {
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
  }, [designs, pushing, count, selected, refresh, filterQs]);

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

  // Generic bulk-action helper. Hits the per-design action endpoint in
  // parallel for every visible design. Returns a count of successes so
  // the caller can surface "Done — N of M succeeded" if it cares.
  const [bulkRunning, setBulkRunning] = useState<string | null>(null);
  const bulkApply = useCallback(
    async (
      action: string,
      label: string,
      verb: string,
    ): Promise<void> => {
      if (!designs || designs.length === 0 || bulkRunning) return;
      const count = designs.length;
      if (
        !confirm(
          `${verb} all ${count} visible design${count === 1 ? "" : "s"}?\n\n` +
            `Action: ${label}.\n\nThis can't be undone with a single click — you'd need to act on each card individually.`,
        )
      ) {
        return;
      }
      setBulkRunning(action);
      try {
        const results = await Promise.allSettled(
          designs.map((d) =>
            fetch(
              `/api/review/design/${encodeURIComponent(d.design_family)}/action`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action }),
              },
            ),
          ),
        );
        const ok = results.filter(
          (r) => r.status === "fulfilled" && (r.value as Response).ok,
        ).length;
        const failed = count - ok;
        setPushToast({
          message:
            failed > 0
              ? `${label} applied to ${ok}/${count} (${failed} failed)`
              : `${label} applied to ${ok} design${ok === 1 ? "" : "s"}`,
          variant: failed > 0 ? "error" : "success",
        });
      } catch (e) {
        setPushToast({
          message: `Bulk ${action} failed: ${(e as Error).message}`,
          variant: "error",
        });
      } finally {
        setBulkRunning(null);
        refresh();
      }
    },
    [designs, bulkRunning, refresh],
  );

  // bulkApply is now wired through the generic BulkActionsMenu dropdown
  // rendered in the tile header — no more single-purpose wrappers.

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
          {sampleAvailable && (
            <button
              type="button"
              onClick={() => {
                setSampleMode(true);
                void loadSample();
              }}
              disabled={loading}
              title={
                sampleMode
                  ? "Reshuffle to see a different 20"
                  : `Show 20 random ${cfg.titleNoun.split(" ")[0]} designs for spot-check audit`
              }
              className="text-sm px-3.5 py-2 rounded-md border border-border bg-white hover:bg-zinc-50 disabled:opacity-50"
            >
              🎲 {sampleMode ? "Reshuffle" : "Random 20"}
            </button>
          )}
          {sampleMode && (
            <button
              type="button"
              onClick={() => {
                setSampleMode(false);
                setSampleTotal(null);
                loadPage(0);
              }}
              className="text-sm px-3.5 py-2 rounded-md border border-border bg-white hover:bg-zinc-50"
            >
              ← Exit sample
            </button>
          )}
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
                  {pushing && (
                    <span
                      className="ml-2 text-muted-2"
                      title="The server keeps pushing even if you navigate away or close the tab. Reload later to see the final state."
                    >
                      · keeps running if you leave
                    </span>
                  )}
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
          {/* Bulk actions on every tile. Acts on the currently-visible page
              (designs.length, capped at PAGE_SIZE = 40). Each button confirms
              before applying; results land in a toast at the bottom. */}
          {designs && designs.length > 0 && (
            <BulkActionsMenu
              status={status}
              count={designs.length}
              running={bulkRunning}
              onAction={(action, label, verb) => bulkApply(action, label, verb)}
            />
          )}
        </div>
      </div>

      {/* New-since-last-sync banner (No-vision tile only). Shows when at
          least one design landed in our DB in the last NEW_WINDOW_DAYS via
          shopify-pull, with a one-click "Flag all new" button to push them
          through vision. */}
      {status === "novision" && newCount !== null && newCount > 0 && (
        <div className="flex items-center justify-between gap-3 bg-[#F0F7FE] border border-[#9BC4F5] rounded-lg px-4 py-3">
          <div className="text-sm text-[#1A4A87]">
            ✨{" "}
            <strong>{newCount}</strong> new design
            {newCount === 1 ? "" : "s"} added in the last {NEW_WINDOW_DAYS}{" "}
            days
            <span className="text-[#1A4A87]/70">
              {" "}— flag them for vision review?
            </span>
          </div>
          <button
            type="button"
            onClick={flagAllNew}
            disabled={flaggingNew}
            className="text-sm px-3.5 py-1.5 rounded-md bg-[#185FA5] text-white border border-[#185FA5] hover:bg-[#1A4A87] disabled:opacity-60"
          >
            {flaggingNew ? "Flagging…" : `⚑ Flag all ${newCount} new`}
          </button>
        </div>
      )}

      {/* Sample-mode banner — replaces normal pagination when active */}
      {sampleMode && (
        <div className="flex items-center justify-between gap-3 bg-zinc-50 border border-border rounded-lg px-4 py-2 text-xs">
          <span className="text-muted-2">
            🎲 Showing{" "}
            <strong className="text-foreground tabular-nums">
              {designs?.length ?? 0}
            </strong>{" "}
            random of{" "}
            <strong className="text-foreground tabular-nums">
              {sampleTotal?.toLocaleString() ?? "?"}
            </strong>{" "}
            {cfg.titleNoun.split(" ")[0]}{" "}
            <span className="text-muted-2">— click 🎲 Reshuffle for a different batch</span>
          </span>
        </div>
      )}

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
            // Novision also gets a small × "Exclude" button — takes the
            // design out of the review pipeline entirely (accessories,
            // gift cards, items with no artwork). Reversible from the
            // Excluded tile's × Include button.
            const showExcludeBtn = status === "novision";
            const showIncludeBtn = status === "excluded";
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
                    showExcludeBtn={showExcludeBtn}
                    showIncludeBtn={showIncludeBtn}
                    isSelected={isSelected}
                    onRemove={() => removeFromFlagged(d.design_family)}
                    onFlag={() => flagOne(d.design_family)}
                    onToggleSelect={() => toggleSelected(d.design_family)}
                    onMarkFine={() => markFine(d.design_family)}
                    onExclude={() => excludeOne(d.design_family)}
                    onInclude={() => includeOne(d.design_family)}
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

      {/* Pager — hidden in sample mode since the result set is randomized */}
      {!sampleMode && total > PAGE_SIZE && (
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

// ─── Bulk-actions menu ────────────────────────────────────────────────────
//
// Per-tile dropdown of bulk actions you can apply to every visible card in
// one click. Different statuses get different action sets — only the
// transitions that make sense for that stage are offered. Each action goes
// through the same /api/review/design/[family]/action endpoint (parallel
// per-design fetches in `bulkApply`).

interface BulkAction {
  action: string;   // matches the action route's case names
  icon: string;     // single-char glyph for the button label
  label: string;    // toast / confirm description
  verb: string;     // confirm-dialog verb ("Flag", "Exclude", "Mark fine")
  tone?: "danger";  // styles a red border when destructive-ish
}

const BULK_ACTIONS: Partial<Record<ReviewStatus, BulkAction[]>> = {
  novision: [
    { action: "flag", icon: "⚑", label: "Flag for vision review", verb: "Flag" },
    { action: "mark_fine", icon: "✓", label: "Mark as fine (current Shopify tags → approved)", verb: "Mark fine" },
    { action: "exclude", icon: "×", label: "Exclude from review pipeline", verb: "Exclude", tone: "danger" },
  ],
  flagged: [
    { action: "unflag", icon: "↩", label: "Remove from flagged (back to No-vision)", verb: "Remove" },
  ],
  // Pending review has its own per-card accept/reject workflow with
  // approve, accept_vision, reject_vision actions — bulk-approving without
  // looking at vision suggestions defeats the point of review, so we don't
  // surface a bulk action here.
  readytosend: [
    { action: "flag", icon: "⚑", label: "Re-flag for vision review", verb: "Flag", tone: "danger" },
    { action: "exclude", icon: "×", label: "Exclude from review pipeline", verb: "Exclude", tone: "danger" },
  ],
  updated: [
    { action: "flag", icon: "⚑", label: "Re-flag for vision review", verb: "Re-flag", tone: "danger" },
    { action: "exclude", icon: "×", label: "Exclude from review pipeline", verb: "Exclude", tone: "danger" },
  ],
  excluded: [
    { action: "include", icon: "↩", label: "Include back in the review pipeline (→ No-vision)", verb: "Include" },
  ],
};

function BulkActionsMenu({
  status,
  count,
  running,
  onAction,
}: {
  status: ReviewStatus;
  count: number;
  running: string | null;
  onAction: (action: string, label: string, verb: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const actions = BULK_ACTIONS[status] ?? [];

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (actions.length === 0) return null;

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={!!running}
        className="text-sm px-3.5 py-2 rounded-md border border-border bg-white hover:bg-zinc-50 disabled:opacity-60"
        title={`Apply an action to all ${count} visible designs`}
      >
        {running
          ? `Applying ${running}…`
          : `Bulk actions (${count}) ▾`}
      </button>
      {open && (
        <div className="absolute z-20 top-full right-0 mt-1 w-72 bg-white border border-border rounded-md shadow-lg overflow-hidden text-sm">
          <div className="px-3 py-2 text-[11px] text-muted-2 border-b border-border">
            Apply to all {count} visible
          </div>
          <ul>
            {actions.map((a) => (
              <li key={a.action}>
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setOpen(false);
                    onAction(a.action, a.label, a.verb);
                  }}
                  className={`w-full text-left px-3 py-2 hover:bg-zinc-50 flex items-center gap-2 ${
                    a.tone === "danger" ? "text-[#A32D2D]" : ""
                  }`}
                >
                  <span className="w-5 text-center">{a.icon}</span>
                  <span>{a.label}</span>
                </button>
              </li>
            ))}
          </ul>
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
    subtitle: "Per-card: ✓ (top-left) marks current Shopify tags fine → ready to send. ⚑ (top-right) sends through vision. × (bottom-right) excludes (accessory, not reviewable). Click the image for details.",
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
  excluded: {
    titleNoun: "designs excluded from review",
    subtitle: "Accessories, gift cards, and other items intentionally kept out of the pipeline. Click ↩ Include to send a design back to No-vision.",
    perCardHoverFlag: false,
  },
};

// Card overlay + state helpers moved to ./CardImageOverlay so the
// search-results grid in TagFixing can share them.
