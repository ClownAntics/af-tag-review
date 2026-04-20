"use client";

/**
 * Shared detail modal shown from both tabs.
 *
 * - Sales research: click any design tile → opens this modal
 * - Tag fixing: same entry point from its grids/tiles
 *
 * Contents:
 *   Left  (180px): flag image + stats + current status
 *   Right (flex):  units-by-month bar chart (last 24 mo)
 *                  current approved tags
 *                  full history timeline (events table)
 *   Footer: "Flag for tag review" button
 */
import { useEffect, useState } from "react";
import Image from "next/image";
import type { Design, ReviewEvent, ReviewStatus } from "@/lib/types";

interface Props {
  design: Design;
  onClose: () => void;
  onFlag?: (design: Design) => void;
}

interface MonthUnits { month: string; units: number }

const STATUS_LABEL: Record<ReviewStatus, string> = {
  novision: "No vision yet",
  flagged: "Flagged",
  pending: "Pending review",
  readytosend: "Ready to send",
  updated: "Updated",
};

const STATUS_COLOR: Record<ReviewStatus, string> = {
  novision: "text-zinc-400",
  flagged: "text-[#A32D2D]",
  pending: "text-[#BA7517]",
  readytosend: "text-[#185FA5]",
  updated: "text-[#0F6E56]",
};

