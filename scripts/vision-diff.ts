/**
 * Export a CSV comparing Shopify tags vs. Claude-vision themes per design.
 *
 * Run AFTER scripts/tag-with-vision.ts has populated vision_* columns.
 *
 * Output columns:
 *   design_family, design_name, image_url, classification,
 *   shopify_tags,           (sorted, semicolon-joined)
 *   vision_theme_names,     (sorted, semicolon-joined)
 *   vision_sub_themes,
 *   vision_sub_sub_themes,
 *   derived_shopify_themes, (lookup of each shopify_tag in FL Themes → top-level Name)
 *   theme_agreement,        ("same" | "vision_broader" | "shopify_broader" | "disjoint" | "no_vision")
 *   shopify_only_themes,    (themes derived from shopify that vision missed)
 *   vision_only_themes,     (themes vision added that shopify lacked)
 *
 * Usage:
 *   npx tsx scripts/vision-diff.ts                          # writes to ./vision_vs_shopify_diff.csv
 *   npx tsx scripts/vision-diff.ts ./somewhere/out.csv
 */
import { createReadStream, createWriteStream } from "node:fs";
import { resolve } from "node:path";
import { parse } from "csv-parse";
import { getAdminClient } from "./_supabase-admin";

const TAXONOMY_CSV =
  "C:/Users/gbcab/ClownAntics Dropbox/Blake Cabot/Docs/Internet Business/200904 Clown/202604 AF Research App/FL Themes_zz Export View.csv";

const DEFAULT_OUT = "./vision_vs_shopify_diff.csv";

interface DesignRow {
  design_family: string;
  design_name: string | null;
  image_url: string | null;
  classification: string | null;
  shopify_tags: string[] | null;
  theme_names: string[] | null;
  vision_theme_names: string[] | null;
  vision_sub_themes: string[] | null;
  vision_sub_sub_themes: string[] | null;
  vision_tagged_at: string | null;
}

function normTag(t: string): string {
  return t.trim().toLowerCase().replace(/[\s_]+/g, "-");
}

async function loadTagToTheme(csvPath: string): Promise<Map<string, string>> {
  // Map normalized shopify tag → top-level Name (skipping Business/Features/Size).
  const out = new Map<string, string>();
  const EXCLUDED = new Set(["Business", "Features", "Size"]);
  const parser = createReadStream(csvPath).pipe(
    parse({ columns: true, bom: true, skip_empty_lines: true, trim: true }),
  );
  for await (const r of parser as AsyncIterable<Record<string, string>>) {
    const term = (r["Search Term"] || "").trim();
    const name = (r["Name"] || "").trim();
    if (!term || !name || EXCLUDED.has(name)) continue;
    out.set(normTag(term), name);
  }
  return out;
}

function csvEscape(s: string): string {
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function joinArr(a: string[] | null | undefined): string {
  if (!a) return "";
  return Array.from(new Set(a)).sort().join("; ");
}

async function main() {
  const outPath = resolve(process.argv[2] || DEFAULT_OUT);

  console.log(`Loading tag→theme map: ${TAXONOMY_CSV}`);
  const tagToTheme = await loadTagToTheme(TAXONOMY_CSV);
  console.log(`  ${tagToTheme.size} tag mappings\n`);

  const sb = getAdminClient();
  const designs: DesignRow[] = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await sb
      .from("designs")
      .select(
        "design_family,design_name,image_url,classification,shopify_tags,theme_names,vision_theme_names,vision_sub_themes,vision_sub_sub_themes,vision_tagged_at",
      )
      .order("design_family", { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) throw new Error(error.message);
    const rows = (data || []) as DesignRow[];
    designs.push(...rows);
    if (rows.length < pageSize) break;
  }
  console.log(`Loaded ${designs.length} designs`);

  const out = createWriteStream(outPath);
  const header = [
    "design_family",
    "design_name",
    "image_url",
    "classification",
    "vision_tagged_at",
    "shopify_tags",
    "derived_shopify_themes",
    "vision_theme_names",
    "vision_sub_themes",
    "vision_sub_sub_themes",
    "theme_agreement",
    "shopify_only_themes",
    "vision_only_themes",
  ];
  out.write(header.join(",") + "\n");

  let taggedCount = 0;
  let agreementSame = 0;
  let agreementBroader = 0;
  let agreementDisjoint = 0;

  for (const d of designs) {
    const shopifyTags = d.shopify_tags || [];
    // Derive what top-level themes Shopify tags imply, using the same lookup
    // import-themes.ts uses — or fall back to theme_names (already computed).
    const derivedThemes = new Set<string>();
    if (d.theme_names) {
      for (const t of d.theme_names) derivedThemes.add(t);
    } else {
      for (const tag of shopifyTags) {
        const name = tagToTheme.get(normTag(tag));
        if (name) derivedThemes.add(name);
      }
    }

    const visionThemes = new Set(d.vision_theme_names || []);
    const hasVision = d.vision_tagged_at !== null;
    if (hasVision) taggedCount++;

    // Comparison at Name level (most useful signal for Shopify cleanup).
    const shopifyOnly: string[] = [];
    const visionOnly: string[] = [];
    for (const t of derivedThemes) if (!visionThemes.has(t)) shopifyOnly.push(t);
    for (const t of visionThemes) if (!derivedThemes.has(t)) visionOnly.push(t);

    let agreement: string;
    if (!hasVision) {
      agreement = "no_vision";
    } else if (shopifyOnly.length === 0 && visionOnly.length === 0) {
      agreement = "same";
      agreementSame++;
    } else if (shopifyOnly.length === 0) {
      agreement = "vision_broader";
      agreementBroader++;
    } else if (visionOnly.length === 0) {
      agreement = "shopify_broader";
      agreementBroader++;
    } else {
      agreement = "disjoint";
      agreementDisjoint++;
    }

    const row = [
      d.design_family,
      d.design_name || "",
      d.image_url || "",
      d.classification || "",
      d.vision_tagged_at || "",
      joinArr(shopifyTags),
      joinArr(Array.from(derivedThemes)),
      joinArr(d.vision_theme_names),
      joinArr(d.vision_sub_themes),
      joinArr(d.vision_sub_sub_themes),
      agreement,
      joinArr(shopifyOnly),
      joinArr(visionOnly),
    ].map(csvEscape);
    out.write(row.join(",") + "\n");
  }

  await new Promise<void>((r) => out.end(r));

  console.log(`\nWrote ${outPath}`);
  console.log(`  tagged:           ${taggedCount} / ${designs.length}`);
  console.log(`  same:             ${agreementSame}`);
  console.log(`  one broader:      ${agreementBroader}`);
  console.log(`  disjoint:         ${agreementDisjoint}`);
  console.log(`  not yet tagged:   ${designs.length - taggedCount}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
