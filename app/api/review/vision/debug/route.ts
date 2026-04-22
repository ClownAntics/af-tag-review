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
  // Env-presence probe (values never returned — just length + first 3 chars
  // for anthropic, so we can confirm the key is populated and correctly-prefixed
  // without leaking anything).
  const anth = process.env.ANTHROPIC_API_KEY ?? "";
  const env = {
    ANTHROPIC_API_KEY_present: anth.length > 0,
    ANTHROPIC_API_KEY_length: anth.length,
    ANTHROPIC_API_KEY_prefix: anth.slice(0, 7), // "sk-ant-" for valid keys
    SUPABASE_SERVICE_ROLE_KEY_present: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    SHOPIFY_ADMIN_TOKEN_present: !!process.env.SHOPIFY_ADMIN_TOKEN,
  };
  return Response.json({
    model: VISION_MODEL,
    prompt_length: prompt.length,
    has_rule_7_no_hedging: hasRule7,
    has_rule_6_one_parent: hasRule6OneParent,
    env,
    first_1500_chars: prompt.slice(0, 1500),
  });
}
