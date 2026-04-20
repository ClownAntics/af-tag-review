/**
 * AI-tag every design by showing Claude its garden-flag image and asking it to
 * pick themes from the FL Themes taxonomy. Writes back to
 * designs.vision_theme_names / vision_sub_themes / vision_sub_sub_themes.
 *
 * Run AFTER import-themes.ts (so validation against the taxonomy matches what
 * the dashboard uses) and AFTER running supabase/migrations/001_add_vision_columns.sql.
 *
 * Usage:
 *   npx tsx scripts/tag-with-vision.ts                       # full run (~2,900 designs)
 *   npx tsx scripts/tag-with-vision.ts --limit 20            # first 20
 *   npx tsx scripts/tag-with-vision.ts --stratified 20       # 4 per band × 5 bands
 *   npx tsx scripts/tag-with-vision.ts --only AFSU0419,AFSP0662
 *   npx tsx scripts/tag-with-vision.ts --force               # re-tag designs already tagged
 *   npx tsx scripts/tag-with-vision.ts --concurrency 3       # parallel API calls (default 5)
 *
 * Env: requires ANTHROPIC_API_KEY in .env.local.
 */
import { resolve } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { getAdminClient } from "./_supabase-admin";
import { loadTaxonomy, type Taxonomy } from "./_taxonomy";

const TAXONOMY_CSV =
  "C:/Users/gbcab/ClownAntics Dropbox/Blake Cabot/Docs/Internet Business/200904 Clown/202604 AF Research App/FL Themes_zz Export View.csv";

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 1024;

interface Args {
  limit: number | null;
  stratified: number | null;
  only: string[] | null;
  force: boolean;
  concurrency: number;
  dryRun: boolean;
}

function parseArgs(): Args {
  const a: Args = {
    limit: null,
    stratified: null,
    only: null,
    force: false,
    concurrency: 5,
    dryRun: false,
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === "--limit") { a.limit = parseInt(v, 10); i++; }
    else if (k === "--stratified") { a.stratified = parseInt(v, 10); i++; }
    else if (k === "--only") { a.only = v.split(",").map((s) => s.trim()).filter(Boolean); i++; }
    else if (k === "--force") { a.force = true; }
    else if (k === "--concurrency") { a.concurrency = parseInt(v, 10); i++; }
    else if (k === "--dry-run") { a.dryRun = true; }
    else if (k === "--help" || k === "-h") { printHelp(); process.exit(0); }
  }
  return a;
}

function printHelp() {
  console.log(`tag-with-vision.ts — AI-tag designs using Claude vision

  --limit N            tag the first N designs
  --stratified N       tag N designs per classification band (hit/solid/ok/weak/dead)
  --only A,B,C         tag only the listed design_family codes
  --force              re-tag designs that already have vision_theme_names
  --concurrency N      parallel API calls (default 5)
  --dry-run            print the prompt for the first design and exit
`);
}

// ──────────────────────────────────────────────────────────────────────────────

interface VisionResponse {
  theme_names: string[];
  sub_themes: string[];
  sub_sub_themes: string[];
  confidence: "high" | "medium" | "low";
  notes?: string;
}

type DesignRow = {
  design_family: string;
  design_name: string | null;
  image_url: string | null;
  classification: string | null;
  shopify_tags: string[] | null;
  vision_theme_names: string[] | null;
};

function buildSystemPrompt(taxonomy: Taxonomy): string {
  return `You are tagging garden-flag product images for a decor retailer.

TASK: Look at the image and pick the FL Themes taxonomy entries that describe what's visually in the design. Be generous — pick every theme that clearly applies, but do not invent themes that aren't visually supported by the image.

RULES:
1. You may ONLY return theme names that exist verbatim in the taxonomy below.
2. Format is strict:
   - "theme_names": top-level only (e.g. "Birds", "Patriotic", "Flowers")
   - "sub_themes":  "Name: Sub Theme" format (e.g. "Birds: Cardinals")
   - "sub_sub_themes": "Name: Sub Theme: Sub Sub Theme" (e.g. "Flowers: Spring Flowers: Hydrangeas")
3. If a sub-theme applies, also include its parent theme_name. If a sub-sub applies, include parent theme_name AND parent sub_theme.
4. If nothing fits, return empty arrays — do NOT force a match.
5. Ignore product attributes like "garden", "house", "banner", "reversible", "glitter" — those aren't in this taxonomy. We only care about what the design depicts.
6. For holiday/seasonal designs, tag the holiday/season from the Seasonal theme tree (e.g. "Seasonal: Christmas", "Seasonal: Halloween", "Seasonal: St Patricks Day") if that subtree exists in the taxonomy below.
7. Monogrammed letters: only tag "Monogrammed: Letter X" if a literal letter is a primary visual element, not just present as text.

Return JSON ONLY, in exactly this shape, no surrounding prose, no markdown fences:
{"theme_names":[],"sub_themes":[],"sub_sub_themes":[],"confidence":"high|medium|low","notes":"optional one-line"}

═══════════════════════════════════════════════════════════
TAXONOMY (every value you return must match one of these):
═══════════════════════════════════════════════════════════
${taxonomy.promptText}`;
}

