/**
 * Re-populate designs.is_double_sided with the CORRECT rule.
 *
 * Double-sided = Sublimated (Printed) construction (print bleeds through,
 * readable both sides), ALL manufacturers — not "all AF flags". Burlap /
 * Appliqué / Lustre / Moire / Linen are NOT double-sided.
 *
 * A design is double-sided if any shopify_product_types entry is:
 *   - leaf "Sublimated (Printed)"      (the standard printed flag)
 *   - leaf "Long Garden"               (sublimated print, garden-banner size)
 *   - exactly "Garden Flags" / "House Flags"  (newer short label = printed)
 *
 * Supersedes the earlier set-double-sided.ts (which wrongly used
 * manufacturer='AF'). This fixes: ~21 wrongly-true (AF burlap/short) and
 * ~3,270 missing (non-AF printed).
 *
 * Usage:
 *   npx tsx scripts/fix-double-sided.ts          # dry-run
 *   npx tsx scripts/fix-double-sided.ts --apply  # commit
 */
import { getAdminClient } from "./_supabase-admin";

interface Row {
  design_family: string;
  manufacturer: string | null;
  shopify_product_types: string[] | null;
  is_double_sided: boolean | null;
}

function leaves(r: Row): string[] {
  return (r.shopify_product_types ?? []).map((t) => t.split(":").pop()?.trim() ?? "");
}
function isPrinted(r: Row): boolean {
  const types = r.shopify_product_types ?? [];
  const lv = leaves(r);
  return (
    lv.includes("Sublimated (Printed)") ||
    lv.includes("Long Garden") ||
    types.includes("Garden Flags") ||
    types.includes("House Flags")
  );
}

async function main() {
  const apply = process.argv.slice(2).includes("--apply");
  const sb = getAdminClient();

  const rows: Row[] = [];
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await sb
      .from("designs")
      .select("design_family,manufacturer,shopify_product_types,is_double_sided")
      .neq("status", "excluded")
      .range(offset, offset + PAGE - 1);
    if (error) throw error;
    const b = (data ?? []) as Row[];
    rows.push(...b);
    if (b.length < PAGE) break;
  }

  const shouldTrue = rows.filter(isPrinted);
  const toSetTrue = shouldTrue.filter((r) => r.is_double_sided !== true);
  const toSetFalse = rows.filter((r) => !isPrinted(r) && r.is_double_sided === true);

  const byMfr = new Map<string, number>();
  for (const r of shouldTrue) byMfr.set(r.manufacturer ?? "(null)", (byMfr.get(r.manufacturer ?? "(null)") ?? 0) + 1);

  console.log(`Non-excluded designs: ${rows.length}`);
  console.log(`Should be double-sided (printed): ${shouldTrue.length}`);
  for (const [m, n] of [...byMfr.entries()].sort((a, b) => b[1] - a[1]))
    console.log(`    ${m.padEnd(16)} ${n}`);
  console.log(`\n  to SET true  (printed, currently not): ${toSetTrue.length}`);
  console.log(`  to SET false (currently true, not printed): ${toSetFalse.length}`);
  for (const r of toSetFalse.slice(0, 25))
    console.log(`       ${r.design_family} [${leaves(r).join(", ")}]`);

  if (!apply) {
    console.log("\nDRY-RUN. Re-run with --apply to commit.");
    return;
  }

  console.log("\nApplying…");
  const batchUpdate = async (families: string[], value: boolean) => {
    for (let i = 0; i < families.length; i += 200) {
      const slice = families.slice(i, i + 200);
      const { error } = await sb.from("designs").update({ is_double_sided: value }).in("design_family", slice);
      if (error) throw new Error(`update ${value} at ${i}: ${error.message}`);
    }
  };
  await batchUpdate(toSetTrue.map((r) => r.design_family), true);
  console.log(`  set true:  ${toSetTrue.length}`);
  await batchUpdate(toSetFalse.map((r) => r.design_family), false);
  console.log(`  set false: ${toSetFalse.length}`);
  console.log(`\nDone. is_double_sided now true on ${shouldTrue.length} printed designs.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
