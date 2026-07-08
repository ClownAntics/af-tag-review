/**
 * Holiday excludes its parent season (Blake 2026-07-08): a design carrying a
 * holiday tag should NOT also carry that holiday's generic season — it belongs
 * in the holiday collection, not the season one (Christmas→not Winter,
 * 4th-Of-July→not Summer, Halloween→not Fall, Easter→not Spring, …).
 *
 * The holiday→season mapping is read live from taxonomy_entries
 * (is_holiday + is_spring/summer/fall/winter); the season terms are the
 * is_season=true entries (Spring/Summer/Fall/Winter). For each non-excluded
 * design: if it has a holiday tag, drop that holiday's parent season term(s)
 * from approved_tags + vision_tags, and recompute the theme columns.
 *
 * Live products (status='updated') also get the season tag surgically removed
 * from Shopify (other tags untouched), and the shopify_tags mirror updated.
 *
 * Flags:
 *   --apply              commit (default dry-run)
 *   --only Christmas      restrict to one holiday (e.g. Christmas)
 *   --move-pending        set changed designs to status='pending' for review
 *   --no-shopify          skip live Shopify edits (DB only)
 *
 *   npx tsx scripts/resolve-holiday-season.ts                       # dry-run all
 *   npx tsx scripts/resolve-holiday-season.ts --only Christmas --move-pending --apply
 *   npx tsx scripts/resolve-holiday-season.ts --apply
 */
import { getAdminClient } from "./_supabase-admin";
import { mapTagsToThemes } from "../lib/vision";

const API = "2025-01";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? "") : null;
}
const APPLY = process.argv.includes("--apply");
const MOVE_PENDING = process.argv.includes("--move-pending");
const NO_SHOPIFY = process.argv.includes("--no-shopify");
const ONLY = arg("--only");

async function shopifyRemoveTag(productId: number, tagKey: string): Promise<"removed" | "absent" | "error"> {
  const store = process.env.SHOPIFY_STORE, tok = process.env.SHOPIFY_ADMIN_TOKEN!;
  const H = { "X-Shopify-Access-Token": tok, "Content-Type": "application/json" };
  const url = `https://${store}.myshopify.com/admin/api/${API}/products/${productId}.json`;
  const getRes = await fetch(`${url}?fields=id,tags`, { headers: H });
  if (!getRes.ok) return "error";
  const tags: string[] = ((await getRes.json()).product.tags ?? "").split(",").map((t: string) => t.trim()).filter(Boolean);
  if (!tags.some((t) => t.toLowerCase().replace(/\s+/g, "-") === tagKey)) return "absent";
  const next = tags.filter((t) => t.toLowerCase().replace(/\s+/g, "-") !== tagKey);
  const putRes = await fetch(url, { method: "PUT", headers: H, body: JSON.stringify({ product: { id: productId, tags: next.join(", ") } }) });
  return putRes.ok ? "removed" : "error";
}

