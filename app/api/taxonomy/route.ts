import { getTaxonomy } from "@/lib/taxonomy-source";

// Reads from Supabase taxonomy_entries (populated by the refresh-apply
// flow), falling back to the baked lib/taxonomy.json if Supabase is empty
// or unreachable. Cached server-side for 60s — see lib/taxonomy-source.
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const { entries, source } = await getTaxonomy();
  return Response.json({ entries, source });
}
