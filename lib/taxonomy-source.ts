/**
 * Server-side taxonomy loader. Single source of truth for "what's the
 * current FL Themes taxonomy" used by API routes and shared lib code.
 *
 * Read order:
 *   1. taxonomy_entries (Supabase) — populated by /api/taxonomy/refresh apply.
 *   2. lib/taxonomy.json — baked fallback for the pre-bootstrap window or
 *      when Supabase is unreachable. Same shape as the Supabase rows after
 *      transform; safe to use interchangeably.
 *
 * Cached for `TTL_MS` to keep hot paths (vision prompt build, action route
 * theme mapping) from hitting the DB on every request. Apply flow calls
 * `invalidate()` after a successful refresh so reviewers see new terms
 * within the next request, not after a TTL.
 */
import bakedTaxonomy from "@/lib/taxonomy.json";
import { getAdminSupabase } from "@/lib/supabase-admin";

export interface TaxonomyEntry {
  term: string;
  name: string;
  sub: string | null;
  subSub: string | null;
  level: 1 | 2 | 3;
  label: string;
  conflicts?: string[];
}

export interface Taxonomy {
  entries: TaxonomyEntry[];
  /** Where the data came from on this load. Useful for /status and debug. */
  source: "supabase" | "baked";
}

interface PersistedRow {
  td_row_id: number;
  search_term: string | null;
  name: string;
  sub_theme: string | null;
  sub_sub_theme: string | null;
  level: number;
  label: string;
  conflicts_with: string[] | null;
}

const TTL_MS = 60_000;
let cache: { value: Taxonomy; expiresAt: number } | null = null;

export function invalidateTaxonomyCache(): void {
  cache = null;
}

export async function getTaxonomy(): Promise<Taxonomy> {
  if (cache && cache.expiresAt > Date.now()) return cache.value;

  let value: Taxonomy;
  try {
    value = await loadFromSupabase();
  } catch (e) {
    // Supabase unreachable — fall back so the app keeps working.
    console.warn(
      `taxonomy-source: Supabase load failed, using baked fallback: ${(e as Error).message}`,
    );
    value = bakedFallback();
  }

  cache = { value, expiresAt: Date.now() + TTL_MS };
  return value;
}

async function loadFromSupabase(): Promise<Taxonomy> {
  const sb = getAdminSupabase();
  const { data, error } = await sb
    .from("taxonomy_entries")
    .select(
      "td_row_id, search_term, name, sub_theme, sub_sub_theme, level, label, conflicts_with",
    );
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as PersistedRow[];
  if (rows.length === 0) return bakedFallback();

  const entries: TaxonomyEntry[] = [];
  for (const r of rows) {
    // search_term is the join key for tag operations. Rows without one
    // (e.g. parent group entries that aren't reviewable tags) get skipped
    // for the typeahead-shaped response.
    if (!r.search_term) continue;
    if (r.level !== 1 && r.level !== 2 && r.level !== 3) continue;
    entries.push({
      term: r.search_term,
      name: r.name,
      sub: r.sub_theme,
      subSub: r.sub_sub_theme,
      level: r.level,
      label: r.label,
      conflicts: r.conflicts_with ?? undefined,
    });
  }
  return { entries, source: "supabase" };
}

function bakedFallback(): Taxonomy {
  const entries = (bakedTaxonomy.entries ?? []) as TaxonomyEntry[];
  return { entries, source: "baked" };
}
