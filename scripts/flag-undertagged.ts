/**
 * Flag designs that are under-tagged — "one tag or less".
 *
 * Thin CLI wrapper over lib/flag-undertagged.ts (the same rule the nightly
 * cron runs). "Content" notion (default) excludes the 13 feature/material
 * facets so facet-only designs with no real theme are caught; "total" counts
 * everything. Scope defaults to updated/readytosend/pending; excluded,
 * novision, and already-flagged are never touched.
 *
 * Usage:
 *   npx tsx scripts/flag-undertagged.ts                       # dry-run, both notions
 *   npx tsx scripts/flag-undertagged.ts --apply               # flag by content ≤1
 *   npx tsx scripts/flag-undertagged.ts --apply --notion=total
 *   npx tsx scripts/flag-undertagged.ts --apply --statuses=updated,readytosend
 */
import { getAdminClient } from "./_supabase-admin";
import {
  flagUndertagged,
  DEFAULT_STATUSES,
  type Notion,
} from "../lib/flag-undertagged";

const arg = (k: string) =>
  process.argv.slice(2).find((a) => a.startsWith(`--${k}=`))?.split("=")[1];

async function main() {
  const apply = process.argv.slice(2).includes("--apply");
  const notion = (arg("notion") ?? "content") as Notion;
  const statuses = arg("statuses")?.split(",") ?? DEFAULT_STATUSES;

  const sb = getAdminClient();
  const res = await flagUndertagged(sb, { notion, statuses, apply, actor: "blake" });

  console.log(`Scope statuses: ${statuses.join(", ")}  (excluded + novision + flagged never touched)`);
  console.log(`Non-excluded designs scanned: ${res.scanned}`);
  console.log(`\nTOTAL tags (counts facets) ≤1   → ${res.totalNotionCount}`);
  console.log(`CONTENT tags (excludes facets) ≤1 → ${res.contentNotionCount}`);
  console.log(`\nChosen notion: ${notion} → ${res.candidates} designs`);
  for (const [s, n] of Object.entries(res.byStatus).sort())
    console.log(`    ${s.padEnd(13)} ${n}`);

  if (!apply) {
    console.log("\nDRY-RUN. Add --apply to flag. Override with --notion=total / --statuses=…");
    return;
  }
  console.log(`\nDone. Flagged ${res.flagged} designs.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
