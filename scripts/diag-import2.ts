/**
 * Establish the REAL age of the novision designs (not the backfilled
 * first_seen_at) and diagnose the daily import.
 */
import { getAdminClient } from "./_supabase-admin";

async function main() {
  const sb = getAdminClient();

  // Pull age-signal fields for all designs
  const rows: {
    design_family: string;
    status: string;
    first_seen_at: string | null;
    catalog_created_date: string | null;
    first_sale_date: string | null;
    units_total: number | null;
    last_pushed_at: string | null;
    shopify_tags: string[] | null;
    shopify_product_ids: number[] | null;
  }[] = [];
  const PAGE = 1000;
  for (let o = 0; ; o += PAGE) {
    const { data, error } = await sb
      .from("designs")
      .select("design_family,status,first_seen_at,catalog_created_date,first_sale_date,units_total,last_pushed_at,shopify_tags,shopify_product_ids")
      .range(o, o + PAGE - 1);
    if (error) throw error;
    const b = data ?? [];
    rows.push(...(b as typeof rows));
    if (b.length < PAGE) break;
  }

  // 1. first_seen_at by day, split by status group — is it backfill noise?
  const dayByGroup = (grp: (s: string) => boolean) => {
    const m = new Map<string, number>();
    for (const r of rows) if (grp(r.status)) {
      const d = r.first_seen_at ? r.first_seen_at.slice(0, 10) : "(null)";
      m.set(d, (m.get(d) ?? 0) + 1);
    }
    return [...m.entries()].sort();
  };
  console.log("first_seen_at by day — UPDATED (known-old, reviewed rows):");
  for (const [d, n] of dayByGroup((s) => s === "updated")) console.log(`  ${d}  ${n}`);
  console.log("first_seen_at by day — NOVISION:");
  for (const [d, n] of dayByGroup((s) => s === "novision")) console.log(`  ${d}  ${n}`);

  // 2. Real age signals for novision
  const nov = rows.filter((r) => r.status === "novision");
  const has = (f: (r: typeof nov[number]) => boolean) => nov.filter(f).length;
  console.log(`\nNOVISION real-age signals (of ${nov.length}):`);
  console.log(`  catalog_created_date set : ${has((r) => !!r.catalog_created_date)}`);
  console.log(`  first_sale_date set      : ${has((r) => !!r.first_sale_date)}`);
  console.log(`  units_total > 0          : ${has((r) => (r.units_total ?? 0) > 0)}`);
  console.log(`  has shopify_tags         : ${has((r) => (r.shopify_tags ?? []).length > 0)}`);
  console.log(`  has shopify_product_ids  : ${has((r) => (r.shopify_product_ids ?? []).length > 0)}`);
  console.log(`  ever pushed (last_pushed): ${has((r) => !!r.last_pushed_at)}`);

  // oldest catalog_created_date among novision (proves long-standing products)
  const dates = nov.map((r) => r.catalog_created_date).filter(Boolean).sort() as string[];
  if (dates.length) console.log(`  catalog_created_date range: ${dates[0]?.slice(0,10)} … ${dates[dates.length-1]?.slice(0,10)}`);
  const sales = nov.map((r) => r.first_sale_date).filter(Boolean).sort() as string[];
  if (sales.length) console.log(`  first_sale_date range:      ${sales[0]?.slice(0,10)} … ${sales[sales.length-1]?.slice(0,10)}`);

  // 3. sync log: does the table exist / have rows?
  const { data: log, error: logErr } = await sb
    .from("shopify_sync_log")
    .select("finished_at,inserted,updated,families,trigger,duration_ms")
    .order("finished_at", { ascending: false })
    .limit(10);
  console.log("\nshopify_sync_log:");
  if (logErr) console.log(`  ERROR (table missing?): ${logErr.message}`);
  else if (!log?.length) console.log("  table exists but EMPTY — cron has never logged a run");
  else for (const l of log) console.log(`  ${l.finished_at?.slice(0,16)} [${l.trigger}] ins=${l.inserted} upd=${l.updated} fam=${l.families} ${l.duration_ms}ms`);

  // 4. events: do novision families have prior history?
  const ev: { design_family: string; timestamp: string }[] = [];
  for (let o = 0; ; o += PAGE) {
    const { data } = await sb.from("events").select("design_family,timestamp").range(o, o + PAGE - 1);
    const b = data ?? [];
    ev.push(...(b as typeof ev));
    if (b.length < PAGE) break;
  }
  const novFams = new Set(nov.map((r) => r.design_family));
  const novWithEvents = new Set(ev.filter((e) => novFams.has(e.design_family)).map((e) => e.design_family));
  console.log(`\nevents total: ${ev.length}`);
  console.log(`novision families with ANY prior event: ${novWithEvents.size} (of ${nov.length})`);
}
main().catch((e) => { console.error(e); process.exit(1); });
