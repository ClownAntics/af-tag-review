import type { NextRequest } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { getAdminSupabase } from "@/lib/supabase-admin";
import type { ReviewEvent } from "@/lib/types";

export const dynamic = "force-dynamic";

interface MonthUnits { month: string; units: number }
interface TdProductStatus { sku: string; status: string }

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ design_family: string }> },
): Promise<Response> {
  const { design_family } = await ctx.params;
  const supabase = getSupabase();

  // Fetch the design's SKUs (for the td_product join), monthly sales, and
  // events in parallel.
  const [skuRes, monthlyRes, eventsRes] = await Promise.all([
    supabase.from("designs").select("variant_skus").eq("design_family", design_family).maybeSingle(),
    // Grab most recent 24 months then reverse so the chart reads left→right oldest→newest.
    supabase
      .from("design_monthly_sales")
      .select("year_month,units")
      .eq("design_family", design_family)
      .order("year_month", { ascending: false })
      .limit(24),
    supabase
      .from("events")
      .select("id,design_family,event_type,actor,timestamp,payload")
      .eq("design_family", design_family)
      .order("timestamp", { ascending: false })
      .limit(50),
  ]);

  // td_product carries the lifecycle Status (Active, Out of Stock -
  // Discontinued, Inactive, Donate, …) per SKU. Joined SKU → variant_skus
  // (falling back to design_family for non-AF rows where they're the same).
  // Uses the admin client because td_product isn't public-read.
  const skus = ((skuRes.data?.variant_skus as string[] | null) ?? []).filter(Boolean);
  const lookupSkus = skus.length ? skus : [design_family];
  let tdProduct: TdProductStatus[] = [];
  try {
    const { data } = await getAdminSupabase()
      .from("td_product")
      .select("SKU,Status")
      .in("SKU", lookupSkus);
    tdProduct = (data ?? []).map((r) => ({
      sku: (r as { SKU: string }).SKU,
      status: (r as { Status: string | null }).Status ?? "",
    }));
  } catch {
    tdProduct = [];
  }

  // Migration 002 must be applied to create design_monthly_sales + events.
  // Before it is, return empty arrays so the detail modal still renders the
  // image/stats/tags cleanly — just without chart or history.
  const monthly: MonthUnits[] = monthlyRes.error
    ? []
    : (monthlyRes.data || [])
        .map((r) => ({
          month: (r as { year_month: string }).year_month,
          units: (r as { units: number }).units,
        }))
        // DB returned newest-first (desc) to capture last 24 months; reverse
        // so the chart reads left→right oldest→newest.
        .reverse();
  const events: ReviewEvent[] = eventsRes.error
    ? []
    : ((eventsRes.data || []) as ReviewEvent[]);

  return Response.json({ monthly, events, tdProduct });
}
