import taxonomy from "@/lib/taxonomy.json";

export const dynamic = "force-static";

// Serves the baked FL Themes taxonomy. Re-bake via
// `npx tsx scripts/export-taxonomy.ts` whenever the CSV changes.
export async function GET(): Promise<Response> {
  return Response.json(taxonomy);
}
