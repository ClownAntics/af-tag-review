/**
 * Load the FL Themes taxonomy from CSV and format it for Claude.
 *
 * Produces:
 *   - A structured list (for validation: which (name,sub,subsub) triples are legal)
 *   - A compact text block (for the Claude system prompt, cacheable)
 *
 * Excludes the admin buckets (Business / Features / Size) same way
 * scripts/import-themes.ts does.
 */
import { createReadStream } from "node:fs";
import { parse } from "csv-parse";

export interface TaxonomyEntry {
  name: string;            // Level 1
  subTheme: string | null; // Level 2
  subSubTheme: string | null; // Level 3
  level: 1 | 2 | 3;
}

export interface Taxonomy {
  entries: TaxonomyEntry[];
  validTheme: Set<string>;       // "Name"
  validSub: Set<string>;         // "Name: Sub"
  validSubSub: Set<string>;      // "Name: Sub: SubSub"
  promptText: string;            // formatted list for Claude
}

// Kept in lockstep with scripts/import-themes.ts
const EXCLUDED_TOP_LEVELS = new Set(["Business", "Features", "Size"]);

export async function loadTaxonomy(csvPath: string): Promise<Taxonomy> {
  const entries: TaxonomyEntry[] = [];
  const parser = createReadStream(csvPath).pipe(
    parse({ columns: true, bom: true, skip_empty_lines: true, trim: true }),
  );

  for await (const r of parser as AsyncIterable<Record<string, string>>) {
    const name = (r["Name"] || "").trim();
    if (!name || EXCLUDED_TOP_LEVELS.has(name)) continue;
    const sub = (r["Sub Theme"] || "").trim() || null;
    const subSub = (r["Sub Sub Theme"] || "").trim() || null;
    const level = Math.round(Number(r["Level"] || "0"));
    if (level !== 1 && level !== 2 && level !== 3) continue;
    entries.push({ name, subTheme: sub, subSubTheme: subSub, level: level as 1 | 2 | 3 });
  }

  // Deduplicate — the same (name,sub,subsub) can appear via different search terms.
  const seen = new Set<string>();
  const deduped: TaxonomyEntry[] = [];
  for (const e of entries) {
    const k = `${e.level}|${e.name}|${e.subTheme || ""}|${e.subSubTheme || ""}`;
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(e);
  }

  const validTheme = new Set<string>();
  const validSub = new Set<string>();
  const validSubSub = new Set<string>();
  for (const e of deduped) {
    validTheme.add(e.name);
    if (e.subTheme) validSub.add(`${e.name}: ${e.subTheme}`);
    if (e.subTheme && e.subSubTheme) {
      validSubSub.add(`${e.name}: ${e.subTheme}: ${e.subSubTheme}`);
    }
  }

  // Build the prompt block: grouped by Name → Sub → SubSubs. Compact enough
  // to cache cheaply, explicit enough that Claude can only pick valid values.
  const byName = new Map<string, Map<string | null, Set<string>>>();
  for (const e of deduped) {
    if (!byName.has(e.name)) byName.set(e.name, new Map());
    const subs = byName.get(e.name)!;
    const subKey = e.subTheme || null;
    if (!subs.has(subKey)) subs.set(subKey, new Set());
    if (e.subSubTheme && e.subTheme) subs.get(subKey)!.add(e.subSubTheme);
  }

  const lines: string[] = [];
  for (const name of Array.from(byName.keys()).sort()) {
    lines.push(`- ${name}`);
    const subs = byName.get(name)!;
    const subKeys = Array.from(subs.keys()).filter((s): s is string => s !== null).sort();
    for (const sub of subKeys) {
      const subSubs = Array.from(subs.get(sub)!).sort();
      if (subSubs.length === 0) {
        lines.push(`  - ${name}: ${sub}`);
      } else {
        lines.push(`  - ${name}: ${sub}`);
        for (const subSub of subSubs) {
          lines.push(`    - ${name}: ${sub}: ${subSub}`);
        }
      }
    }
  }

  return {
    entries: deduped,
    validTheme,
    validSub,
    validSubSub,
    promptText: lines.join("\n"),
  };
}
