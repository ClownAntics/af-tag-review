/**
 * SUPERSEDED by scripts/fix-double-sided.ts. This used the wrong rule
 * (manufacturer='AF'); the correct rule is "Sublimated (Printed)" across
 * all manufacturers. Kept for history only — do not run.
 *
 * Set `designs.is_double_sided = true` for every AF flag family.
 *
 * Rule: manufacturer = 'AF', status != 'excluded', and at least one
 * `shopify_product_types` entry contains "Flag" (catches both the
 * "Sleeved Flags: …" Type labels and the "Garden Flags" / "House Flags"
 * short labels). Excludes the one AF doormat-only family.
 *
 * AF garden/house flags are double-sided by construction — the sublimated
 * print reads through to the back. Derived attribute, not synced from
 * TeamDesk (TeamDesk has no isDoubleSided? field).
 *
 * Requires migration 011_double_sided.sql applied first.
 *
 * Usage:
 *   npx tsx scripts/set-double-sided.ts          # dry-run
 *   npx tsx scripts/set-double-sided.ts --apply  # commit
 */
import { getAdminClient } from "./_supabase-admin";

interface Row {
  design_family: string;
  status: string;
  shopify_product_types: string[] | null;
}

function isFlag(r: Row): boolean {
  return (r.shopify_product_types ?? []).some((t) => /flag/i.test(t));
}

async function main() {
  const apply = process.argv.slice(2).includes("--apply");
  const sb = getAdminClient();

  const rows: Row[] = [];
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await sb
      .from("designs")
      .select("design_family,status,shopify_product_types")
      .eq("manufacturer", "AF")
      .neq("status", "excluded")
      .range(offset, offset + PAGE - 1);
    if (error) throw error;
    const batch = (data ?? []) as Row[];
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }

  const targets = rows.filter(isFlag);
  const skipped = rows.filter((r) => !isFlag(r));
  console.log(`Non-excluded AF families: ${rows.length}`);
  console.log(`  → flags (set is_double_sided=true): ${targets.length}`);
  console.log(`  → non-flags (skipped): ${skipped.length}`);
  for (const s of skipped)
    console.log(`      skip ${s.design_family} [${(s.shopify_product_types ?? []).join(", ")}]`);

  if (!apply) {
    console.log("\nDRY-RUN. Re-run with --apply to commit.");
    return;
  }

  console.log("\nApplying…");
  let done = 0;
  const families = targets.map((t) => t.design_family);
  for (let i = 0; i < families.length; i += 200) {
    const slice = families.slice(i, i + 200);
    const { error } = await sb
      .from("designs")
      .update({ is_double_sided: true })
      .in("design_family", slice);
    if (error) throw new Error(`update batch at ${i}: ${error.message}`);
    done += slice.length;
    console.log(`  set ${done}/${families.length}`);
  }
  console.log(`\nDone. is_double_sided=true on ${done} AF flag families.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
