/**
 * One-off: canonicalize non-canonical entries in `designs.approved_tags`
 * against the FL Themes taxonomy.
 *
 * Strategy:
 *   1. For every non-excluded design, scan `approved_tags`.
 *   2. Each entry that isn't an exact-case Search Term gets canonicalized via
 *      a case-insensitive / spaces-vs-hyphens / label-form lookup. (Same
 *      logic the Tag filter dropdown uses.)
 *   3. If EVERY non-canonical entry resolves to a canonical Search Term →
 *      auto-fix in place: update `approved_tags` to the canonicalized + sorted
 *      + deduped list, recompute `theme_names`/`sub_themes`/`sub_sub_themes`,
 *      write a `tags_canonicalized` audit event. Status stays unchanged
 *      (typically `updated` — Shopify already has the lowercased form,
 *      so no re-push needed).
 *   4. If ANY entry can't be canonicalized (truly off-taxonomy like
 *      `Sale Product`, `MLB`) → drop the unfixable ones, keep the rest
 *      canonicalized, **flag** the design for re-review. Approved_tags is
 *      cleared like a normal `flag` action so the reviewer starts fresh in
 *      vision, but the original tags + unfixable list are captured in the
 *      audit payload so nothing is lost.
 *
 * Usage:
 *   npx tsx scripts/canonicalize-approved-tags.ts          # dry-run
 *   npx tsx scripts/canonicalize-approved-tags.ts --apply  # commit
 */
