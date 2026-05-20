import { getAdminClient } from "./_supabase-admin";

(async () => {
  const sb = getAdminClient();
  const counts = new Map<string, number>();
  let total = 0;
  let withoutType = 0;
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await sb
      .from("designs")
      .select("shopify_product_types")
      .order("design_family")
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as { shopify_product_types: string[] | null }[];
    for (const r of rows) {
      total++;
      const types = r.shopify_product_types ?? [];
      if (types.length === 0) withoutType++;
      for (const t of types) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    if (rows.length < PAGE) break;
  }
  console.log(`Total designs: ${total}`);
  console.log(`Without shopify_product_types: ${withoutType}`);
  console.log("");
  console.log("Distinct shopify_product_types (count = families containing each):");
  console.log("─".repeat(60));
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [t, n] of sorted) {
    console.log(`  ${String(n).padStart(5)}  ${t}`);
  }
})();
