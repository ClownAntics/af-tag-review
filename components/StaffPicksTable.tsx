"use client";

/**
 * Sortable table for the Staff Picks report. Every column header is a toggle:
 * click to sort by it, click again to flip asc/desc. Click a row to open the
 * design detail popup. Sales/yr = lifetime units normalized to a per-year rate
 * (sales velocity / "sales ability").
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Design } from "@/lib/types";
import { DetailModal } from "@/components/DetailModal";

export interface StaffPickRow {
  design: Design;
  picked_by: string | null;
  picked_at: string | null;
  sales_per_year: number | null;
}

type SortKey = "design" | "manufacturer" | "picked_by" | "picked" | "sales";
type Dir = "asc" | "desc";

// First click on a column lands on the most useful direction for that data.
const DEFAULT_DIR: Record<SortKey, Dir> = {
  design: "asc",
  manufacturer: "asc",
  picked_by: "asc",
  picked: "desc",
  sales: "desc",
};

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function fmtRate(r: number | null): string {
  if (r === null) return "—";
  if (r === 0) return "0/yr";
  if (r < 10) return `${r.toFixed(1)}/yr`;
  return `${Math.round(r).toLocaleString()}/yr`;
}

const nameOf = (r: StaffPickRow) => r.design.design_name || r.design.design_family || "";

function cmp(a: StaffPickRow, b: StaffPickRow, key: SortKey): number {
  switch (key) {
    case "design":
      return nameOf(a).localeCompare(nameOf(b));
    case "manufacturer":
      return (a.design.manufacturer ?? "").localeCompare(b.design.manufacturer ?? "");
    case "picked_by":
      return (a.picked_by ?? "").localeCompare(b.picked_by ?? "");
    case "picked":
      return (a.picked_at ?? "").localeCompare(b.picked_at ?? "");
    case "sales":
      return (a.sales_per_year ?? -1) - (b.sales_per_year ?? -1);
  }
}

export function StaffPicksTable({ rows }: { rows: StaffPickRow[] }) {
  const router = useRouter();
  const [sort, setSort] = useState<{ key: SortKey; dir: Dir }>({ key: "picked", dir: "desc" });
  const [selected, setSelected] = useState<Design | null>(null);
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);

  const removePick = async (family: string) => {
    if (!confirm("Remove this staff pick?\n\nIt'll be un-starred and queued in Ready-to-send so the removal pushes to Shopify on the next push.")) return;
    setBusy(family);
    try {
      const res = await fetch(`/api/review/design/${encodeURIComponent(family)}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "unstar" }),
      });
      if (!res.ok) throw new Error(await res.text());
      setRemoved((s) => new Set(s).add(family)); // hide immediately
      router.refresh(); // re-sync the server list
    } catch (e) {
      alert(`Failed to remove: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const sorted = [...rows]
    .filter((r) => !removed.has(r.design.design_family))
    .sort((a, b) => {
      const c = cmp(a, b, sort.key);
      if (c !== 0) return sort.dir === "asc" ? c : -c;
      return (a.design.design_family ?? "").localeCompare(b.design.design_family ?? "");
    });

  const toggle = (key: SortKey) =>
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: DEFAULT_DIR[key] }));

  const Th = ({ k, label, className = "" }: { k: SortKey; label: string; className?: string }) => (
    <th
      onClick={() => toggle(k)}
      className={`py-2 font-medium cursor-pointer select-none hover:text-foreground ${className}`}
      title={`Sort by ${label}`}
    >
      {label}
      <span className="text-muted-2">{sort.key === k ? (sort.dir === "asc" ? " ↑" : " ↓") : " ↕"}</span>
    </th>
  );

  return (
    <>
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="text-left text-xs text-muted border-b border-border">
            <Th k="design" label="Design" />
            <Th k="manufacturer" label="Manufacturer" />
            <Th k="picked_by" label="Picked by" />
            <Th k="picked" label="Picked" />
            <Th k="sales" label="Sales/yr" className="text-right pr-3" />
            <th className="py-2 font-medium" />
          </tr>
        </thead>
        <tbody>
          {sorted.map(({ design: d, picked_by, picked_at, sales_per_year }) => (
            <tr
              key={d.design_family}
              onClick={() => setSelected(d)}
              className="border-b border-border/60 hover:bg-zinc-50 cursor-pointer"
              title="Open details"
            >
              <td className="py-2 pr-3">
                <div className="flex items-center gap-2.5">
                  {d.image_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={d.image_url} alt="" width={64} height={84} className="w-16 h-[84px] rounded object-cover bg-zinc-100 shrink-0" />
                  ) : (
                    <div className="w-16 h-[84px] rounded bg-zinc-100 shrink-0" />
                  )}
                  <div className="min-w-0">
                    <div className="truncate">{d.design_name || d.design_family}</div>
                    <div className="text-[11px] text-muted-2 font-mono">{d.design_family}</div>
                  </div>
                </div>
              </td>
              <td className="py-2 pr-3 text-muted">{d.manufacturer ?? "—"}</td>
              <td className="py-2 pr-3 font-mono text-[13px]">{picked_by ?? "—"}</td>
              <td className="py-2 pr-3 text-muted whitespace-nowrap">{fmtDate(picked_at)}</td>
              <td className="py-2 pr-3 text-right whitespace-nowrap tabular-nums" title={`${(d.units_total ?? 0).toLocaleString()} lifetime units`}>
                {fmtRate(sales_per_year)}
              </td>
              <td className="py-2 pl-2 text-right whitespace-nowrap">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void removePick(d.design_family);
                  }}
                  disabled={busy === d.design_family}
                  className="text-xs text-muted hover:text-[#A32D2D] disabled:opacity-50"
                  title="Remove staff pick (un-star)"
                >
                  {busy === d.design_family ? "…" : "✕ Remove"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {selected && (
        <DetailModal key={selected.design_family} design={selected} onClose={() => setSelected(null)} />
      )}
    </>
  );
}
