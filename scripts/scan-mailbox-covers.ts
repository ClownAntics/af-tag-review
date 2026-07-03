/**
 * READ-ONLY (T6). Checks whether Mailbox Cover (AFMC…) products always share
 * artwork with the flag family they collapse into, or whether the
 * manufacturer reuses MC numbers for different art (like GB/DR did).
 *
 * Method: for every family containing an AFMC SKU, compare the MC product's
 * title against the family's design_name (both normalized: vendor prefix,
 * product-type words, monogram/variant noise stripped). Mismatched titles =
 * candidate wrong-merge for human eyes.
 *
 * Usage: npx tsx scripts/scan-mailbox-covers.ts
 */
import { getAdminClient } from "./_supabase-admin";

const API = "2025-01";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getProductsBatch(ids: number[]): Promise<Map<number, { title: string; skus: string[] }>> {
  const store = process.env.SHOPIFY_STORE, tok = process.env.SHOPIFY_ADMIN_TOKEN!;
  const out = new Map<number, { title: string; skus: string[] }>();
  for (let i = 0; i < ids.length; i += 250) {
    const chunk = ids.slice(i, i + 250);
    const url = `https://${store}.myshopify.com/admin/api/${API}/products.json?ids=${chunk.join(",")}&limit=250&fields=id,title,variants`;
    for (let a = 0; ; a++) {
      const res = await fetch(url, { headers: { "X-Shopify-Access-Token": tok, "Content-Type": "application/json" } });
      if (res.status === 429 && a < 5) { await sleep((Number(res.headers.get("Retry-After") ?? "2") + a) * 1000); continue; }
      if (!res.ok) { if (a < 5) { await sleep(500 * (a + 1)); continue; } throw new Error(`batch ${res.status}`); }
      for (const p of (await res.json()).products ?? []) {
        out.set(p.id, {
          title: p.title,
          skus: (p.variants ?? []).map((v: { sku: string }) => (v.sku ?? "").trim().toUpperCase()).filter(Boolean),
        });
      }
      break;
    }
    await sleep(600);
  }
  return out;
}

/** Normalize a title for art-identity comparison. */
function norm(t: string): string {
  return t
    .toLowerCase()
    .replace(/^america forever\s*/i, "")
    .replace(/\b(garden|house|banner|mailbox|cover|flag|flags|doormat|monogram(med)?|personalized|custom)\b/g, "")
    .replace(/-\s*monogram\s+[a-z]$/i, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function main() {
  const sb = getAdminClient();
  const rows: any[] = [];
  for (let o = 0; ; o += 1000) {
    const { data, error } = await sb
      .from("designs")
      .select("design_family,design_name,status,variant_skus,shopify_product_ids")
      .eq("manufacturer", "AF")
      .neq("status", "excluded")
      .range(o, o + 999);
    if (error) throw error;
    rows.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }

  const withMc = rows.filter((r) => (r.variant_skus ?? []).some((s: string) => /^AFMC/i.test(s)));
  console.log(`AF families containing an AFMC SKU: ${withMc.length}`);

  const allIds = [...new Set(withMc.flatMap((r) => (r.shopify_product_ids ?? []) as number[]))];
  console.log(`Fetching ${allIds.length} products…\n`);
  const products = await getProductsBatch(allIds);

  let match = 0;
  const mismatches: { family: string; famName: string; mcTitle: string }[] = [];
  for (const r of withMc) {
    for (const pid of (r.shopify_product_ids ?? []) as number[]) {
      const p = products.get(pid);
      if (!p || !p.skus.some((s) => /^AFMC/.test(s))) continue;
      const a = norm(r.design_name ?? "");
      const b = norm(p.title);
      if (a && b && (a.includes(b) || b.includes(a))) match++;
      else mismatches.push({ family: r.design_family, famName: r.design_name ?? "", mcTitle: p.title });
    }
  }

  console.log(`MC products matching their family's art (by title): ${match}`);
  console.log(`MISMATCHES (need eyes): ${mismatches.length}`);
  for (const m of mismatches.slice(0, 30)) {
    console.log(`  ${m.family}: family="${m.famName}"  vs  MC="${m.mcTitle}"`);
  }
  if (mismatches.length > 30) console.log(`  … and ${mismatches.length - 30} more`);
}
main().catch((e) => { console.error(e); process.exit(1); });
