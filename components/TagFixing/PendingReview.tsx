"use client";

/**
 * Pending review UI — heart of the Tag fixing tab.
 *
 * Two-column layout:
 *   Left (320px): flag image, design name/SKU, stats, band badge
 *   Right (1fr):  three tag sections — Approved, Vision suggestions, Raw Shopify
 *                 + History accordion
 *
 * Keyboard shortcuts (active only when this is visible and no modal is open):
 *   ⏎     Approve & next
 *   S     Skip
 *   A     Accept all vision suggestions
 *   ← / → Prev / Next
 *   F     Flag current design
 *   ?     Show keyboard help
 *
 * The queue is a local array of `Design` rows loaded from /api/review/queue.
 * Mutations go through /api/review/design/[family]/action; on success we mutate
 * the local cursor/queue to advance and keep the UI snappy.
 */
import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Design } from "@/lib/types";
import { variantSkusFor } from "@/lib/product-image";
import {
  TaxonomyTypeahead,
  loadTaxonomy,
  findConflicts,
  type TaxonomyEntry,
} from "./TaxonomyTypeahead";
import { KeyboardHelpModal } from "./KeyboardHelpModal";

interface Props {
  onOpenDetail: (d: Design) => void;
  onCountsChanged: () => void;
  // Filter querystring from the parent FilterBar (may be empty).
  filterQs?: string;
}

const BAND_LABELS: Record<string, { label: string; cls: string }> = {
  hit:   { label: "HIT (100+)",  cls: "bg-[#EAF3DE] text-[#27500A]" },
  solid: { label: "SOLID (26–99)", cls: "bg-[#EAF3DE] text-[#27500A]" },
  ok:    { label: "OK (6–25)",    cls: "bg-zinc-100 text-zinc-600"   },
  weak:  { label: "WEAK (1–5)",   cls: "bg-[#FAEEDA] text-[#633806]" },
  dead:  { label: "DEAD (0)",     cls: "bg-[#FEECEC] text-[#A32D2D]" },
};

