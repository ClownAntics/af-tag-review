"use client";

/**
 * Sortable table for the Staff Picks report. Click "Picked" or "Sales/yr" to
 * sort. Default is most-recently-picked. Sales/yr = lifetime units normalized
 * to a per-year rate (sales velocity / "sales ability").
 */
import { useState } from "react";

export interface StaffPickRow {
  design_family: string;
  design_name: string | null;
  image_url: string | null;
  manufacturer: string | null;
  status: string;
  picked_by: string | null;
  picked_at: string | null;
  units_total: number;
  sales_per_year: number | null;
}

type SortKey = "picked" | "sales";

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

export function StaffPicksTable({ rows }: { rows: StaffPickRow[] }) {
  const [sort, setSort] = useState<SortKey>("picked");

  const sorted = [...rows].sort((a, b) => {
    if (sort === "sales") {
      // High → low; unknown (null) sinks to the bottom.
      const av = a.sales_per_year ?? -1;
      const bv = b.sales_per_year ?? -1;
      if (bv !== av) return bv - av;
      return (b.picked_at ?? "").localeCompare(a.picked_at ?? "");
    }
    return (b.picked_at ?? "").localeCompare(a.picked_at ?? "");
  });

  const SortTh = ({ k, label, className = "" }: { k: SortKey; label: string; className?: string }) => (
    <th
      onClick={() => setSort(k)}
      className={`py-2 font-medium cursor-pointer select-none hover:text-foreground ${className}`}
      title={`Sort by ${label}`}
    >
      {label}
      <span className="text-muted-2">{sort === k ? " ↓" : " ↕"}</span>
    </th>
  );

  return (
    <table className="w-full text-sm border-collapse">
      <thead>
        <tr className="text-left text-xs text-muted border-b border-border">
          <th className="py-2 font-medium">Design</th>
          <th className="py-2 font-medium">Manufacturer</th>
          <th className="py-2 font-medium">Picked by</th>
          <SortTh k="picked" label="Picked" />
          <SortTh k="sales" label="Sales/yr" className="text-right pr-3" />
          <th className="py-2 font-medium">Status</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((p) => (
          <tr key={p.design_family} className="border-b border-border/60 hover:bg-zinc-50">
            <td className="py-2 pr-3">
              <div className="flex items-center gap-2.5">
                {p.image_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={p.image_url} alt="" width={32} height={42} className="rounded object-cover bg-zinc-100 shrink-0" />
                ) : (
                  <div className="w-8 h-[42px] rounded bg-zinc-100 shrink-0" />
                )}
                <div className="min-w-0">
                  <div className="truncate">{p.design_name || p.design_family}</div>
                  <div className="text-[11px] text-muted-2 font-mono">{p.design_family}</div>
                </div>
              </div>
            </td>
            <td className="py-2 pr-3 text-muted">{p.manufacturer ?? "—"}</td>
            <td className="py-2 pr-3 font-mono text-[13px]">{p.picked_by ?? "—"}</td>
            <td className="py-2 pr-3 text-muted whitespace-nowrap">{fmtDate(p.picked_at)}</td>
            <td className="py-2 pr-3 text-right whitespace-nowrap tabular-nums" title={`${p.units_total.toLocaleString()} lifetime units`}>
              {fmtRate(p.sales_per_year)}
            </td>
            <td className="py-2 text-muted">{p.status}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