import { getAdminClient } from "./_supabase-admin";
import { getTaxonomy } from "../lib/taxonomy-source";
import { mapTagsToThemes } from "../lib/vision";

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
  const { entries } = await getTaxonomy();

  const canonicalSet = new Set<string>();
  const canonicalByLower = new Map<string, string>();
  const norm = (s: string) => s.toLowerCase();
  const normSpaced = (s: string) => s.toLowerCase().replace(/-/g, " ");
  const normHyphenated = (s: string) => s.toLowerCase().replace(/\s+/g, "-");
  for (const e of entries) {
    if (!e.term) continue;
    canonicalSet.add(e.term);
    canonicalByLower.set(norm(e.term), e.term);
    canonicalByLower.set(normSpaced(e.term), e.term);
    canonicalByLower.set(normHyphenated(e.term), e.term);
    if (e.label) {
      canonicalByLower.set(norm(e.label), e.term);
      const leaf = e.label.split(":").pop()?.trim();
      if (leaf) {
        canonicalByLower.set(norm(leaf), e.term);
        canonicalByLower.set(normHyphenated(leaf), e.term);
      }
    }
  }

  console.log("[canonicalize] loading non-excluded designs…");
  type Row = {
    design_family: string;
    status: string;
    approved_tags: string[] | null;
  };
  const rows: Row[] = [];
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await sb
      .from("designs")
      .select("design_family,status,approved_tags")
      .neq("status", "excluded")
      .order("design_family")
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`select: ${error.message}`);
    const batch = (data ?? []) as Row[];
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }
  console.log(`[canonicalize] ${rows.length} non-excluded designs loaded.`);

  // Classify each affected design as auto-fixable or needs-flag.
  type AutoFix = {
    family: string;
    status: string;
    before: string[];
    after: string[];
    mapping: Record<string, string>;
  };
  type NeedsFlag = {
    family: string;
    status: string;
    before: string[];
    unfixable: string[];
    fixableMapping: Record<string, string>;
  };
  const autoFix: AutoFix[] = [];
  const needsFlag: NeedsFlag[] = [];

  for (const r of rows) {
    const before = r.approved_tags ?? [];
    if (before.length === 0) continue;
    const bad = before.filter((t) => !canonicalSet.has(t));
    if (bad.length === 0) continue;
    const mapping: Record<string, string> = {};
    const unfixable: string[] = [];
    for (const t of bad) {
      const c = canonicalByLower.get(t.toLowerCase());
      if (c) mapping[t] = c;
      else unfixable.push(t);
    }
    if (unfixable.length === 0) {
      // Build canonical replacement: replace each tag through mapping,
      // dedupe, sort.
      const after = Array.from(
        new Set(before.map((t) => mapping[t] ?? t)),
      ).sort();
      autoFix.push({
        family: r.design_family,
        status: r.status,
        before,
        after,
        mapping,
      });
    } else {
      needsFlag.push({
        family: r.design_family,
        status: r.status,
        before,
        unfixable,
        fixableMapping: mapping,
      });
    }
  }

  console.log(`\n[canonicalize] Plan:`);
  console.log(`  Auto-fix (case/format only):   ${autoFix.length}`);
  console.log(`  Flag for re-review (junk tags): ${needsFlag.length}`);

  if (autoFix.length > 0) {
    console.log(`\nSample auto-fixes:`);
    for (const f of autoFix.slice(0, 5)) {
      console.log(
        `  ${f.family}: ${Object.entries(f.mapping).map(([k, v]) => `${k}→${v}`).join(", ")}`,
      );
    }
  }
  if (needsFlag.length > 0) {
    console.log(`\nDesigns that will be flagged:`);
    for (const f of needsFlag) {
      console.log(
        `  ${f.family.padEnd(20)} [${f.status}] unfixable=[${f.unfixable.join(", ")}]`,
      );
    }
  }

  if (!args.apply) {
    console.log(`\n[canonicalize] DRY-RUN. Re-run with --apply to commit.`);
    return;
  }

  console.log(`\n[canonicalize] applying…`);

  // 1. Auto-fix loop. UPDATE approved_tags + theme columns, INSERT event.
  let fixedDone = 0;
  for (const f of autoFix) {
    const themes = await mapTagsToThemes(f.after);
    const { error: updErr } = await sb
      .from("designs")
      .update({
        approved_tags: f.after,
        theme_names: themes.theme_names,
        sub_themes: themes.sub_themes,
        sub_sub_themes: themes.sub_sub_themes,
      })
      .eq("design_family", f.family);
    if (updErr) {
      console.warn(`  ${f.family}: update failed — ${updErr.message}`);
      continue;
    }
    await sb.from("events").insert({
      design_family: f.family,
      event_type: "tags_canonicalized",
      actor: "system",
      payload: {
        before: f.before,
        after: f.after,
        mapping: f.mapping,
      },
    });
    fixedDone++;
    if (fixedDone % 250 === 0)
      console.log(`  canonicalized ${fixedDone}/${autoFix.length}`);
  }
  console.log(`[canonicalize] canonicalized ${fixedDone}/${autoFix.length}`);

  // 2. Flag the junk-tag designs. Clear approved_tags (mirrors the
  //    standard `flag` action), set status='flagged', write audit event
  //    capturing the original tags + the unfixable ones.
  let flagDone = 0;
  for (const f of needsFlag) {
    const themes = await mapTagsToThemes([]);
    const { error: updErr } = await sb
      .from("designs")
      .update({
        approved_tags: [],
        theme_names: themes.theme_names,
        sub_themes: themes.sub_themes,
        sub_sub_themes: themes.sub_sub_themes,
        status: "flagged",
      })
      .eq("design_family", f.family);
    if (updErr) {
      console.warn(`  ${f.family}: flag failed — ${updErr.message}`);
      continue;
    }
    await sb.from("events").insert({
      design_family: f.family,
      event_type: "flagged",
      actor: "system",
      payload: {
        reason: "non_canonical_tags",
        from_status: f.status,
        prior_approved_tags: f.before,
        unfixable_tags: f.unfixable,
        fixable_mapping: f.fixableMapping,
      },
    });
    flagDone++;
  }
  console.log(`[canonicalize] flagged ${flagDone}/${needsFlag.length}`);

  console.log(
    `\n[canonicalize] done. ${fixedDone} canonicalized + ${flagDone} flagged.`,
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
