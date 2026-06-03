/**
 * Latest `shopify_sync_log` row. Powers the "Last synced X ago · N new"
 * line in the Settings modal so the user knows if the cron has been
 * firing.
 *
 * Returns the most recent row, or `null` if the table doesn't exist /
 * has no rows yet (cron hasn't run, or migration 010 not applied).
 */
import { getSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const supabase = getSupabase();
  try {
    const { data, error } = await supabase
      .from("shopify_sync_log")
      .select(
        "finished_at,trigger,products_seen,products_matched,families,inserted,updated,excluded,orphans_found,orphans_skipped_safety,duration_ms",
      )
      .order("finished_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      // Most likely the table doesn't exist yet (migration 010 unapplied).
      // Treat as "never synced" so the UI just doesn't show the line.
      return Response.json({ last: null, note: error.message });
    }
    return Response.json({ last: data ?? null });
  } catch (e) {
    return Response.json({ last: null, note: (e as Error).message });
  }
}
