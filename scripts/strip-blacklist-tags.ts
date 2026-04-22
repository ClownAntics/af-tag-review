/**
 * One-off cleanup: for every JF Shopify product, strip any tag that is NOT
 * in the FL-Themes taxonomy (matching against both canonical term and label,
 * case-insensitive). Refresh our shopify_tags mirror, and move affected
 * families to status=readytosend with approved_tags set to the surviving
 * taxonomy terms. Families whose surviving set is empty are left alone so
 * a future push can't blank them.
 *
 * The "blacklist" here is implicit: anything not in lib/taxonomy.json.
 *
 * Usage:
 *   npx tsx scripts/strip-blacklist-tags.ts                # dry-run
 *   npx tsx scripts/strip-blacklist-tags.ts --limit 50     # dry-run first 50 products
 *   npx tsx scripts/strip-blacklist-tags.ts --apply        # PUT to Shopify + update DB
 */
import { getAdminClient } from "./_supabase-admin";
import { listProducts, productToFamily, updateProductTags } from "../lib/shopify";
import taxonomy from "../lib/taxonomy.json";

// Map lowercased term OR label → canonical term. Shopify tag matches either
// form resolve to the canonical term for approved_tags.
const TAXONOMY_INDEX = new Map<string, string>();
{
  const entries = (taxonomy as { entries: { term: string; label: string }[] })
    .entries;
  for (const e of entries) {
    TAXONOMY_INDEX.set(e.term.toLowerCase(), e.term);
    TAXONOMY_INDEX.set(e.label.toLowerCase(), e.term);
  }
}

function toCanonicalTerm(tag: string): string | null {
  return TAXONOMY_INDEX.get(tag.trim().toLowerCase()) ?? null;
}

function isInTaxonomy(tag: string): boolean {
  return TAXONOMY_INDEX.has(tag.trim().toLowerCase());
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const out = { apply: false, limit: null as number | null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--apply") out.apply = true;
    else if (argv[i] === "--limit") out.limit = Number(argv[++i]);
    else throw new Error(`unknown arg: ${argv[i]}`);
  }
  return out;
}

