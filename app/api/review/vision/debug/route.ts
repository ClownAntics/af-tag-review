/**
 * Debug endpoint: returns the exact system prompt the vision route would send
 * on the next run. Used to confirm HMR has picked up lib/vision-prompt.ts edits.
 *
 * GET /api/review/vision/debug
 */
import { buildSystemPrompt, VISION_MODEL } from "@/lib/vision";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const prompt = buildSystemPrompt(); // no template arg = use DEFAULT_PROMPT
  const hasRule7 = prompt.includes("NO HEDGING");
  const hasRule6OneParent = prompt.includes("ONE PARENT PER PICK");
  return Response.json({
    model: VISION_MODEL,
    prompt_length: prompt.length,
    has_rule_7_no_hedging: hasRule7,
    has_rule_6_one_parent: hasRule6OneParent,
    first_1500_chars: prompt.slice(0, 1500),
  });
}
