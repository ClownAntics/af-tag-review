import type { NextRequest } from "next/server";
import { getSupabase } from "@/lib/supabase";
import type { ReviewEvent } from "@/lib/types";

export const dynamic = "force-dynamic";

interface MonthUnits { month: string; units: number }

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ design_family: string }> },
): Promise<Response> {
  const { design_family } = await ctx.params;
  const supabase = getSupabase();

  // Fetch monthly sales + events in parallel.
  const [monthlyRes, eventsRes] = await Promise.all([
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

  return Response.json({ monthly, events });
}
