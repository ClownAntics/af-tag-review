/**
 * Inspect the td_product table: columns, the lifecycle status field +
 * its value distribution, and what key joins to designs (SKU/family).
 * Read-only.
 */
import { getAdminClient } from "./_supabase-admin";

async function main() {
  const sb = getAdminClient();

  const { data: sample, error } = await sb.from("td_product").select("*").limit(3);
  if (error) throw new Error(`td_product: ${error.message}`);
  if (!sample?.length) { console.log("td_product is empty"); return; }

  console.log("=== td_product columns ===");
  console.log(Object.keys(sample[0]).join(", "));
  console.log("\n=== 3 sample rows ===");
  for (const r of sample) console.log(JSON.stringify(r, null, 2));

  // total count
  const { count } = await sb.from("td_product").select("*", { count: "exact", head: true });
  console.log(`\ntotal td_product rows: ${count}`);

  // Try to find a status-like column and tally values
  const cols = Object.keys(sample[0]);
  const statusCol = cols.find((c) => /status/i.test(c));
  if (statusCol) {
    const all: Record<string, unknown>[] = [];
    const PAGE = 1000;
    for (let o = 0; ; o += PAGE) {
      const { data } = await sb.from("td_product").select(statusCol).range(o, o + PAGE - 1);
      const b = data ?? [];
      all.push(...(b as unknown as Record<string, unknown>[]));
      if (b.length < PAGE) break;
    }
    const tally = new Map<string, number>();
    for (const r of all) { const v = String(r[statusCol] ?? "(null)"); tally.set(v, (tally.get(v) ?? 0) + 1); }
    console.log(`\n=== distinct "${statusCol}" values (${all.length} rows) ===`);
    for (const [v, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padEnd(34)} ${n}`);
  } else {
    console.log("\n(no column matching /status/i)");
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
