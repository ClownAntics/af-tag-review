/**
 * Lightweight status endpoint for the Settings → Taxonomy section.
 *
 * Returns the current entry count (grouped by level), the TeamDesk connection
 * status, the Source URL (if configured), and the last-synced timestamp from
 * taxonomy_refresh_log.
 */
import { isConfigured as teamdeskConfigured, viewUrl } from "@/lib/teamdesk";
import { getTaxonomy } from "@/lib/taxonomy-source";
import { getAdminSupabase } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const { entries, source } = await getTaxonomy();
  const total = entries.length;
  const byLevel = { 1: 0, 2: 0, 3: 0 };
  for (const e of entries) {
    if (e.level === 1) byLevel[1]++;
    else if (e.level === 2) byLevel[2]++;
    else if (e.level === 3) byLevel[3]++;
  }

  let last_synced_at: string | null = null;
  try {
    const sb = getAdminSupabase();
    const { data } = await sb
      .from("taxonomy_refresh_log")
      .select("ran_at")
      .order("ran_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    last_synced_at = (data?.ran_at as string | undefined) ?? null;
  } catch {
    // No log table yet (pre-005 migration) — leave null.
  }

  return Response.json({
    total,
    level_1: byLevel[1],
    level_2: byLevel[2],
    level_3: byLevel[3],
    api_connected: teamdeskConfigured(),
    source_url: viewUrl(),
    source, // 'supabase' or 'baked' — surfaces fallback state for debug
    last_synced_at,
  });
}
