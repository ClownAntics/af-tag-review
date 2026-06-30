/**
 * Staff Picks report — every design currently tagged `Staff-Pick`, with who
 * picked it (the latest `staff_picked` event's actor), when, and its sales
 * velocity (units/year). Sortable by pick date or sales. Server component;
 * gated by the auth middleware like the rest of the app.
 */
import { getAdminSupabase } from "@/lib/supabase-admin";
import { StaffPicksTable, type StaffPickRow } from "@/components/StaffPicksTable";

export const dynamic = "force-dynamic";

const STAFF_PICK_TAG = "Staff-Pick";

/** Lifetime units normalized to a per-year rate. Mirrors DetailModal. */
function unitsPerYear(units: number, catalogCreated: string | null, firstSale: string | null): number | null {
  if (units === 0) return 0;
  const start = catalogCreated || firstSale;
  if (!start) return null;
  const days = Math.max(30, (Date.now() - Date.parse(start)) / 86400000);
  return units / (days / 365.25);
}

async function loadPicks(): Promise<StaffPickRow[]> {
  const sb = getAdminSupabase();

  // 1. Designs currently carrying the Staff-Pick tag (+ sales fields).
  const designs: {
    design_family: string;
    design_name: string | null;
    image_url: string | null;
    manufacturer: string | null;
    status: string;
    units_total: number | null;
    catalog_created_date: string | null;
    first_sale_date: string | null;
  }[] = [];
  const PAGE = 1000;
  for (let o = 0; ; o += PAGE) {
    const { data, error } = await sb
      .from("designs")
      .select("design_family,design_name,image_url,manufacturer,status,units_total,catalog_created_date,first_sale_date")
      .contains("approved_tags", [STAFF_PICK_TAG])
      .range(o, o + PAGE - 1);
    if (error) throw new Error(error.message);
    const b = data ?? [];
    designs.push(...(b as typeof designs));
    if (b.length < PAGE) break;
  }

  // 2. Latest staff_picked event per family (who + when).
  const families = designs.map((d) => d.design_family);
  const latest = new Map<string, { actor: string | null; timestamp: string }>();
  for (let i = 0; i < families.length; i += 300) {
    const slice = families.slice(i, i + 300);
    const { data } = await sb
      .from("events")
      .select("design_family,actor,timestamp")
      .eq("event_type", "staff_picked")
      .in("design_family", slice)
      .order("timestamp", { ascending: false });
    for (const e of (data ?? []) as { design_family: string; actor: string | null; timestamp: string }[]) {
      if (!latest.has(e.design_family)) latest.set(e.design_family, { actor: e.actor, timestamp: e.timestamp });
    }
  }

  return designs.map((d) => {
    const units = d.units_total ?? 0;
    return {
      design_family: d.design_family,
      design_name: d.design_name,
      image_url: d.image_url,
      manufacturer: d.manufacturer,
      status: d.status,
      picked_by: latest.get(d.design_family)?.actor ?? null,
      picked_at: latest.get(d.design_family)?.timestamp ?? null,
      units_total: units,
      sales_per_year: unitsPerYear(units, d.catalog_created_date, d.first_sale_date),
    };
  });
}

export default async function StaffPicksPage() {
  let picks: StaffPickRow[] = [];
  let error: string | null = null;
  try {
    picks = await loadPicks();
  } catch (e) {
    error = (e as Error).message;
  }

  const byPicker = new Map<string, number>();
  for (const p of picks) byPicker.set(p.picked_by ?? "unknown", (byPicker.get(p.picked_by ?? "unknown") ?? 0) + 1);
  const tally = [...byPicker.entries()].sort((a, b) => b[1] - a[1]);

  return (
    <main className="max-w-5xl mx-auto px-6 py-8 space-y-5 w-full">
      <header className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-medium tracking-tight">Staff Picks</h1>
          <p className="text-sm text-muted">
            {picks.length} design{picks.length === 1 ? "" : "s"} currently tagged{" "}
            <code className="text-xs">Staff-Pick</code> · who picked each · sortable by sales.
          </p>
        </div>
        <a href="/" className="text-xs text-muted hover:text-foreground hover:underline">
          ← Back to Tag Review
        </a>
      </header>

      {error && (
        <p className="text-sm text-[#A32D2D] bg-[#FBEAEA] border border-[#F0C9C9] rounded-md px-3 py-2">
          Failed to load: {error}
        </p>
      )}

      {tally.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {tally.map(([who, n]) => (
            <span key={who} className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md border border-border bg-zinc-50">
              <span className="font-mono">{who}</span>
              <span className="text-muted-2">·</span>
              <span className="font-medium">{n}</span>
            </span>
          ))}
        </div>
      )}

      {picks.length === 0 && !error ? (
        <p className="text-sm text-muted italic">No staff picks yet. Star a design on the Updated tile to add one.</p>
      ) : (
        <StaffPicksTable rows={picks} />
      )}
    </main>
  );
}