export function DetailModal({ design, onClose, onFlag }: Props) {
  // This component remounts per design_family (via `key` at the call site),
  // so initial null state is correct without any reset effect.
  const [monthly, setMonthly] = useState<MonthUnits[] | null>(null);
  const [events, setEvents] = useState<ReviewEvent[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/review/design/${encodeURIComponent(design.design_family)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.statusText)))
      .then((d: { monthly: MonthUnits[]; events: ReviewEvent[] }) => {
        if (!cancelled) {
          setMonthly(d.monthly);
          setEvents(d.events);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setMonthly([]);
          setEvents([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [design.design_family]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const body = design.design_family.replace(/^AF/, "");
  const suffix = design.has_monogram
    ? "A"
    : design.has_personalized
      ? "-CF"
      : design.has_preprint
        ? "WH"
        : "";
  const gardenSku = `AFGF${body}${suffix}`;
  const houseSku = `AFHF${body}${suffix}`;
  const imgSku = gardenSku.toLowerCase();
  const imgUrl = `https://images.clownantics.com/CA_resize_500_500/${imgSku}.jpg`;
  const jfAdmin = (sku: string) =>
    `https://admin.shopify.com/store/justforfunflags/products?query=${sku}`;

  const rate = unitsPerYear(design);
  const status = (design.status || "novision") as ReviewStatus;

  // Which tag list to display depends on status:
  //   readytosend / updated → approved_tags are authoritative (what will be /
  //     what is on Shopify). Show only those even if empty.
  //   flagged / novision → nothing has been curated yet; show the live
  //     shopify_tags so the user can see the current state.
  //   pending → show approved_tags if the user has curated any; otherwise
  //     fall back to shopify_tags so the modal isn't empty mid-review.
  const approvedTags = (() => {
    const approved = design.approved_tags ?? [];
    const shopify = design.shopify_tags ?? [];
    if (status === "readytosend" || status === "updated") return approved;
    if (status === "pending") return approved.length > 0 ? approved : shopify;
    return shopify; // novision / flagged
  })();

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-5"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white rounded-xl w-full max-w-2xl max-h-[85vh] flex flex-col shadow-2xl">
        <div className="flex justify-between items-center px-5 py-4 border-b border-border">
          <div>
            <h3 className="text-[15px] font-medium leading-tight">
              {design.design_name || design.design_family}
            </h3>
            <p className="text-xs text-muted font-mono mt-0.5">
              <a
                href={jfAdmin(gardenSku)}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-foreground hover:underline"
                title={`Open ${gardenSku} in JF Shopify admin`}
              >
                {gardenSku}
              </a>
              <span className="mx-1 text-muted-2">/</span>
              <a
                href={jfAdmin(houseSku)}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-foreground hover:underline"
                title={`Open ${houseSku} in JF Shopify admin`}
              >
                {houseSku}
              </a>
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-xl text-muted leading-none p-0"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="p-5 overflow-y-auto flex-1 grid grid-cols-[180px_1fr] gap-5">
          <div>
            <div className="w-full aspect-[3/4] relative bg-zinc-50 rounded-lg overflow-hidden border border-border">
              <Image
                src={imgUrl}
                alt={design.design_name || design.design_family}
                fill
                sizes="180px"
                unoptimized
                className="object-cover"
              />
            </div>
            <dl className="mt-3 text-xs text-muted space-y-1">
              <StatRow label="Units">{design.units_total.toLocaleString()}</StatRow>
              <StatRow label="Per year">{rate !== null ? formatRate(rate) : "—"}</StatRow>
              <StatRow label="First sold">{formatMonthYear(design.first_sale_date)}</StatRow>
              <StatRow label="Catalog added">{formatMonthYear(design.catalog_created_date)}</StatRow>
              <StatRow label="Status">
                <span className={`${STATUS_COLOR[status]} font-medium`}>{STATUS_LABEL[status]}</span>
              </StatRow>
            </dl>
          </div>

          <div>
            <section className="mb-5">
              <p className="text-xs font-medium text-zinc-600 mb-2">Units by month</p>
              <div className="h-[140px] pb-5 relative">
                <MonthlyBarChart data={monthly} />
              </div>
            </section>

            <section className="mb-4">
              <p className="text-xs font-medium text-zinc-600 mb-2">
                {status === "readytosend"
                  ? "Tags queued for Shopify push"
                  : status === "updated"
                    ? "Tags live on Shopify"
                    : status === "pending"
                      ? "Approved tags (draft)"
                      : status === "flagged"
                        ? "Current Shopify tags"
                        : "Current Shopify tags"}
                {approvedTags.length > 0 && (
                  <span className="ml-2 text-muted-2 font-normal">· {approvedTags.length}</span>
                )}
              </p>
              {approvedTags.length === 0 ? (
                <p className="text-xs text-muted italic">No tags yet.</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {approvedTags.map((t) => {
                    const isPrimary = t === design.vision_raw?.primary;
                    return (
                      <span
                        key={t}
                        className="inline-flex items-center gap-1 text-[13px] px-2.5 py-1 rounded-md border bg-[#EAF3DE] border-[#C0DD97] text-[#27500A] lowercase"
                        title={isPrimary ? "Primary theme (Claude's pick)" : undefined}
                      >
                        {isPrimary && <span className="normal-case">⭐</span>}
                        {t}
                      </span>
                    );
                  })}
                </div>
              )}
              {design.vision_raw?.reasoning && (
                <p className="text-[11px] text-muted italic mt-2">
                  <span className="text-muted-2">Vision reasoning:</span>{" "}
                  {design.vision_raw.reasoning}
                </p>
              )}
            </section>

            <section>
              <p className="text-xs font-medium text-zinc-600 mb-2">
                History {events && <span className="font-normal text-muted">· {events.length} event{events.length === 1 ? "" : "s"}</span>}
              </p>
              <div className="text-xs max-h-52 overflow-y-auto space-y-1.5">
                {events === null && <p className="text-muted">Loading…</p>}
                {events?.length === 0 && (
                  <p className="text-muted italic">No events yet. Flag this design to kick off the review pipeline.</p>
                )}
                {events?.map((ev) => (
                  <EventRow key={ev.id} ev={ev} />
                ))}
              </div>
            </section>
          </div>
        </div>

        <div className="px-5 py-3 border-t border-border flex justify-between items-center">
          <span className="text-[11px] text-muted">
            {design.last_reviewed_at
              ? `Last reviewed ${formatDate(design.last_reviewed_at)}`
              : design.last_pushed_at
                ? `Last pushed ${formatDate(design.last_pushed_at)}`
                : "Never reviewed"}
          </span>
          {onFlag && status !== "flagged" && status !== "pending" && (
            <button
              type="button"
              onClick={() => onFlag(design)}
              className="text-sm px-3.5 py-2 rounded-md border border-border bg-white hover:bg-zinc-50"
            >
              ⚑ Flag for tag review
            </button>
          )}
          {status === "flagged" && (
            <span className="text-xs text-[#A32D2D]">⚑ Already flagged — vision run pending</span>
          )}
          {status === "pending" && (
            <span className="text-xs text-[#BA7517]">Awaiting your review in the Pending queue</span>
          )}
        </div>
      </div>
    </div>
  );
}

function StatRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between py-0.5">
      <span>{label}</span>
      <span className="text-foreground font-medium">{children}</span>
    </div>
  );
}

function EventRow({ ev }: { ev: ReviewEvent }) {
  const color = EVENT_COLORS[ev.event_type] || "#d4d4d8";
  const ts = new Date(ev.timestamp);
  const stamp = ts.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return (
    <div
      className="px-3 py-1.5 bg-zinc-50 rounded-r-md border-l-2"
      style={{ borderLeftColor: color }}
    >
      <div className="text-[11px] text-muted-2">{stamp}</div>
      <div className="text-zinc-600">{eventLabel(ev)}</div>
    </div>
  );
}

const EVENT_COLORS: Record<string, string> = {
  flagged: "#A32D2D",
  vision_started: "#BA7517",
  vision_completed: "#BA7517",
  vision_failed: "#A32D2D",
  approved: "#185FA5",
  pushed: "#0F6E56",
  push_failed: "#A32D2D",
  tag_added: "#185FA5",
  tag_removed: "#A32D2D",
  tag_promoted: "#185FA5",
  tag_rejected: "#A32D2D",
  tag_updated: "#185FA5",
  reset: "#a1a1aa",
};

function eventLabel(ev: ReviewEvent): string {
  const actor = ev.actor && ev.actor !== "system" ? ev.actor : "System";
  const p = ev.payload || {};
  switch (ev.event_type) {
    case "flagged":
      return `${actor} flagged for tag review`;
    case "vision_started":
      return `Vision analysis started`;
    case "vision_completed":
      return `Vision analyzed · ${(p.suggestion_count as number) ?? "?"} suggestions`;
    case "vision_failed":
      return `Vision analysis failed: ${(p.error as string) ?? "unknown"}`;
    case "approved":
      return `${actor} approved · ${(p.tag_count as number) ?? "?"} tags`;
    case "pushed":
      return `${actor} pushed to Shopify · ${(p.tag_count as number) ?? "?"} tags live`;
    case "push_failed":
      return `Shopify push failed: ${(p.error as string) ?? "unknown"}`;
    case "tag_added":
      return `${actor} added "${p.tag}"`;
    case "tag_removed":
      return `${actor} removed "${p.tag}"`;
    case "tag_promoted":
      return `${actor} accepted "${p.tag}" from vision`;
    case "tag_rejected":
      return `${actor} rejected "${p.tag}" from vision`;
    case "tag_updated":
      return `${actor} edited tags · ${(p.tag_count as number) ?? "?"} tags`;
    case "reset":
      return `${actor} reset status to No-vision`;
    default:
      return `${actor} · ${ev.event_type}`;
  }
}

function MonthlyBarChart({ data }: { data: MonthUnits[] | null }) {
  if (!data) return <p className="text-xs text-muted">Loading…</p>;
  if (data.length === 0) {
    return (
      <p className="text-xs text-muted italic">
        No monthly sales data yet. Import `design_monthly_sales` from TeamDesk to populate this chart.
      </p>
    );
  }
  const max = Math.max(...data.map((d) => d.units), 1);
  const w = 520;
  const h = 120;
  const barW = w / data.length;
  return (
    <>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        className="w-full h-full overflow-visible"
      >
        {data.map((d, i) => {
          const barH = Math.max(1, (d.units / max) * (h - 4));
          const x = i * barW + 1;
          const y = h - barH;
          const opacity = 0.35 + 0.65 * (d.units / max);
          return (
            <rect
              key={d.month}
              x={x.toFixed(1)}
              y={y.toFixed(1)}
              width={(barW - 2).toFixed(1)}
              height={barH.toFixed(1)}
              fill="#185FA5"
              opacity={opacity.toFixed(2)}
            >
              <title>{`${d.month}: ${d.units.toLocaleString()} units`}</title>
            </rect>
          );
        })}
        <line x1={0} y1={h} x2={w} y2={h} stroke="#e4e4e7" strokeWidth={1} />
      </svg>
      <div className="absolute bottom-0 left-0 right-0 flex justify-between text-[9px] text-muted-2">
        {data.map((d, i) => (
          <span key={d.month} className="flex-1 text-center">
            {i % 3 === 0 ? d.month.slice(5) + "/" + d.month.slice(2, 4) : ""}
          </span>
        ))}
      </div>
    </>
  );
}

function unitsPerYear(design: Design): number | null {
  if (design.units_total === 0) return 0;
  const start = design.catalog_created_date || design.first_sale_date;
  if (!start) return null;
  const days = Math.max(30, (Date.now() - Date.parse(start)) / 86400000);
  return design.units_total / (days / 365.25);
}

function formatRate(rate: number): string {
  if (rate === 0) return "0/yr";
  if (rate < 10) return `${rate.toFixed(1)}/yr`;
  return `${Math.round(rate)}/yr`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function formatMonthYear(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
function formatDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
