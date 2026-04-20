/**
 * Bake the FL Themes CSV into lib/taxonomy.json so the Next.js app — including
 * the Vercel-deployed build — has access to the controlled vocabulary without
 * a dependency on the user's Dropbox path.
 *
 * Re-run whenever you re-export FL Themes from TeamDesk.
 *
 * Output entries:
 *   {
 *     term:   "Cardinals",                   // Search Term (canonical tag value)
 *     name:   "Birds",                       // top-level Name
 *     sub:    "Cardinals" | null,
 *     subSub: null,
 *     level:  1 | 2 | 3,
 *     label:  "Birds: Cardinals"             // display path for dropdowns
 *   }
 */
import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "csv-parse";

const CSV =
  "C:/Users/gbcab/ClownAntics Dropbox/Blake Cabot/Docs/Internet Business/200904 Clown/202604 AF Research App/FL Themes_zz Export View.csv";
const OUT = resolve("./lib/taxonomy.json");

const EXCLUDED_TOP_LEVELS = new Set(["Business", "Features", "Size"]);

interface Entry {
  term: string;
  name: string;
  sub: string | null;
  subSub: string | null;
  level: 1 | 2 | 3;
  label: string;
  conflicts?: string[]; // Search Terms this one conflicts with (resolved + symmetric)
}

// Raw row we retain for the second pass that resolves the ConflictsWith column.
interface RawRow {
  term: string;
  isSeason: boolean;
  isHoliday: boolean;
  conflictsWithRaw: string;
}

function boolish(s: string | undefined): boolean {
  return (s || "").trim().toLowerCase() === "true";
}

async function main() {
  console.log(`Reading: ${resolve(CSV)}`);
  const entries: Entry[] = [];
  const raws: RawRow[] = [];
  const seen = new Set<string>();

  const parser = createReadStream(CSV).pipe(
    parse({ columns: true, bom: true, skip_empty_lines: true, trim: true }),
  );

  for await (const r of parser as AsyncIterable<Record<string, string>>) {
    const term = (r["Search Term"] || "").trim();
    const name = (r["Name"] || "").trim();
    if (!term || !name || EXCLUDED_TOP_LEVELS.has(name)) continue;
    const sub = (r["Sub Theme"] || "").trim() || null;
    const subSub = (r["Sub Sub Theme"] || "").trim() || null;
    const level = Math.round(Number(r["Level"] || "0"));
    if (level !== 1 && level !== 2 && level !== 3) continue;

    if (seen.has(term)) continue;
    seen.add(term);

    const label =
      level === 3 && sub && subSub
        ? `${name}: ${sub}: ${subSub}`
        : level === 2 && sub
          ? `${name}: ${sub}`
          : name;

    entries.push({ term, name, sub, subSub, level: level as 1 | 2 | 3, label });
    raws.push({
      term,
      isSeason: boolish(r["isSeason?"]),
      isHoliday: boolish(r["IsHoliday?"]),
      conflictsWithRaw: (r["ConflictsWith"] || "").trim(),
    });
  }

  // Second pass: resolve ConflictsWith into Search Term arrays, expanding the
  // "All Seasons" / "All Holidays" meta-tokens via the row-level flags.
  const allSeasons = raws.filter((r) => r.isSeason).map((r) => r.term);
  const allHolidays = raws.filter((r) => r.isHoliday).map((r) => r.term);
  const validTerms = new Set(entries.map((e) => e.term));

  const conflictsByTerm = new Map<string, Set<string>>();
  const ensure = (term: string) => {
    let s = conflictsByTerm.get(term);
    if (!s) {
      s = new Set<string>();
      conflictsByTerm.set(term, s);
    }
    return s;
  };

  for (const r of raws) {
    if (!r.conflictsWithRaw) continue;
    const tokens = r.conflictsWithRaw.split(",").map((t) => t.trim()).filter(Boolean);
    for (const tok of tokens) {
      if (tok === "All Seasons") {
        for (const other of allSeasons) if (other !== r.term) ensure(r.term).add(other);
      } else if (tok === "All Holidays") {
        for (const other of allHolidays) if (other !== r.term) ensure(r.term).add(other);
      } else if (validTerms.has(tok)) {
        ensure(r.term).add(tok);
      } else {
        // Unknown reference — surface it so the CSV can be fixed.
        console.warn(`  ! ${r.term}: unknown ConflictsWith target "${tok}"`);
      }
    }
  }

  // Make conflicts symmetric: if A conflicts with B, B conflicts with A.
  for (const [a, bs] of Array.from(conflictsByTerm.entries())) {
    for (const b of bs) ensure(b).add(a);
  }

  for (const e of entries) {
    const s = conflictsByTerm.get(e.term);
    if (s && s.size > 0) e.conflicts = Array.from(s).sort();
  }

  entries.sort((a, b) => a.label.localeCompare(b.label));

  const withConflicts = entries.filter((e) => e.conflicts && e.conflicts.length > 0).length;

  await writeFile(OUT, JSON.stringify({ entries }, null, 2));
  console.log(`Wrote ${entries.length} entries → ${OUT}`);
  console.log(`  ${withConflicts} entries have conflict rules`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
