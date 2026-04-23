/**
 * One-off admin reset: move every design currently in `readytosend` back to
 * `novision`. Used to flush the queue before re-testing the fast-path
 * "Mark as fine" flow from a clean slate.
 *
 * Usage:
 *   npx tsx scripts/reset-readytosend.ts          # dry-run, just prints the count
 *   npx tsx scripts/reset-readytosend.ts --apply  # actually writes the change
 *
 * What it does on --apply:
 *   - UPDATE designs SET status='novision', approved_tags=NULL, last_reviewed_at=NULL
 *     WHERE status='readytosend'
 *   - Inserts one `reset_batch` event per family for the audit log
 *
 * It leaves `shopify_tags`, derived theme columns, and vision_tags alone.
 * Re-marking fine will rebuild approved_tags + themes from the current
 * shopify_tags anyway.
 */
import { getAdminClient } from "./_supabase-admin";

interface Args {
  apply: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const out: Args = { apply: false };
  for (const a of argv) {
    if (a === "--apply") out.apply = true;
    else throw new Error(`unknown arg: ${a}`);
  }
  return out;
}

async function main() {
  const args = parseArgs();
  const sb = getAdminClient();

  // Supabase REST caps a single `select` at 1000 rows — paginate so we get
  // every family for the audit trail. The `count` comes back the same on
  // each page, so we only need to read it once.
  const families: string[] = [];
  let total = 0;
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const { data, error, count } = await sb
      .from("designs")
      .select("design_family", { count: "exact" })
      .eq("status", "readytosend")
      .order("design_family")
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(error.message);
    if (offset === 0 && typeof count === "number") total = count;
    const chunk = (data ?? []).map((r) => (r as { design_family: string }).design_family);
    families.push(...chunk);
    if (chunk.length < PAGE) break;
  }
  console.log(`[reset] ${total || families.length} designs currently in readytosend.`);
  if (families.length === 0) {
    console.log("[reset] nothing to do.");
    return;
  }

  if (!args.apply) {
    console.log("[reset] DRY-RUN. Re-run with --apply to perform the reset.");
    console.log(`  first 10: ${families.slice(0, 10).join(", ")}`);
    return;
  }

  const { error: updErr } = await sb
    .from("designs")
    .update({
      status: "novision",
      approved_tags: null,
      last_reviewed_at: null,
    })
    .eq("status", "readytosend");
  if (updErr) throw new Error(`update: ${updErr.message}`);
  console.log(`[reset] moved ${families.length} designs readytosend → novision.`);

  const eventRows = families.map((f) => ({
    design_family: f,
    event_type: "reset_batch",
    actor: "blake",
    payload: { from_status: "readytosend", reason: "manual bulk reset" },
  }));
  for (let i = 0; i < eventRows.length; i += 500) {
    const batch = eventRows.slice(i, i + 500);
    const { error: evtErr } = await sb.from("events").insert(batch);
    if (evtErr) {
      console.warn(`[reset] event insert batch ${i} warning: ${evtErr.message}`);
    }
  }
  console.log(`[reset] wrote ${eventRows.length} audit events.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
