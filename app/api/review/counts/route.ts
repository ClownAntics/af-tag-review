import { getSupabase } from "@/lib/supabase";
import type { ReviewCounts, ReviewStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

const STATUSES: ReviewStatus[] = [
  "flagged",
  "pending",
  "readytosend",
  "updated",
  "novision",
];

export async function GET(): Promise<Response> {
  const supabase = getSupabase();

  // Before migration 002 applies, `status` doesn't exist and every query 500s.
  // Swallow those errors and return zeros so the Tag fixing tab renders
  // instead of erroring — the UI shows "—" / 0 and nothing is actionable yet.
  const results = await Promise.all(
    STATUSES.map(async (status) => {
      const { count, error } = await supabase
        .from("designs")
        .select("*", { count: "exact", head: true })
        .eq("status", status);
      if (error) return [status, 0] as const;
      return [status, count ?? 0] as const;
    }),
  );

  const counts = Object.fromEntries(results) as unknown as ReviewCounts;
  return Response.json(counts);
}