function validateResponse(
  raw: string,
  taxonomy: Taxonomy,
): { ok: true; value: VisionResponse } | { ok: false; error: string } {
  // Strip markdown fences if Claude added them anyway.
  let txt = raw.trim();
  if (txt.startsWith("```")) {
    txt = txt.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
  }
  // Extract the first balanced {...} block (Claude sometimes appends prose or
  // a second JSON object; we want the first complete one).
  const jsonBlock = extractFirstJsonObject(txt);
  if (!jsonBlock) {
    return { ok: false, error: `no JSON object in response: ${raw.slice(0, 200)}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonBlock);
  } catch (e) {
    return { ok: false, error: `invalid JSON: ${(e as Error).message}` };
  }

  const obj = parsed as Record<string, unknown>;
  const themes = asStringArray(obj.theme_names);
  const subs = asStringArray(obj.sub_themes);
  const subSubs = asStringArray(obj.sub_sub_themes);
  const confidence = obj.confidence;
  if (confidence !== "high" && confidence !== "medium" && confidence !== "low") {
    return { ok: false, error: `confidence must be high|medium|low, got ${String(confidence)}` };
  }

  // Drop invalid entries (don't fail the whole design — log and continue).
  const validThemes = themes.filter((t) => taxonomy.validTheme.has(t));
  const validSubs = subs.filter((s) => taxonomy.validSub.has(s));
  const validSubSubs = subSubs.filter((s) => taxonomy.validSubSub.has(s));

  return {
    ok: true,
    value: {
      theme_names: sortUnique(validThemes),
      sub_themes: sortUnique(validSubs),
      sub_sub_themes: sortUnique(validSubSubs),
      confidence,
      notes: typeof obj.notes === "string" ? obj.notes : undefined,
    },
  };
}

function extractFirstJsonObject(s: string): string | null {
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (c === "\\") escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}
function sortUnique(a: string[]): string[] {
  return Array.from(new Set(a)).sort();
}

// ──────────────────────────────────────────────────────────────────────────────

async function fetchDesigns(args: Args): Promise<DesignRow[]> {
  const sb = getAdminClient();

  if (args.only) {
    const { data, error } = await sb
      .from("designs")
      .select("design_family,design_name,image_url,classification,shopify_tags,vision_theme_names")
      .in("design_family", args.only);
    if (error) throw new Error(error.message);
    return (data || []) as DesignRow[];
  }

  if (args.stratified) {
    const bands = ["hit", "solid", "ok", "weak", "dead"];
    const perBand = Math.max(1, Math.ceil(args.stratified / bands.length));
    const out: DesignRow[] = [];
    for (const band of bands) {
      let q = sb
        .from("designs")
        .select("design_family,design_name,image_url,classification,shopify_tags,vision_theme_names")
        .eq("classification", band)
        .not("image_url", "is", null)
        .limit(perBand);
      if (!args.force) q = q.is("vision_theme_names", null);
      const { data, error } = await q;
      if (error) throw new Error(`${band}: ${error.message}`);
      out.push(...((data || []) as DesignRow[]));
    }
    return out.slice(0, args.stratified);
  }

  // Default / --limit path.
  const out: DesignRow[] = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    let q = sb
      .from("designs")
      .select("design_family,design_name,image_url,classification,shopify_tags,vision_theme_names")
      .not("image_url", "is", null)
      .order("design_family", { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (!args.force) q = q.is("vision_theme_names", null);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    const rows = (data || []) as DesignRow[];
    out.push(...rows);
    if (rows.length < pageSize) break;
    if (args.limit && out.length >= args.limit) break;
  }
  return args.limit ? out.slice(0, args.limit) : out;
}

// ──────────────────────────────────────────────────────────────────────────────

async function tagOne(
  client: Anthropic,
  systemPrompt: string,
  taxonomy: Taxonomy,
  d: DesignRow,
): Promise<
  | { ok: true; value: VisionResponse; usage: Anthropic.Usage }
  | { ok: false; error: string }
> {
  if (!d.image_url) return { ok: false, error: "no image_url" };

  try {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: [
        {
          type: "text",
          text: systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "url", url: d.image_url },
            },
            {
              type: "text",
              text: `Tag this ${d.design_family} garden flag. Return JSON only.`,
            },
          ],
        },
      ],
    });

    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    const v = validateResponse(text, taxonomy);
    if (!v.ok) return { ok: false, error: v.error };
    return { ok: true, value: v.value, usage: resp.usage };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ──────────────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "Missing ANTHROPIC_API_KEY. Add it to .env.local (get a key at https://console.anthropic.com).",
    );
  }

  console.log(`Loading taxonomy: ${resolve(TAXONOMY_CSV)}`);
  const taxonomy = await loadTaxonomy(TAXONOMY_CSV);
  console.log(
    `  ${taxonomy.validTheme.size} themes, ${taxonomy.validSub.size} sub-themes, ${taxonomy.validSubSub.size} sub-sub-themes`,
  );

  const systemPrompt = buildSystemPrompt(taxonomy);
  if (args.dryRun) {
    console.log("\n──── DRY RUN: system prompt ────");
    console.log(systemPrompt);
    console.log(
      "\n──── Done ────\nRe-run without --dry-run once the migration SQL has been applied and ANTHROPIC_API_KEY is set.",
    );
    return;
  }

  const designs = await fetchDesigns(args);
  console.log(`\nTagging ${designs.length} designs with ${MODEL}`);
  if (args.force) console.log("  (--force: overwriting existing vision tags)");

  // maxRetries lets the SDK back off on 429s automatically — important
  // because Haiku has a 50 req/min cap and we can easily burst past it.
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    maxRetries: 6,
  });
  const sb = getAdminClient();

  let completed = 0;
  let failed = 0;
  let totalIn = 0;
  let totalOut = 0;
  let totalCacheRead = 0;
  let totalCacheCreate = 0;
  const startedAt = Date.now();

  async function worker(queue: DesignRow[]) {
    while (queue.length > 0) {
      const d = queue.shift();
      if (!d) return;
      const r = await tagOne(client, systemPrompt, taxonomy, d);
      if (!r.ok) {
        failed++;
        console.log(`  ✗ ${d.design_family}: ${r.error}`);
        continue;
      }
      completed++;
      totalIn += r.usage.input_tokens;
      totalOut += r.usage.output_tokens;
      totalCacheRead += r.usage.cache_read_input_tokens || 0;
      totalCacheCreate += r.usage.cache_creation_input_tokens || 0;

      const { error } = await sb
        .from("designs")
        .update({
          vision_theme_names: r.value.theme_names,
          vision_sub_themes: r.value.sub_themes,
          vision_sub_sub_themes: r.value.sub_sub_themes,
          vision_tagged_at: new Date().toISOString(),
          vision_model: MODEL,
          vision_raw: r.value,
        })
        .eq("design_family", d.design_family);
      if (error) {
        failed++;
        completed--;
        console.log(`  ✗ ${d.design_family}: supabase update: ${error.message}`);
        continue;
      }

      const n = r.value.theme_names.length + r.value.sub_themes.length + r.value.sub_sub_themes.length;
      const preview =
        r.value.sub_themes.slice(0, 3).join(", ") ||
        r.value.theme_names.slice(0, 3).join(", ") ||
        "(no tags)";
      console.log(
        `  ✓ ${d.design_family.padEnd(10)} [${r.value.confidence}] ${n} tags · ${preview}`,
      );
    }
  }

  const queue = [...designs];
  const workers = Array.from({ length: Math.max(1, args.concurrency) }, () => worker(queue));
  await Promise.all(workers);

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log("\n──── Summary ────");
  console.log(`  completed: ${completed}`);
  console.log(`  failed:    ${failed}`);
  console.log(`  elapsed:   ${elapsed}s`);
  console.log(`  tokens:    in=${totalIn}  out=${totalOut}  cache_read=${totalCacheRead}  cache_create=${totalCacheCreate}`);

  // Rough cost estimate for Sonnet 4.6 pricing (as of this write).
  // If pricing shifts, adjust here — this is only a rough indicator.
  const costIn = (totalIn / 1_000_000) * 3.0;
  const costOut = (totalOut / 1_000_000) * 15.0;
  const costCacheRead = (totalCacheRead / 1_000_000) * 0.3;
  const costCacheCreate = (totalCacheCreate / 1_000_000) * 3.75;
  console.log(`  approx $:  ${(costIn + costOut + costCacheRead + costCacheCreate).toFixed(4)}`);

  console.log("\nNext: npx tsx scripts/vision-diff.ts   # export CSV comparing Shopify vs vision tags");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
