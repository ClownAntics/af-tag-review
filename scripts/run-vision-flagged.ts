/**
 * Run Claude vision on FLAGGED designs and move them to `pending` — the exact
 * same pipeline as the app's "Run vision" button (POST /api/review/vision/run),
 * but from the CLI with NO 5-minute Vercel timeout. Use this for bulk runs
 * (hundreds of flagged designs); the in-app button is fine for a handful.
 *
 * Per design: fetch the current vision prompt (Supabase vision_prompts, same
 * as the route), call lib/vision.tagOne on the product image, dedupe the
 * suggestions against existing approved_tags, write vision_tags/vision_raw,
 * flip status flagged → pending, and log a vision_completed / vision_failed
 * event. Idempotent-ish: only touches designs that are still `flagged`.
 *
 * Usage:
 *   npx tsx scripts/run-vision-flagged.ts                 # dry-run: counts only
 *   npx tsx scripts/run-vision-flagged.ts --apply         # run vision on ALL flagged
 *   npx tsx scripts/run-vision-flagged.ts --apply --limit 20
 *   npx tsx scripts/run-vision-flagged.ts --apply --only AFSP0001,AFWR0006
 *   npx tsx scripts/run-vision-flagged.ts --apply --concurrency 3   # default 3 (Haiku/Sonnet rate limits)
 *
 * Env: ANTHROPIC_API_KEY in .env.local.
 */
import Anthropic from "@anthropic-ai/sdk";
import { getAdminClient } from "./_supabase-admin";
import { buildSystemPrompt, tagOne, VISION_MODEL } from "../lib/vision";
import { primaryImageUrl } from "../lib/product-image";

interface Args { apply: boolean; limit: number | null; only: string[] | null; concurrency: number }
function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const a: Args = { apply: false, limit: null, only: null, concurrency: 3 };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--apply") a.apply = true;
    else if (t === "--limit") a.limit = Number(argv[++i]);
    else if (t === "--only") a.only = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (t === "--concurrency") a.concurrency = Number(argv[++i]);
    else throw new Error(`unknown arg: ${t}`);
  }
  return a;
}

async function main() {
  const args = parseArgs();
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("Missing ANTHROPIC_API_KEY");
  const sb = getAdminClient();

  // Target set: flagged designs (optionally narrowed).
  let q = sb
    .from("designs")
    .select("design_family,approved_tags,image_url,variant_skus")
    .eq("status", "flagged")
    .order("design_family");
  if (args.only) q = q.in("design_family", args.only);
  if (args.limit) q = q.limit(args.limit);
  const { data, error } = await q;
  if (error) throw error;
  const designs = (data ?? []) as {
    design_family: string; approved_tags: string[] | null; image_url: string | null; variant_skus: string[] | null;
  }[];

  console.log(`flagged designs to vision: ${designs.length} (concurrency ${args.concurrency})`);
  if (!args.apply) { console.log("DRY-RUN. Re-run with --apply to run vision + move to pending."); return; }
  if (designs.length === 0) return;

  // Same prompt source as the route: current saved prompt, else default.
  let promptTemplate: string | undefined;
  try {
    const { data: p } = await sb.from("vision_prompts").select("prompt").eq("is_current", true).single();
    if (p) promptTemplate = (p as { prompt: string }).prompt;
  } catch { /* default */ }
  const systemPrompt = await buildSystemPrompt(promptTemplate);

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 6 });
  const queue = designs.slice();
  let completed = 0, failed = 0, processed = 0;
  const total = designs.length;

  const worker = async () => {
    for (;;) {
      const d = queue.shift();
      if (!d) return;
      const family = d.design_family;
      const result = await tagOne(client, {
        designFamily: family,
        imageUrl: primaryImageUrl({ design_family: family, image_url: d.image_url, variant_skus: d.variant_skus }),
        systemPrompt,
      });
      processed++;
      if (!result.ok) {
        failed++;
        await sb.from("events").insert({ design_family: family, event_type: "vision_failed", actor: "system", payload: { error: result.error } });
        console.log(`  ✗ ${family}: ${result.error}  [${processed}/${total}]`);
        continue;
      }
      const approvedSet = new Set(d.approved_tags ?? []);
      const dedupedVisionTags = result.value.tags.filter((t) => !approvedSet.has(t));
      // Guard against races/manual edits: only advance rows still `flagged`.
      const { error: upErr, data: upData } = await sb
        .from("designs")
        .update({
          vision_tags: dedupedVisionTags,
          vision_model: VISION_MODEL,
          vision_tagged_at: new Date().toISOString(),
          vision_raw: result.value,
          status: "pending",
        })
        .eq("design_family", family)
        .eq("status", "flagged")
        .select("design_family");
      if (upErr) { failed++; console.log(`  ✗ ${family}: ${upErr.message}  [${processed}/${total}]`); continue; }
      if (!upData?.length) { console.log(`  – ${family}: no longer flagged, skipped  [${processed}/${total}]`); continue; }
      await sb.from("events").insert({
        design_family: family, event_type: "vision_completed", actor: "system",
        payload: { suggestion_count: result.value.tags.length, primary: result.value.primary, reasoning: result.value.reasoning, source: "run-vision-flagged" },
      });
      completed++;
      if (completed % 25 === 0 || processed === total) console.log(`  … ${processed}/${total} (ok ${completed}, failed ${failed})`);
    }
  };

  await Promise.all(Array.from({ length: Math.min(args.concurrency, designs.length) }, () => worker()));
  console.log(`\nDone. ${completed} → pending, ${failed} failed, of ${total}.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
