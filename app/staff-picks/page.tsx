/**
 * Staff Picks report — every design currently tagged `Staff-Pick`, with who
 * picked it (the latest `staff_picked` event's actor), when, and its sales
 * velocity (units/year). Sortable by pick date or sales. Server component;
 * gated by the auth middleware like the rest of the app.
 */
import Link from "next/link";
import { getAdminSupabase } from "@/lib/supabase-admin";
import { StaffPicksTable, type StaffPickRow } from "@/components/StaffPicksTable";
import type { Design } from "@/lib/types";

export const dynamic = "force-dynamic";

const STAFF_PICK_TAG = "Staff-Pick";

// Full Design columns so the detail popup has everything (tags, vision, skus…).
const DESIGN_SELECT =
  "design_family,design_name,units_total,catalog_created_date,first_sale_date,product_types,shopify_product_types,shopify_tags,approved_tags,vision_tags,vision_raw,theme_names,sub_themes,sub_sub_themes,classification,status,has_monogram,has_personalized,has_preprint,last_reviewed_at,last_pushed_at,manufacturer,variant_skus,image_url,first_seen_at";

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

  // 1. Full Design rows currently carrying the Staff-Pick tag.
  const designs: Design[] = [];
  const PAGE = 1000;
  for (let o = 0; ; o += PAGE) {
    const { data, error } = await sb
      .from("designs")
      .select(DESIGN_SELECT)
      .contains("approved_tags", [STAFF_PICK_TAG])
      .range(o, o + PAGE - 1);
    if (error) throw new Error(error.message);
    const b = (data ?? []) as unknown as Design[];
    designs.push(...b);
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

  return designs.map((d) => ({
    design: d,
    picked_by: latest.get(d.design_family)?.actor ?? null,
    picked_at: latest.get(d.design_family)?.timestamp ?? null,
    sales_per_year: unitsPerYear(d.units_total ?? 0, d.catalog_created_date ?? null, d.first_sale_date ?? null),
  }));
}

export default async function StaffPicksPage() {
  let picks: StaffPickRow[] = [];
  let error: string | null = null;
  try {
    picks = await loadPicks();
  } catch (e) {
    error = (e as Error).message;
  }

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
        <Link href="/" className="text-xs text-muted hover:text-foreground hover:underline">
          ← Back to Tag Review
        </Link>
      </header>

      {error && (
        <p className="text-sm text-[#A32D2D] bg-[#FBEAEA] border border-[#F0C9C9] rounded-md px-3 py-2">
          Failed to load: {error}
        </p>
      )}

      {picks.length === 0 && !error ? (
        <p className="text-sm text-muted italic">No staff picks yet. Star a design on the Updated tile to add one.</p>
      ) : (
        <StaffPicksTable rows={picks} />
      )}
    </main>
  );
}