async function main() {
  const sb = getAdminClient();

  // Holiday → parent season(s), and the set of generic Season terms.
  const { data: tax } = await sb
    .from("taxonomy_entries")
    .select("search_term,is_holiday,is_season,is_spring,is_summer,is_fall,is_winter");
  const seasonOf: Record<string, ("Spring"|"Summer"|"Fall"|"Winter")[]> = {};
  const seasonTerms = new Set<string>();
  for (const t of tax ?? []) {
    if (!t.search_term) continue;
    if (t.is_season) seasonTerms.add(t.search_term);
    if (t.is_holiday) {
      const s: ("Spring"|"Summer"|"Fall"|"Winter")[] = [];
      if (t.is_spring) s.push("Spring");
      if (t.is_summer) s.push("Summer");
      if (t.is_fall) s.push("Fall");
      if (t.is_winter) s.push("Winter");
      if (s.length) seasonOf[t.search_term] = s;
    }
  }
  const holidays = Object.keys(seasonOf).filter((h) => !ONLY || h === ONLY);
  console.log(`Holidays in scope: ${holidays.length}${ONLY ? ` (only ${ONLY})` : ""}`);

  // Scan all non-excluded designs.
  const rows: any[] = [];
  for (let o = 0; ; o += 1000) {
    const { data, error } = await sb
      .from("designs")
      .select("design_family,design_name,status,approved_tags,vision_tags,shopify_product_ids,shopify_tags")
      .neq("status", "excluded")
      .order("design_family")
      .range(o, o + 999);
    if (error) throw error;
    rows.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }

  const changes: { r: any; removeSeasons: Set<string>; newApproved: string[]; newVision: string[] }[] = [];
  const tally: Record<string, number> = {};
  for (const r of rows) {
    const approved: string[] = r.approved_tags ?? [];
    const vision: string[] = r.vision_tags ?? [];
    const present = holidays.filter((h) => approved.includes(h) || vision.includes(h));
    if (!present.length) continue;
    const remove = new Set<string>();
    for (const h of present) for (const s of seasonOf[h]) if (seasonTerms.has(s)) remove.add(s);
    // Only remove seasons actually present.
    const toRemove = [...remove].filter((s) => approved.includes(s) || vision.includes(s));
    if (!toRemove.length) continue;
    const newApproved = approved.filter((t) => !toRemove.includes(t));
    const newVision = vision.filter((t) => !toRemove.includes(t));
    if (newApproved.length === approved.length && newVision.length === vision.length) continue;
    changes.push({ r, removeSeasons: new Set(toRemove), newApproved, newVision });
    for (const s of toRemove) {
      const h = present.find((x) => seasonOf[x].includes(s as any));
      tally[`${h}→${s}`] = (tally[`${h}→${s}`] ?? 0) + 1;
    }
  }

  const liveChanges = changes.filter((c) => c.r.status === "updated" && c.newApproved.length < (c.r.approved_tags ?? []).length);
  console.log(`\nDesigns to fix: ${changes.length}  (live/updated needing Shopify edits: ${liveChanges.length})`);
  console.log("By holiday→season removed:");
  for (const [k, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`  ${n}\t${k}`);
  if (MOVE_PENDING) console.log(`\n--move-pending: changed designs will be set to 'pending'.`);
  if (!APPLY) { console.log("\nDRY-RUN. Add --apply to commit."); return; }

  console.log("\nApplying…");
  let dbDone = 0, shopRemoved = 0, shopErr = 0;
  for (const c of changes) {
    const t = await mapTagsToThemes(c.newApproved);
    const patch: Record<string, unknown> = {
      approved_tags: c.newApproved, vision_tags: c.newVision,
      theme_names: t.theme_names, sub_themes: t.sub_themes, sub_sub_themes: t.sub_sub_themes,
    };
    if (MOVE_PENDING) patch.status = "pending";
    const { error } = await sb.from("designs").update(patch).eq("design_family", c.r.design_family);
    if (error) { console.warn(`  ${c.r.design_family}: ${error.message}`); continue; }
    await sb.from("events").insert({
      design_family: c.r.design_family, event_type: "tag_removed", actor: "blake-via-claude",
      payload: { removed: [...c.removeSeasons], reason: "holiday excludes parent season", source: "resolve-holiday-season" },
    });
    dbDone++;
    // Live Shopify edits: only for updated designs, only the removed season(s).
    if (!NO_SHOPIFY && c.r.status === "updated") {
      let anyShop = false;
      for (const s of c.removeSeasons) {
        const key = s.toLowerCase();
        for (const pid of (c.r.shopify_product_ids ?? []) as number[]) {
          const res = await shopifyRemoveTag(pid, key);
          if (res === "removed") { shopRemoved++; anyShop = true; } else if (res === "error") shopErr++;
          await sleep(300);
        }
      }
      if (anyShop) {
        const liveMinus = (c.r.shopify_tags ?? []).filter((x: string) => ![...c.removeSeasons].some((s) => s.toLowerCase() === x.toLowerCase()));
        await sb.from("designs").update({ shopify_tags: liveMinus }).eq("design_family", c.r.design_family);
      }
    }
    if (dbDone % 25 === 0) console.log(`  … ${dbDone}/${changes.length} db, ${shopRemoved} shopify tag removals`);
  }
  console.log(`\nDone. DB fixed ${dbDone}/${changes.length}; Shopify tag removals ${shopRemoved} (errors ${shopErr}).`);
}
main().catch((e) => { console.error(e); process.exit(1); });
