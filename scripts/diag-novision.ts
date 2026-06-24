/**
 * Why are there 6,734 novision designs? Distinguish:
 *  (a) newly synced rows never reviewed  → first_seen_at is recent
 *  (b) something RESET reviewed rows back → events show a status change to
 *      novision, and first_seen_at is old
 * Also dumps recent sync-log rows (big inserted count = catalog expansion)
 * and recent event-type activity.
 */
import { getAdminClient } from "./_supabase-admin";

async function main() {
  const sb = getAdminClient();

  // 1. novision: first_seen_at distribution (by day) + last_pushed_at present?
  const nov: { design_family: string; first_seen_at: string | null; last_pushed_at: string | null; manufacturer: string | null }[] = [];
  const PAGE = 1000;
  for (let o = 0; ; o += PAGE) {
    const { data, error } = await sb
      .from("designs")
      .select("design_family,first_seen_at,last_pushed_at,manufacturer")
      .eq("status", "novision")
      .range(o, o + PAGE - 1);
    if (error) throw error;
    const b = data ?? [];
    nov.push(...(b as typeof nov));
    if (b.length < PAGE) break;
  }
  console.log(`novision total: ${nov.length}`);

  const byDay = new Map<string, number>();
  for (const r of nov) {
    const d = r.first_seen_at ? r.first_seen_at.slice(0, 10) : "(null)";
    byDay.set(d, (byDay.get(d) ?? 0) + 1);
  }
  console.log("\nnovision by first_seen_at day:");
  for (const [d, n] of [...byDay.entries()].sort()) console.log(`  ${d}  ${n}`);

  const everPushed = nov.filter((r) => r.last_pushed_at).length;
  console.log(`\nnovision that were EVER pushed before (last_pushed_at set): ${everPushed}`);
  console.log("  → if >0, these were live once and got reset back to novision");

  // 2. sync log
  const { data: logs } = await sb
    .from("shopify_sync_log")
    .select("finished_at,products_seen,products_matched,families,inserted,updated,excluded,trigger")
    .order("finished_at", { ascending: false })
    .limit(8);
  console.log("\nRecent shopify_sync_log:");
  if (!logs?.length) console.log("  (none)");
  for (const l of logs ?? [])
    console.log(`  ${l.finished_at?.slice(0, 16)} [${l.trigger}] seen=${l.products_seen} matched=${l.products_matched} families=${l.families} ins=${l.inserted} upd=${l.updated} exc=${l.excluded}`);

  // 3. recent events by type/day (last ~600 events)
  const { data: ev } = await sb
    .from("events")
    .select("event_type,actor,timestamp")
    .order("timestamp", { ascending: false })
    .limit(2000);
  console.log("\nRecent events — type × day (last 2000):");
  const evAgg = new Map<string, number>();
  for (const e of ev ?? []) {
    const key = `${(e.timestamp ?? "").slice(0, 10)}  ${e.event_type}  (${e.actor})`;
    evAgg.set(key, (evAgg.get(key) ?? 0) + 1);
  }
  for (const [k, n] of [...evAgg.entries()].sort().reverse().slice(0, 30)) console.log(`  ${k}: ${n}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