async function main() {
  const { apply, limit } = parseArgs();
  const sb = getAdminClient();

  type ProductRec = {
    productId: number;
    family: string | null;
    originalTags: string[];
    cleanedTags: string[]; // kept (in taxonomy) — keeps original casing
    changed: boolean;
  };

  const records: ProductRec[] = [];
  const byFamily = new Map<
    string,
    { cleanedUnion: Set<string>; anyChanged: boolean }
  >();
  let seen = 0;

  console.log(
    `[strip] streaming JF catalog${limit ? ` (limit=${limit})` : ""}…`,
  );
  for await (const p of listProducts({ max: limit ?? undefined })) {
    seen++;
    const origTags = (p.tags ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const cleaned = origTags.filter((t) => isInTaxonomy(t));
    const changed = cleaned.length !== origTags.length;
    const resolved = productToFamily(p);
    const family = resolved?.design_family ?? null;

    records.push({
      productId: p.id,
      family,
      originalTags: origTags,
      cleanedTags: cleaned,
      changed,
    });

    if (family) {
      const bucket = byFamily.get(family) ?? {
        cleanedUnion: new Set<string>(),
        anyChanged: false,
      };
      for (const t of cleaned) bucket.cleanedUnion.add(t);
      if (changed) bucket.anyChanged = true;
      byFamily.set(family, bucket);
    }

    if (seen % 500 === 0) {
      console.log(`  … ${seen} products, ${byFamily.size} families`);
    }
  }
  console.log(
    `[strip] streamed ${seen} products → ${byFamily.size} families.`,
  );

  const productsToUpdate = records.filter((r) => r.changed);
  const familiesToClean = [...byFamily.entries()]
    .filter(([, b]) => b.anyChanged)
    .map(([family, b]) => ({ family, cleaned: [...b.cleanedUnion].sort() }));

  console.log(
    `[strip] ${productsToUpdate.length} products have non-taxonomy tags to strip.`,
  );
  console.log(`[strip] ${familiesToClean.length} families affected.`);

  // approved_tags = surviving taxonomy terms (canonicalized).
  const familyApproved = new Map<string, string[]>();
  for (const { family, cleaned } of familiesToClean) {
    const approved = new Set<string>();
    for (const t of cleaned) {
      const canon = toCanonicalTerm(t);
      if (canon) approved.add(canon);
    }
    familyApproved.set(family, [...approved].sort());
  }
  const willMove = familiesToClean.filter(
    ({ family }) => (familyApproved.get(family) ?? []).length > 0,
  );
  const willStay = familiesToClean.length - willMove.length;
  console.log(`  → will move to readytosend: ${willMove.length}`);
  console.log(`  → will stay novision (no surviving taxonomy tags): ${willStay}`);
  console.log();

  // Removed-tag breakdown (top 30).
  const removed = new Map<string, number>();
  for (const r of productsToUpdate) {
    for (const t of r.originalTags) {
      if (!isInTaxonomy(t)) removed.set(t, (removed.get(t) ?? 0) + 1);
    }
  }
  const removedSorted = [...removed.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`Distinct non-taxonomy tags removed: ${removedSorted.length}`);
  console.log("Top 30 by count:");
  for (const [t, c] of removedSorted.slice(0, 30)) {
    console.log(`  ${String(c).padStart(5)}×  ${t}`);
  }
  console.log();

  if (!apply) {
    console.log(
      "DRY-RUN. Re-run with --apply to PUT tag updates to Shopify and update DB.",
    );
    return;
  }

  // ── APPLY ────────────────────────────────────────────────────────────────
  console.log(
    `[apply] PUTting ${productsToUpdate.length} products to Shopify (serial, ~500ms/req)…`,
  );
  let putDone = 0;
  let putFailed = 0;
  for (const r of productsToUpdate) {
    try {
      await updateProductTags(r.productId, r.cleanedTags);
      putDone++;
    } catch (e) {
      putFailed++;
      console.error(
        `  failed id=${r.productId}: ${e instanceof Error ? e.message : e}`,
      );
    }
    if (putDone % 50 === 0 || putDone + putFailed === productsToUpdate.length) {
      console.log(
        `  progress: ${putDone + putFailed}/${productsToUpdate.length} (ok=${putDone}, failed=${putFailed})`,
      );
    }
    await new Promise((res) => setTimeout(res, 500));
  }
  console.log(`[apply] Shopify PUTs: ok=${putDone}, failed=${putFailed}.`);

  console.log(
    `[apply] updating Supabase for ${familiesToClean.length} families…`,
  );
  let dbOk = 0;
  let dbFailed = 0;
  for (const { family, cleaned } of familiesToClean) {
    const approved = familyApproved.get(family) ?? [];
    const patch: Record<string, unknown> = { shopify_tags: cleaned };
    let moved = false;
    if (approved.length > 0) {
      patch.approved_tags = approved;
      patch.status = "readytosend";
      patch.last_reviewed_at = new Date().toISOString();
      moved = true;
    }
    const { error } = await sb
      .from("designs")
      .update(patch)
      .eq("design_family", family);
    if (error) {
      dbFailed++;
      console.error(`  ${family}: ${error.message}`);
      continue;
    }
    dbOk++;

    await sb.from("events").insert({
      design_family: family,
      event_type: "bulk_strip_non_taxonomy",
      actor: "system",
      payload: {
        moved_to_readytosend: moved,
        approved_tags_after: approved,
      },
    });

    if (dbOk % 100 === 0 || dbOk + dbFailed === familiesToClean.length) {
      console.log(
        `  progress: ${dbOk + dbFailed}/${familiesToClean.length} (ok=${dbOk}, failed=${dbFailed})`,
      );
    }
  }
  console.log(`[apply] DB updates: ok=${dbOk}, failed=${dbFailed}.`);
  console.log("[apply] done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
