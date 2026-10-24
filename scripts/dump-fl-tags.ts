/**
 * Read-only: dump every FL product's live tags (active + draft, minus
 * ignored types) to fl_tags_live.json, with the design it's linked to.
 * Feeds the legacy-tag → curated-tag mapping for FL collection cleanup.
 *
 * Usage: npx tsx scripts/dump-fl-tags.ts
 */
import { writeFileSync } from "node:fs";
import { getAdminClient } from "./_supabase-admin";
import { listProducts } from "../lib/shopify";
import { isIgnoredFlProduct } from "../lib/fl-sync";

async function main() {
  const sb = getAdminClient();
  const linked = new Map<number, { family: string; status: string; approved: string[] }>();
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await sb
      .from("designs")
      .select("design_family,fl_product_ids,status,approved_tags")
      .not("fl_product_ids", "eq", "{}")
      .order("design_family")
      .range(offset, offset + 999);
    if (error) throw error;
    for (const r of (data ?? []) as Array<{ design_family: string; fl_product_ids: number[]; status: string; approved_tags: string[] | null }>) {
      for (const id of r.fl_product_ids) linked.set(Number(id), { family: r.design_family, status: r.status, approved: r.approved_tags ?? [] });
    }
    if ((data ?? []).length < 1000) break;
  }
  const out: Array<{ id: number; title: string; status: string; product_type: string; vendor: string; family: string | null; status_design: string | null; approved: string[]; tags: string[] }> = [];
  for await (const p of listProducts({ target: "fl", status: "active,draft" })) {
    if (isIgnoredFlProduct(p)) continue;
    out.push({
      id: p.id,
      title: p.title,
      status: p.status,
      product_type: p.product_type ?? "",
      vendor: p.vendor ?? "",
      family: linked.get(p.id)?.family ?? null,
      status_design: linked.get(p.id)?.status ?? null,
      approved: linked.get(p.id)?.approved ?? [],
      tags: (p.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean),
    });
  }
  writeFileSync("fl_tags_live.json", JSON.stringify(out), "utf8");
  console.log(`[dump] ${out.length} FL products, ${out.filter((p) => p.family).length} linked to designs`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
