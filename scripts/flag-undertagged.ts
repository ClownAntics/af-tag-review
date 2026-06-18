/**
 * Flag designs that are under-tagged — "one tag or less".
 *
 * Two notions of "tag":
 *   total   = approved_tags.length
 *   content = approved_tags minus the 13 feature/material facets
 *             (Double-Sided, Printed-In-USA, Eco-Friendly, Suede-Reflections,
 *              Reversible, PremierSoft, GlitterTrends, Printed, Applique,
 *              Burlap, Lustre, Linen, Moire) — i.e. real theme tags only.
 *
 * A design with only "Double-Sided" has 1 total tag but 0 content tags, so
 * the content notion is what actually catches "no real theme" designs.
 *
 * Dry-run reports both. --apply flags by the chosen notion (default: content)
 * for the chosen statuses (default: updated,readytosend,pending — never
 * touches excluded or already-flagged/novision).
 *
 * Usage:
 *   npx tsx scripts/flag-undertagged.ts                       # dry-run, both notions
 *   npx tsx scripts/flag-undertagged.ts --apply               # flag by content ≤1
 *   npx tsx scripts/flag-undertagged.ts --apply --notion=total
 *   npx tsx scripts/flag-undertagged.ts --apply --statuses=updated,readytosend
 */
import { getAdminClient } from "./_supabase-admin";

const FACETS = new Set([
  "Double-Sided", "Printed-In-USA", "Eco-Friendly", "Suede-Reflections",
  "Reversible", "PremierSoft", "GlitterTrends",
  "Printed", "Applique", "Burlap", "Lustre", "Linen", "Moire",
]);

interface Row {
  design_family: string;
  status: string;
  approved_tags: string[] | null;
}

const arg = (k: string) =>
  process.argv.slice(2).find((a) => a.startsWith(`--${k}=`))?.split("=")[1];

async function main() {
  const apply = process.argv.slice(2).includes("--apply");
  const notion = (arg("notion") ?? "content") as "content" | "total";
  const statuses = (arg("statuses") ?? "updated,readytosend,pending").split(",");

  const sb = getAdminClient();
  const rows: Row[] = [];
  const PAGE = 1000;
  for (let o = 0; ; o += PAGE) {
    const { data, error } = await sb
      .from("designs")
      .select("design_family,status,approved_tags")
      .neq("status", "excluded")
      .range(o, o + PAGE - 1);
    if (error) throw error;
    const b = (data ?? []) as Row[];
    rows.push(...b);
    if (b.length < PAGE) break;
  }

  const total = (r: Row) => (r.approved_tags ?? []).length;
  const content = (r: Row) => (r.approved_tags ?? []).filter((t) => !FACETS.has(t)).length;

  // Report both notions, broken down by status, for the candidate statuses.
  const inScope = (r: Row) => statuses.includes(r.status);
  const report = (label: string, fn: (r: Row) => number) => {
    const hits = rows.filter((r) => inScope(r) && fn(r) <= 1);
    const byStatus = new Map<string, number>();
    for (const r of hits) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
    const zero = hits.filter((r) => fn(r) === 0).length;
    console.log(`\n${label} ≤1  →  ${hits.length} designs  (of which ${zero} have 0)`);
    for (const [s, n] of [...byStatus.entries()].sort()) console.log(`    ${s.padEnd(13)} ${n}`);
    return hits;
  };

  console.log(`Scope statuses: ${statuses.join(", ")}  (excluded + novision + flagged never touched)`);
  console.log(`Non-excluded designs scanned: ${rows.length}`);
  report("TOTAL tags (counts facets)", total);
  const contentHits = report("CONTENT tags (excludes 13 facets)", content);

  const fn = notion === "total" ? total : content;
  const targets = rows.filter((r) => inScope(r) && fn(r) <= 1);

  if (!apply) {
    console.log(`\nDRY-RUN. Chosen notion: ${notion} → would flag ${targets.length}.`);
    console.log("Add --apply to flag. Override with --notion=total / --statuses=…");
    return;
  }

  console.log(`\nApplying: flagging ${targets.length} designs (notion=${notion})…`);
  let done = 0;
  for (let i = 0; i < targets.length; i += 200) {
    const slice = targets.slice(i, i + 200).map((t) => t.design_family);
    const { error } = await sb
      .from("designs")
      .update({ status: "flagged" })
      .in("design_family", slice);
    if (error) throw new Error(`batch at ${i}: ${error.message}`);
    done += slice.length;
    console.log(`  flagged ${done}/${targets.length}`);
  }
  // Audit trail
  for (const t of targets)
    await sb.from("events").insert({
      design_family: t.design_family,
      event_type: "flagged",
      actor: "blake",
      payload: { reason: `undertagged_${notion}`, tag_count: fn(t) },
    });
  console.log(`\nDone. Flagged ${done} designs.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
