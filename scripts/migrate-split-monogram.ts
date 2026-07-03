/**
 * Split monogram variants (single trailing letter, e.g. AFGFFA0001A) out of
 * the base design families into their own "M"-suffixed monogram families
 * (AFFA0001M). The base (AFGFFA0001) is a DIFFERENT design — it has no
 * monogram — so merging polluted its tags (Letter-A, Monogrammed).
 * Blake approved 2026-07-03: one monogram family per design number (all 26
 * letters together), base keeps its own family.
 *
 * Two cases:
 *   MIXED (base + monogram SKUs in one family):
 *     - monogram products → new/upserted AF<body>M row (status novision,
 *       approved_tags [], name/image/tags from the monogram products)
 *     - base family keeps only base products; Letter-* / Monogrammed stripped
 *       from approved_tags; derived themes recomputed; status → novision
 *   MONO-ONLY (family is all monogram SKUs, no base):
 *     - key rename AF<body> → AF<body>M preserving the whole row (status,
 *       tags, sales). FK children (events, design_monthly_sales) moved first,
 *       then the old row is deleted.
 *
 * Requires the twin functions to be updated first (parseSku +
 * skuToAfDesignFamily both emit the M-suffixed family for monogram SKUs).
 *
 * Usage:
 *   npx tsx scripts/migrate-split-monogram.ts          # dry-run
 *   npx tsx scripts/migrate-split-monogram.ts --apply  # commit
 */
import { getAdminClient } from "./_supabase-admin";
import { parseSku } from "../lib/sku-parser";
import { mapTagsToThemes } from "../lib/vision";

const API = "2025-01";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ShopProduct { id: number; title: string; product_type: string; image: string | null; tags: string[]; skus: string[] }

/** Batch-fetch products (250 per call) — much faster than one GET per product. */
async function getProducts(ids: number[]): Promise<Map<number, ShopProduct>> {
  const store = process.env.SHOPIFY_STORE, tok = process.env.SHOPIFY_ADMIN_TOKEN!;
  const out = new Map<number, ShopProduct>();
  for (let i = 0; i < ids.length; i += 250) {
    const chunk = ids.slice(i, i + 250);
    const url = `https://${store}.myshopify.com/admin/api/${API}/products.json?ids=${chunk.join(",")}&limit=250&fields=id,title,product_type,image,tags,variants`;
    for (let a = 0; ; a++) {
      const res = await fetch(url, { headers: { "X-Shopify-Access-Token": tok, "Content-Type": "application/json" } });
      if (res.status === 429 && a < 5) { await sleep((Number(res.headers.get("Retry-After") ?? "2") + a) * 1000); continue; }
      if (!res.ok) { if (a < 5) { await sleep(500 * (a + 1)); continue; } throw new Error(`products batch ${res.status}`); }
      for (const p of (await res.json()).products ?? []) {
        out.set(p.id, {
          id: p.id, title: p.title, product_type: (p.product_type ?? "").trim(),
          image: p.image?.src ?? null,
          tags: (p.tags ?? "").split(",").map((s: string) => s.trim()).filter(Boolean),
          skus: (p.variants ?? []).map((v: { sku: string }) => (v.sku ?? "").trim()).filter(Boolean),
        });
      }
      break;
    }
    await sleep(600);
  }
  return out;
}

const isMono = (sku: string) => parseSku(sku)?.variant === "monogram";
const uniq = (a: string[]) => [...new Set(a)];
const stripMonoTags = (tags: string[]) => tags.filter((t) => t !== "Monogrammed" && !/^Letter-[A-Z]$/.test(t));