export function PendingReview({ onOpenDetail, onCountsChanged, filterQs = "" }: Props) {
  const [queue, setQueue] = useState<Design[] | null>(null);
  const [cursor, setCursor] = useState(0);
  const [total, setTotal] = useState(0);
  const [helpOpen, setHelpOpen] = useState(false);
  const [mutating, setMutating] = useState(false);
  // Load the taxonomy once at this level so Approve can check for conflicts
  // without making RightColumn's copy a prop dependency.
  const taxonomyRef = useRef<TaxonomyEntry[]>([]);
  useEffect(() => {
    loadTaxonomy().then((t) => {
      taxonomyRef.current = t;
    });
  }, []);

  // Load queue.
  useEffect(() => {
    let cancelled = false;
    fetch(
      `/api/review/queue?status=pending&limit=200${filterQs ? `&${filterQs}` : ""}`,
    )
      .then((r) => (r.ok ? r.json() : Promise.reject(r.statusText)))
      .then((d: { designs: Design[]; total: number }) => {
        if (cancelled) return;
        setQueue(d.designs);
        setTotal(d.total);
        setCursor(0);
      })
      .catch(() => {
        if (!cancelled) setQueue([]);
      });
    return () => {
      cancelled = true;
    };
  }, [filterQs]);

  const current = queue && cursor < queue.length ? queue[cursor] : null;

  const goPrev = useCallback(() => {
    setCursor((c) => Math.max(0, c - 1));
  }, []);
  const goNext = useCallback(() => {
    setCursor((c) => (queue ? Math.min(queue.length - 1, c + 1) : c));
  }, [queue]);

  const patchCurrent = useCallback(
    (patch: Partial<Design>) => {
      setQueue((q) => {
        if (!q) return q;
        const copy = q.slice();
        copy[cursor] = { ...copy[cursor], ...patch } as Design;
        return copy;
      });
    },
    [cursor],
  );

  const removeCurrent = useCallback(() => {
    setQueue((q) => {
      if (!q) return q;
      const copy = q.slice();
      copy.splice(cursor, 1);
      return copy;
    });
    setTotal((t) => Math.max(0, t - 1));
    // Cursor stays at same index — we implicitly advance to next item.
    // If we were at the last item, clamp to the new last.
    setCursor((c) => {
      if (!queue) return c;
      const newLen = queue.length - 1;
      return Math.min(c, Math.max(0, newLen - 1));
    });
  }, [cursor, queue]);

  // Action wrappers — all go through /action endpoint. Optimistic locally.
  const callAction = useCallback(
    async (family: string, body: Record<string, unknown>) => {
      setMutating(true);
      try {
        const r = await fetch(
          `/api/review/design/${encodeURIComponent(family)}/action`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
        );
        if (!r.ok) throw new Error(await r.text());
        onCountsChanged();
        return true;
      } catch (e) {
        console.error("action failed:", e);
        return false;
      } finally {
        setMutating(false);
      }
    },
    [onCountsChanged],
  );

  const approve = useCallback(async () => {
    if (!current) return;
    // Silently merge any un-curated vision suggestions into approved. The user
    // rejected specific ones via × (those are already out of vision_tags);
    // anything still in vision means "not objected to", so roll it in.
    const merged = new Set(current.approved_tags ?? []);
    for (const t of current.vision_tags ?? []) merged.add(t);
    const tags = Array.from(merged).sort();

    // Only block for conflicts (taxonomy-level rules from the ConflictsWith
    // column). Anything else approves straight through.
    const { pairs } = findConflicts(tags, taxonomyRef.current);
    if (pairs.length > 0) {
      const lines = pairs
        .map(([a, b]) => `  • ${a}  ⚠  ${b}`)
        .join("\n");
      const go = window.confirm(
        `Conflicting tag${pairs.length === 1 ? "" : "s"} in the approved list:\n\n` +
          `${lines}\n\n` +
          `OK → approve anyway.\n` +
          `Cancel → go back and remove one side of each pair.`,
      );
      if (!go) return;
    }

    const ok = await callAction(current.design_family, { action: "approve", tags });
    if (ok) removeCurrent();
  }, [current, callAction, removeCurrent]);

  const skip = useCallback(() => goNext(), [goNext]);

  const flag = useCallback(async () => {
    if (!current) return;
    const ok = await callAction(current.design_family, { action: "flag" });
    if (ok) removeCurrent();
  }, [current, callAction, removeCurrent]);

  const acceptVision = useCallback(
    async (term: string) => {
      if (!current) return;
      const approvedSet = new Set(current.approved_tags ?? []);
      approvedSet.add(term);
      const visionNext = (current.vision_tags ?? []).filter((t) => t !== term);
      patchCurrent({
        approved_tags: Array.from(approvedSet).sort(),
        vision_tags: visionNext,
      });
      await callAction(current.design_family, { action: "accept_vision", term });
    },
    [current, callAction, patchCurrent],
  );

  const rejectVision = useCallback(
    async (term: string) => {
      if (!current) return;
      // Reject removes the tag from both sections so the final Approve-merge
      // can't pick it up again. Matches the server-side reject_vision behavior.
      const visionNext = (current.vision_tags ?? []).filter((t) => t !== term);
      const approvedNext = (current.approved_tags ?? []).filter((t) => t !== term);
      patchCurrent({ vision_tags: visionNext, approved_tags: approvedNext });
      await callAction(current.design_family, { action: "reject_vision", term });
    },
    [current, callAction, patchCurrent],
  );

  const acceptAllVision = useCallback(async () => {
    if (!current) return;
    const visions = current.vision_tags ?? [];
    if (visions.length === 0) return;
    const approvedSet = new Set(current.approved_tags ?? []);
    for (const t of visions) approvedSet.add(t);
    patchCurrent({
      approved_tags: Array.from(approvedSet).sort(),
      vision_tags: [],
    });
    await callAction(current.design_family, {
      action: "update_tags",
      tags: Array.from(approvedSet).sort(),
    });
  }, [current, callAction, patchCurrent]);

  const removeApproved = useCallback(
    async (term: string) => {
      if (!current) return;
      const next = (current.approved_tags ?? []).filter((t) => t !== term);
      patchCurrent({ approved_tags: next });
      await callAction(current.design_family, {
        action: "update_tags",
        tags: next,
      });
    },
    [current, callAction, patchCurrent],
  );

  const addApproved = useCallback(
    async (term: string) => {
      if (!current) return;
      const approvedSet = new Set(current.approved_tags ?? []);
      approvedSet.add(term);
      const nextApproved = Array.from(approvedSet).sort();
      const inVision = (current.vision_tags ?? []).includes(term);
      if (inVision) {
        // Picking a vision suggestion via typeahead = promote it (same as ✓).
        const nextVision = (current.vision_tags ?? []).filter((t) => t !== term);
        patchCurrent({ approved_tags: nextApproved, vision_tags: nextVision });
        await callAction(current.design_family, {
          action: "accept_vision",
          term,
        });
      } else {
        patchCurrent({ approved_tags: nextApproved });
        await callAction(current.design_family, {
          action: "update_tags",
          tags: nextApproved,
        });
      }
    },
    [current, callAction, patchCurrent],
  );

  // Keyboard shortcuts.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Ignore typing inside inputs/textareas and while a modal is open.
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA")
      )
        return;
      if (helpOpen) {
        if (e.key === "Escape") setHelpOpen(false);
        return;
      }
      if (e.key === "?") {
        e.preventDefault();
        setHelpOpen(true);
      } else if (e.key === "Enter") {
        e.preventDefault();
        void approve();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        goPrev();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        goNext();
      } else if (e.key.toLowerCase() === "s") {
        e.preventDefault();
        skip();
      } else if (e.key.toLowerCase() === "a") {
        e.preventDefault();
        void acceptAllVision();
      } else if (e.key.toLowerCase() === "f") {
        e.preventDefault();
        void flag();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [approve, goPrev, goNext, skip, acceptAllVision, flag, helpOpen]);

  if (queue === null) {
    return (
      <div className="py-16 text-center text-sm text-muted">Loading pending queue…</div>
    );
  }
  if (queue.length === 0) {
    return (
      <div className="py-16 text-center text-sm">
        <p className="text-zinc-700 mb-1">All caught up — pending queue is empty. 🎉</p>
        <p className="text-muted">
          Flag designs from Sales research or from the No-vision view to queue them up for review.
        </p>
      </div>
    );
  }
  if (!current) {
    // Edge case: cursor off the end (e.g. after removing last item).
    return (
      <div className="py-16 text-center text-sm text-muted">
        Reached the end of the loaded batch.{" "}
        {total > queue.length && (
          <span>
            {total - queue.length} more waiting — reload to continue.
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Nav row */}
      <div className="flex items-center justify-between">
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={goPrev}
            disabled={cursor === 0}
            className="w-8 h-8 rounded-md border border-border bg-white text-foreground hover:bg-zinc-50 disabled:opacity-30 flex items-center justify-center"
            title="Previous"
          >
            ←
          </button>
          <button
            type="button"
            onClick={goNext}
            disabled={cursor >= queue.length - 1}
            className="w-8 h-8 rounded-md border border-border bg-white text-foreground hover:bg-zinc-50 disabled:opacity-30 flex items-center justify-center"
            title="Next"
          >
            →
          </button>
        </div>
        <span className="text-xs text-muted">
          <strong className="text-foreground font-medium">{cursor + 1}</strong> of{" "}
          <strong className="text-foreground font-medium">{queue.length}</strong> loaded
          {total > queue.length && <span> · {total.toLocaleString()} total</span>}
          {" · "}
          <button
            type="button"
            onClick={() => setHelpOpen(true)}
            className="underline decoration-dotted underline-offset-2 hover:text-foreground"
          >
            ? shortcuts
          </button>
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[320px_1fr] gap-7 items-start">
        <LeftColumn design={current} onDetail={() => onOpenDetail(current)} />
        <RightColumn
          design={current}
          mutating={mutating}
          onAddApproved={addApproved}
          onRemoveApproved={removeApproved}
          onAcceptVision={acceptVision}
          onRejectVision={rejectVision}
          onAcceptAllVision={acceptAllVision}
        />
      </div>

      <div className="pt-4 mt-4 border-t border-border flex items-center gap-2.5">
        <button
          type="button"
          onClick={approve}
          disabled={mutating}
          className="text-sm px-4 py-2 rounded-md bg-foreground text-background border border-foreground hover:bg-zinc-800 disabled:opacity-60"
        >
          Approve <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-white/20 ml-1.5">⏎</span>
        </button>
        <button
          type="button"
          onClick={skip}
          className="text-sm px-4 py-2 rounded-md bg-white text-foreground border border-border hover:bg-zinc-50"
        >
          Skip <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-black/5 ml-1.5">S</span>
        </button>
        <button
          type="button"
          onClick={flag}
          disabled={mutating}
          className="text-sm px-4 py-2 rounded-md bg-white text-[#A32D2D] border border-border hover:bg-zinc-50 disabled:opacity-60"
        >
          ⚑ Flag <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-black/5 ml-1.5">F</span>
        </button>
      </div>

      <KeyboardHelpModal open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
}

// ─── Left column ─────────────────────────────────────────────────────────────

function LeftColumn({
  design,
  onDetail,
}: {
  design: Design;
  onDetail: () => void;
}) {
  const variants = variantSkusFor(design);
  const imgUrl = variants[0].imageUrl;
  const rate = unitsPerYear(design);
  const band = BAND_LABELS[design.classification || ""] || null;

  return (
    <div>
      <button
        type="button"
        onClick={onDetail}
        className="relative block w-full aspect-[3/4] rounded-lg overflow-hidden border border-border bg-zinc-50 group"
        title="Click to see full details + history (flag from the Flag button or press F)"
      >
        <Image
          src={imgUrl}
          alt={design.design_name || design.design_family}
          fill
          sizes="320px"
          unoptimized
          className="object-cover"
        />
        <div className="absolute inset-0 bg-black/55 text-white flex flex-col items-center justify-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <span className="text-2xl">📋</span>
          <span className="text-sm font-medium">View details &amp; history</span>
        </div>
      </button>
      <div className="mt-3 text-sm">
        <p className="text-[17px] font-medium leading-snug">
          {design.design_name || design.design_family}
        </p>
        <p className="text-xs text-muted font-mono mt-1">
          {variants.map((v, i) => (
            <span key={v.sku}>
              {i > 0 && <span className="mx-1 text-muted-2">/</span>}
              <a
                href={`https://admin.shopify.com/store/justforfunflags/products?query=${v.sku}`}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-foreground hover:underline"
                title={`Open ${v.sku} in JF Shopify admin`}
              >
                {v.sku}
              </a>
            </span>
          ))}
        </p>
        <div className="flex gap-3.5 text-xs text-muted py-2 mt-2 border-y border-border">
          <span>
            <span className="text-foreground font-medium">
              {design.units_total.toLocaleString()}
            </span>{" "}
            units
          </span>
          <span>
            <span className="text-foreground font-medium">
              {rate !== null ? formatRate(rate) : "—"}
            </span>
          </span>
          <span>{formatDate(design.catalog_created_date || design.first_sale_date)}</span>
        </div>
        {band && (
          <span
            className={`inline-block text-[11px] px-2 py-0.5 rounded-full mt-2.5 ${band.cls}`}
          >
            {band.label}
          </span>
        )}
        <div className="mt-3">
          <button
            type="button"
            onClick={onDetail}
            className="text-xs underline decoration-dotted underline-offset-2 text-muted hover:text-foreground"
          >
            View full details & history →
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Right column ────────────────────────────────────────────────────────────

function RightColumn({
  design,
  mutating,
  onAddApproved,
  onRemoveApproved,
  onAcceptVision,
  onRejectVision,
  onAcceptAllVision,
}: {
  design: Design;
  mutating: boolean;
  onAddApproved: (term: string) => void;
  onRemoveApproved: (term: string) => void;
  onAcceptVision: (term: string) => void;
  onRejectVision: (term: string) => void;
  onAcceptAllVision: () => void;
}) {
  // Memoize the array identities so dependent memos are stable across renders.
  const approved = useMemo(() => design.approved_tags ?? [], [design.approved_tags]);
  const vision = useMemo(() => design.vision_tags ?? [], [design.vision_tags]);
  const raw = design.shopify_tags ?? [];
  const primary = design.vision_raw?.primary || null;

  // Taxonomy (cached) — used to surface conflicts across approved + vision.
  const [taxonomy, setTaxonomy] = useState<TaxonomyEntry[]>([]);
  useEffect(() => {
    loadTaxonomy().then(setTaxonomy);
  }, []);
  // Conflicts considered across BOTH sections so conflicting vision
  // suggestions (e.g., halloween + fall) warn before the user approves.
  const conflictPairs = useMemo(() => {
    const combined = Array.from(new Set([...approved, ...vision]));
    return findConflicts(combined, taxonomy).pairs;
  }, [approved, vision, taxonomy]);
  const approvedSet = useMemo(() => new Set(approved), [approved]);

  // Decide which removal action to fire for a conflicting term based on
  // whether it's currently in approved or vision (or both).
  const dismissTerm = (term: string) => {
    if (approvedSet.has(term)) onRemoveApproved(term);
    else onRejectVision(term);
  };

  // Only exclude already-approved tags. Vision suggestions are allowed — if
  // the user picks one via typeahead, onAddApproved will promote it (same
  // effect as clicking ✓ on the vision pill).
  const excludedFromTypeahead = useMemo(
    () => new Set(approved),
    [approved],
  );

  return (
    <div className="space-y-5">
      {conflictPairs.length > 0 && (
        <div className="px-3 py-2 rounded-md bg-[#FAEEDA] border border-[#FAC775] text-[#633806] text-xs">
          <p className="font-medium mb-1">
            ⚠ Conflicting tag{conflictPairs.length === 1 ? "" : "s"}
            <span className="font-normal text-[#a1671a] ml-2">
              (taxonomy says these shouldn&apos;t coexist)
            </span>
          </p>
          <ul className="space-y-0.5">
            {conflictPairs.map(([a, b]) => {
              const aLoc = approvedSet.has(a) ? "approved" : "vision";
              const bLoc = approvedSet.has(b) ? "approved" : "vision";
              return (
                <li key={`${a}-${b}`}>
                  <button
                    type="button"
                    onClick={() => dismissTerm(a)}
                    className="underline decoration-dotted hover:text-[#A32D2D] lowercase"
                    title={`Remove "${a}" from ${aLoc}`}
                  >
                    {a}
                  </button>{" "}
                  <span className="text-[#a1671a]">({aLoc})</span> conflicts with{" "}
                  <button
                    type="button"
                    onClick={() => dismissTerm(b)}
                    className="underline decoration-dotted hover:text-[#A32D2D] lowercase"
                    title={`Remove "${b}" from ${bLoc}`}
                  >
                    {b}
                  </button>{" "}
                  <span className="text-[#a1671a]">({bLoc})</span> — click one to remove.
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <Section
        title="Approved tags"
        rightSlot={<span className="text-[11px] text-muted-2">{approved.length} active</span>}
      >
        {approved.length === 0 ? (
          <p className="text-xs text-muted italic mb-2">
            No approved tags yet. Promote from vision suggestions or add from the taxonomy below.
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5 mb-2.5">
            {approved.map((t) => (
              <Pill
                key={t}
                term={t}
                variant="ok"
                isPrimary={t === primary}
                onRemove={() => onRemoveApproved(t)}
                disabled={mutating}
              />
            ))}
          </div>
        )}
        <TaxonomyTypeahead
          onPick={(term) => onAddApproved(term)}
          excluded={excludedFromTypeahead}
        />
      </Section>

      {vision.length > 0 && (
        <Section
          title={
            <>
              Vision suggestions{" "}
              <span className="text-muted-2 font-normal">— {vision.length} new</span>
            </>
          }
          rightSlot={
            <button
              type="button"
              onClick={onAcceptAllVision}
              disabled={mutating}
              className="text-xs px-2.5 py-1 rounded-md border border-border bg-white hover:bg-zinc-50 disabled:opacity-60"
            >
              Accept all{" "}
              <span className="font-mono text-[10px] px-1 py-0.5 rounded bg-black/5 ml-1">
                A
              </span>
            </button>
          }
        >
          <div className="flex flex-wrap gap-1.5">
            {vision.map((t) => (
              <Pill
                key={t}
                term={t}
                variant="sugg"
                isPrimary={t === primary}
                onAccept={() => onAcceptVision(t)}
                onRemove={() => onRejectVision(t)}
                disabled={mutating}
              />
            ))}
          </div>
        </Section>
      )}

      <Section
        title={<span className="text-muted-2 font-normal">Raw Shopify tags</span>}
        rightSlot={<span className="text-[11px] text-muted-2">reference only</span>}
      >
        {raw.length === 0 ? (
          <p className="text-xs text-muted italic">No Shopify tags on this design.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {raw.map((t) => (
              <Pill key={t} term={t} variant="admin" />
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

function Section({
  title,
  rightSlot,
  children,
}: {
  title: React.ReactNode;
  rightSlot?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="flex items-center justify-between mb-2.5">
        <span className="text-[13px] font-medium">{title}</span>
        {rightSlot}
      </div>
      {children}
    </section>
  );
}

// ─── Pill ────────────────────────────────────────────────────────────────────

type PillVariant = "ok" | "conflict" | "sugg" | "admin";

const PILL_CLASSES: Record<PillVariant, string> = {
  ok: "bg-[#EAF3DE] border-[#C0DD97] text-[#27500A]",
  conflict: "bg-[#FAEEDA] border-[#FAC775] text-[#633806]",
  sugg: "bg-[#EEEDFE] border-[#CECBF6] text-[#3C3489]",
  admin: "bg-transparent border-dashed border-zinc-300 text-muted-2",
};

function Pill({
  term,
  variant,
  isPrimary,
  onAccept,
  onRemove,
  disabled,
}: {
  term: string;
  variant: PillVariant;
  isPrimary?: boolean;
  onAccept?: () => void;
  onRemove?: () => void;
  disabled?: boolean;
}) {
  const base =
    "inline-flex items-center gap-1.5 text-[13px] px-2.5 py-1 rounded-md border lowercase";
  const admin = variant === "admin" ? " text-[11px] px-1.5 py-0.5" : "";
  return (
    <span
      className={`${base} ${PILL_CLASSES[variant]}${admin}`}
      title={isPrimary ? "Primary theme (Claude's pick)" : undefined}
    >
      {isPrimary && <span className="normal-case">⭐</span>}
      <span>{term}</span>
      {onAccept && (
        <button
          type="button"
          onClick={onAccept}
          disabled={disabled}
          className="text-[#0F6E56] font-medium leading-none hover:opacity-70 disabled:opacity-50"
          title="Promote to approved"
          aria-label="Promote to approved"
        >
          ✓
        </button>
      )}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          disabled={disabled}
          className="opacity-50 hover:opacity-100 leading-none text-inherit disabled:opacity-30"
          title={variant === "sugg" ? "Reject" : "Remove"}
          aria-label={variant === "sugg" ? "Reject" : "Remove"}
        >
          ×
        </button>
      )}
    </span>
  );
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function unitsPerYear(d: Design): number | null {
  if (d.units_total === 0) return 0;
  const start = d.catalog_created_date || d.first_sale_date;
  if (!start) return null;
  const days = Math.max(30, (Date.now() - Date.parse(start)) / 86400000);
  return d.units_total / (days / 365.25);
}
function formatRate(r: number): string {
  if (r === 0) return "0/yr";
  if (r < 10) return `${r.toFixed(1)}/yr`;
  return `${Math.round(r)}/yr`;
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
