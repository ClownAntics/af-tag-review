/**
 * Lightweight status endpoint for the Settings → Taxonomy section.
 *
 * Returns the current entry count (grouped by level), the TeamDesk connection
 * status, the Source URL (if configured), and the last-synced timestamp.
 *
 * Counts come from the baked `lib/taxonomy.json` today. Once TeamDesk auth
 * lands and storage moves to Supabase, this route switches to reading from
 * `taxonomy_entries` without UI changes.
 */
import taxonomy from "@/lib/taxonomy.json";
import { isConfigured as teamdeskConfigured, viewUrl } from "@/lib/teamdesk";

export const dynamic = "force-dynamic";

interface Entry {
  level: number;
}

export async function GET(): Promise<Response> {
  const entries = (taxonomy.entries ?? []) as Entry[];
  const total = entries.length;
  const byLevel = { 1: 0, 2: 0, 3: 0 };
  for (const e of entries) {
    if (e.level === 1) byLevel[1]++;
    else if (e.level === 2) byLevel[2]++;
    else if (e.level === 3) byLevel[3]++;
  }

  return Response.json({
    total,
    level_1: byLevel[1],
    level_2: byLevel[2],
    level_3: byLevel[3],
    api_connected: teamdeskConfigured(),
    source_url: viewUrl(),
    // Wired up when Supabase-backed storage lands. Until then, null tells the
    // UI to render "never synced" — the baked JSON was last updated at build
    // time (already surfaced by the git commit timeline, not here).
    last_synced_at: null as string | null,
  });
}
