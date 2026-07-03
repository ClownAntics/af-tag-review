/**
 * READ-ONLY. Finds Shopify collections matching a keyword and prints how each
 * is defined — smart-collection rules (tag/type/title conditions) or manual —
 * plus product count. Used to see what actually drives the storefront
 * "Memorial Day" / "4th of July" collections.
 *
 * Usage: npx tsx scripts/inspect-shopify-collections.ts memorial july patriotic
 */
import "./_supabase-admin"; // loads .env.local
const API = "2025-01";
const store = process.env.SHOPIFY_STORE;
const tok = process.env.SHOPIFY_ADMIN_TOKEN!;
const base = `https://${store}.myshopify.com/admin/api/${API}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJSON(path: string): Promise<any> {
  for (let a = 0; a < 5; a++) {
    const res = await fetch(`${base}/${path}`, {
      headers: { "X-Shopify-Access-Token": tok, "Content-Type": "application/json" },
    });
    if (res.status === 429) { await sleep((Number(res.headers.get("Retry-After") ?? "2") + a) * 1000); continue; }
    if (!res.ok) { console.warn(`  ${res.status} on ${path}`); await sleep(400 * (a + 1)); continue; }
    return res.json();
  }
  return null;
}

async function allOf(kind: "smart_collections" | "custom_collections"): Promise<any[]> {
  const out: any[] = [];
  let since = 0;
  for (;;) {
    const j = await getJSON(`${kind}.json?limit=250&since_id=${since}`);
    const arr = j?.[kind] ?? [];
    out.push(...arr);
    if (arr.length < 250) break;
    since = arr[arr.length - 1].id;
  }
  return out;
}

async function main() {
  const kws = process.argv.slice(2).map((s) => s.toLowerCase());
  if (!kws.length) kws.push("memorial", "july", "4th", "patriotic", "america");

  const smart = await allOf("smart_collections");
  const custom = await allOf("custom_collections");
  console.log(`Store has ${smart.length} smart + ${custom.length} custom collections. Filtering by: ${kws.join(", ")}\n`);

  const dumpAll = kws.includes("--all");
  const match = (c: any) => dumpAll || kws.some((k) => (c.title ?? "").toLowerCase().includes(k) || (c.handle ?? "").toLowerCase().includes(k));

  for (const c of smart.filter(match)) {
    const rules = (c.rules ?? []).map((r: any) => `${r.column} ${r.relation} "${r.condition}"`).join("  AND/OR  ");
    console.log(`SMART  "${c.title}"  (handle=${c.handle})  matchANY=${c.disjunctive}  ::  ${rules}`);
  }
  console.log("");
  for (const c of custom.filter(match)) {
    console.log(`MANUAL "${c.title}"  (handle=${c.handle})  [hand-curated]`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
