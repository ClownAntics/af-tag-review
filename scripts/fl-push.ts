/**
 * Push curated tags to the FL (Flagsrus) Shopify store, matched by SKU.
 * No time limit — use this for the first full backfill. Logic: lib/fl-push.ts.
 *
 * Usage:
 *   npx tsx scripts/fl-push.ts                  # dry run → fl_push_diff.csv
 *   npx tsx scripts/fl-push.ts --max 10         # dry run, first 10 changes
 *   npx tsx scripts/fl-push.ts --apply --max 10 # push 10 products (smoke test)
 *   npx tsx scripts/fl-push.ts --apply          # push everything that differs
 *
 * Needs SHOPIFY_FL_STORE + SHOPIFY_FL_ADMIN_TOKEN in .env.local.
 */
import { writeFileSync } from "node:fs";
import { getAdminClient } from "./_supabase-admin";
import { runFlPush } from "../lib/fl-push";

function parseArgs() {
  const argv = process.argv.slice(2);
  const out: { apply: boolean; max?: number } = { apply: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--max") out.max = Number(argv[++i]);
    else throw new Error(`unknown arg: ${a}`);
  }
  return out;
}

const csvCell = (s: string) => `"${s.replace(/"/g, '""')}"`;

async function main() {
  const args = parseArgs();
  const sb = getAdminClient();
  const rows: string[] = ["family,product_id,title,added,removed,pushed"];

  for await (const ev of runFlPush(sb, { apply: args.apply, maxChanges: args.max })) {
    if (ev.type === "start") {
      console.log(`[fl-push] ${ev.designs} designs, ${ev.skus} SKUs · ${ev.apply ? "APPLY" : "dry run"}`);
    } else if (ev.type === "progress") {
      console.log(`[fl-push] scanned ${ev.scanned} · matched ${ev.matched} · changed ${ev.changed} · pushed ${ev.pushed}`);
    } else if (ev.type === "change") {
      rows.push(
        [ev.family, String(ev.product_id), csvCell(ev.title), csvCell(ev.added.join(", ")), csvCell(ev.removed.join(", ")), String(ev.pushed)].join(","),
      );
    } else if (ev.type === "error") {
      console.error(`[fl-push] ✗ ${ev.family} ${ev.product_id}: ${ev.error}`);
    } else if (ev.type === "done") {
      console.log(`[fl-push] done:`, ev);
    }
  }

  writeFileSync("fl_push_diff.csv", rows.join("\n"));
  console.log(`[fl-push] wrote fl_push_diff.csv (${rows.length - 1} rows)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
