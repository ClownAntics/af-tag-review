/**
 * Status breakdown of all designs, plus: for each material product-type,
 * how those designs are distributed across statuses. Helps decide whether the
 * non-Printed materials are an unreviewed backlog vs a tagging gap on live rows.
 */
import { getAdminClient } from "./_supabase-admin";

const MATERIAL_LEAF_TAG: Record<string, string> = {
  "Sublimated (Printed)": "Printed",
  Appliqued: "Applique",
  Burlap: "Burlap",
  Lustre: "Lustre",
  "Linen Flags": "Linen",
  Moire: "Moire",
};

async function main() {
  const sb = getAdminClient();
  const rows: { status: string; shopify_product_types: string[] | null; manufacturer: string | null }[] = [];
  const PAGE = 1000;
  for (let o = 0; ; o += PAGE) {
    const { data, error } = await sb
      .from("designs")
      .select("status,shopify_product_types,manufacturer")
      .range(o, o + PAGE - 1);
    if (error) throw error;
    const b = data ?? [];
    rows.push(...(b as typeof rows));
    if (b.length < PAGE) break;
  }

  console.log(`Total designs: ${rows.length}\n`);
  const byStatus = new Map<string, number>();
  for (const r of rows) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
  console.log("Status breakdown:");
  for (const [s, n] of [...byStatus.entries()].sort((a, b) => b[1] - a[1]))
    console.log(`  ${s.padEnd(13)} ${n}`);

  // Per material: distinct designs by status
  console.log("\nDesigns per material (distinct, by status):");
  const mats = [...new Set(Object.values(MATERIAL_LEAF_TAG))];
  for (const mat of mats) {
    const leaves = Object.entries(MATERIAL_LEAF_TAG).filter(([, v]) => v === mat).map(([k]) => k);
    const hits = rows.filter((r) =>
      (r.shopify_product_types ?? []).some((pt) => leaves.includes(pt.split(":").pop()?.trim() ?? "")),
    );
    const st = new Map<string, number>();
    for (const h of hits) st.set(h.status, (st.get(h.status) ?? 0) + 1);
    const byStr = [...st.entries()].sort().map(([s, n]) => `${s}:${n}`).join("  ");
    console.log(`  ${mat.padEnd(10)} total=${hits.length}   ${byStr}`);
  }

  // novision manufacturer breakdown (who is the backlog?)
  const nov = rows.filter((r) => r.status === "novision");
  const novMfr = new Map<string, number>();
  for (const r of nov) novMfr.set(r.manufacturer ?? "?", (novMfr.get(r.manufacturer ?? "?") ?? 0) + 1);
  console.log(`\nnovision by manufacturer (${nov.length} total):`);
  for (const [m, n] of [...novMfr.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${(m ?? "?").padEnd(12)} ${n}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