async function main() {
  const apply = process.argv.slice(2).includes("--apply");
  const sb = getAdminClient();

  const rows: any[] = [];
  const PAGE = 1000;
  for (let o = 0; ; o += PAGE) {
    const { data, error } = await sb.from("designs").select("*").eq("manufacturer", "AF").neq("status", "excluded").range(o, o + PAGE - 1);
    if (error) throw error;
    rows.push(...(data ?? []));
    if ((data ?? []).length < PAGE) break;
  }
  const existingKeys = new Set(rows.map((r) => r.design_family));

  // Affected: any variant SKU is a monogram AND the family key isn't already M-suffixed.
  const affected = rows.filter(
    (r) => !/M$/.test(r.design_family) && (r.variant_skus ?? []).some(isMono),
  );
  const mixed = affected.filter((r) => (r.variant_skus ?? []).some((s: string) => !isMono(s) && parseSku(s)));
  const monoOnly = affected.filter((r) => !mixed.includes(r));
  console.log(`AF non-excluded families: ${rows.length} · affected: ${affected.length} (mixed=${mixed.length}, mono-only rename=${monoOnly.length})\n`);

  // ── MONO-ONLY: pure key rename, no Shopify fetch needed ──────────────────
  const renames: { from: string; to: string }[] = [];
  for (const r of monoOnly) {
    const to = `${r.design_family}M`;
    if (existingKeys.has(to)) { console.warn(`  !! rename target ${to} already exists — skipping ${r.design_family} (reconcile manually)`); continue; }
    renames.push({ from: r.design_family, to });
  }
  console.log(`Renames planned: ${renames.length} (e.g. ${renames.slice(0, 3).map((x) => `${x.from}→${x.to}`).join(", ")})`);

  // ── MIXED: partition products via batch fetch ─────────────────────────────
  const allIds = uniq(mixed.flatMap((r) => (r.shopify_product_ids ?? []) as number[]).map(String)).map(Number);
  console.log(`Fetching ${allIds.length} products for ${mixed.length} mixed families…`);
  const products = await getProducts(allIds);

  const newMonoRows: Record<string, unknown>[] = [];
  const baseUpdates: { family: string; patch: Record<string, unknown> }[] = [];
  let samples = 0;
  for (const d of mixed) {
    const ps = ((d.shopify_product_ids ?? []) as number[]).map((id) => products.get(id)).filter((p): p is ShopProduct => !!p);
    const monoPs: ShopProduct[] = [], basePs: ShopProduct[] = [];
    for (const p of ps) {
      const fam = parseSku(p.skus[0] ?? "")?.designFamily ?? d.design_family;
      (fam === `${d.design_family}M` ? monoPs : basePs).push(p);
    }
    if (!monoPs.length) continue;

    // New monogram family — prefer the "Monogram A" product for name/image.
    const rep = monoPs.slice().sort((a, b) => a.title.localeCompare(b.title))[0];
    newMonoRows.push({
      design_family: `${d.design_family}M`,
      design_name: rep.title,
      manufacturer: "AF",
      status: "novision",
      shopify_tags: uniq(monoPs.flatMap((p) => p.tags)),
      shopify_product_ids: monoPs.map((p) => p.id).sort((a, b) => a - b),
      variant_skus: uniq(monoPs.flatMap((p) => p.skus)).sort(),
      shopify_product_types: uniq(monoPs.map((p) => p.product_type)).sort(),
      image_url: rep.image,
      approved_tags: [],
      theme_names: [], sub_themes: [], sub_sub_themes: [],
    });

    // Base family: trim to base products, strip monogram tags, recompute themes.
    const cleanTags = stripMonoTags((d.approved_tags ?? []) as string[]);
    const t = await mapTagsToThemes(cleanTags);
    baseUpdates.push({
      family: d.design_family,
      patch: {
        shopify_product_ids: basePs.map((p) => p.id).sort((a, b) => a - b),
        variant_skus: uniq(basePs.flatMap((p) => p.skus)).sort(),
        shopify_product_types: uniq(basePs.map((p) => p.product_type)).sort(),
        approved_tags: cleanTags.sort(),
        theme_names: t.theme_names, sub_themes: t.sub_themes, sub_sub_themes: t.sub_sub_themes,
        status: "novision",
      },
    });
    if (samples < 6) console.log(`  ${d.design_family} "${d.design_name}" → base keeps ${basePs.length} · NEW ${d.design_family}M "${rep.title}" (${monoPs.length} products)`);
    samples++;
  }

  console.log(`\nPlan: ${renames.length} renames · create ${newMonoRows.length} monogram families · trim ${baseUpdates.length} base families (all touched → novision).`);
  if (!apply) { console.log("\nDRY-RUN. Add --apply to commit."); return; }

  console.log("\nApplying…");
  // 1. Renames: copy row → move FK children → delete old.
  let renamed = 0;
  for (const { from, to } of renames) {
    const row = rows.find((r) => r.design_family === from);
    const copy = { ...row, design_family: to };
    delete copy.effective_date; // generated column — cannot be inserted (see CHANGELOG 2026-06)
    const { error: insErr } = await sb.from("designs").insert(copy);
    if (insErr) { console.warn(`  rename ${from}: insert failed: ${insErr.message}`); continue; }
    const { error: evErr } = await sb.from("events").update({ design_family: to }).eq("design_family", from);
    if (evErr) console.warn(`  rename ${from}: events move failed: ${evErr.message}`);
    const { error: msErr } = await sb.from("design_monthly_sales").update({ design_family: to }).eq("design_family", from);
    if (msErr) console.warn(`  rename ${from}: sales move failed: ${msErr.message}`);
    const { error: delErr } = await sb.from("designs").delete().eq("design_family", from);
    if (delErr) { console.warn(`  rename ${from}: delete failed: ${delErr.message}`); continue; }
    renamed++;
  }
  console.log(`  renamed ${renamed}/${renames.length} mono-only families`);

  // 2. Insert new monogram rows.
  for (let i = 0; i < newMonoRows.length; i += 200) {
    const { error } = await sb.from("designs").upsert(newMonoRows.slice(i, i + 200) as object[], { onConflict: "design_family" });
    if (error) throw new Error(`upsert new at ${i}: ${error.message}`);
  }
  console.log(`  inserted ${newMonoRows.length} monogram families`);

  // 3. Trim base families.
  let trimmed = 0;
  for (const u of baseUpdates) {
    const { error } = await sb.from("designs").update(u.patch).eq("design_family", u.family);
    if (error) { console.warn(`  ${u.family}: ${error.message}`); continue; }
    trimmed++;
  }
  console.log(`  trimmed ${trimmed} base families`);

  // 4. Events.
  const evs = [
    ...renames.map((x) => ({ design_family: x.to, event_type: "renamed", actor: "blake-via-claude", payload: { from: x.from, reason: "split_monogram" } })),
    ...newMonoRows.map((r) => ({ design_family: r.design_family as string, event_type: "flagged", actor: "blake-via-claude", payload: { reason: "split_monogram", note: "new monogram family (novision)" } })),
    ...baseUpdates.map((u) => ({ design_family: u.family, event_type: "tag_removed", actor: "blake-via-claude", payload: { reason: "split_monogram", note: "monogram SKUs+tags removed from base" } })),
  ];
  for (let i = 0; i < evs.length; i += 200) await sb.from("events").insert(evs.slice(i, i + 200));
  console.log(`\nDone.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
