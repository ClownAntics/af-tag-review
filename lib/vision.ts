/**
 * Shared vision-tagging core: callable both from the CLI script
 * (`scripts/tag-with-vision.ts`) and the Next.js API route
 * (`app/api/review/vision/run/route.ts`).
 *
 * Responsibilities:
 *   - Build the Claude prompt from the current vision_prompt (Supabase) or
 *     fall back to a default, substituting {{taxonomy}} with the baked taxonomy.
 *   - Issue the vision request.
 *   - Validate the response against the taxonomy, returning Search Terms only.
 */
import Anthropic from "@anthropic-ai/sdk";
import taxonomy from "@/lib/taxonomy.json";
import { DEFAULT_PROMPT } from "@/lib/vision-prompt";

export { DEFAULT_PROMPT };
// Sonnet 4.6 handles "primary theme + decorative detail" nuance much better
// than Haiku on this task — worth the ~3× cost ($0.006 vs $0.002 per design).
export const VISION_MODEL = "claude-sonnet-4-6";
export const VISION_MAX_TOKENS = 1024;

// ─── hierarchy parent lookup (for tags returned by Claude) ────────────────
//
// Given a picked Search Term (any level), return the list of Search Terms for
// its ancestors up the taxonomy (Level-2 and Level-1 parents). Used as a
// safety net so the hierarchy is always complete even when Claude forgets.

interface TaxEntry {
  term: string;
  name: string;
  sub: string | null;
  subSub: string | null;
  level: 1 | 2 | 3;
  label: string;
}

let _byTerm: Map<string, TaxEntry> | null = null;
let _l2ParentTerm: Map<string, string> | null = null; // "Name|Sub" → level-2 Search Term
let _l1ParentTerm: Map<string, string> | null = null; // "Name"     → level-1 Search Term

function buildIndexes() {
  if (_byTerm) return;
  const entries = taxonomy.entries as TaxEntry[];
  _byTerm = new Map(entries.map((e) => [e.term, e]));
  _l2ParentTerm = new Map();
  _l1ParentTerm = new Map();
  for (const e of entries) {
    if (e.level === 1) _l1ParentTerm.set(e.name, e.term);
    else if (e.level === 2 && e.sub) _l2ParentTerm.set(`${e.name}|${e.sub}`, e.term);
  }
}

export function expandToIncludeAncestors(tags: string[]): string[] {
  buildIndexes();
  const out = new Set<string>();
  for (const t of tags) {
    const entry = _byTerm!.get(t);
    if (!entry) continue;
    out.add(t);
    if (entry.level === 2 || entry.level === 3) {
      const l1 = _l1ParentTerm!.get(entry.name);
      if (l1) out.add(l1);
    }
    if (entry.level === 3 && entry.sub) {
      const l2 = _l2ParentTerm!.get(`${entry.name}|${entry.sub}`);
      if (l2) out.add(l2);
    }
  }
  return Array.from(out).sort();
}

interface TaxonomyEntry {
  term: string;
  label: string;
}

let _taxBlock: string | null = null;
function taxonomyBlock(): string {
  if (_taxBlock) return _taxBlock;
  const entries = taxonomy.entries as TaxonomyEntry[];
  _taxBlock = entries.map((e) => `${e.term} — ${e.label}`).join("\n");
  return _taxBlock;
}

let _validTerms: Set<string> | null = null;
function validTerms(): Set<string> {
  if (_validTerms) return _validTerms;
  _validTerms = new Set((taxonomy.entries as TaxonomyEntry[]).map((e) => e.term));
  return _validTerms;
}

export function buildSystemPrompt(template?: string): string {
  const t = (template || DEFAULT_PROMPT).replace(/\{\{taxonomy\}\}/g, taxonomyBlock());
  return t;
}

export interface VisionResult {
  /** Flat, deduplicated, hierarchy-expanded Search Term list — what gets
   *  stored on `designs.vision_tags`. Includes primary + decoration + all
   *  ancestor terms. */
  tags: string[];
  /** The single "what is this flag FOR" Search Term Claude picked. Stored
   *  inside vision_raw for auditability; the UI can highlight it separately. */
  primary: string | null;
  /** Claude's one-sentence justification for the primary pick. */
  reasoning?: string;
}

function extractFirstJsonObject(s: string): string | null {
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (escape) { escape = false; continue; }
    if (inStr) {
      if (c === "\\") escape = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

function parseResponse(raw: string): VisionResult | { error: string } {
  let txt = raw.trim();
  if (txt.startsWith("```")) {
    txt = txt.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
  }
  const block = extractFirstJsonObject(txt);
  if (!block) return { error: `no JSON in response: ${raw.slice(0, 200)}` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch (e) {
    return { error: `invalid JSON: ${(e as Error).message}` };
  }
  const obj = parsed as Record<string, unknown>;

  // New schema: {primary: string, decoration: string[], reasoning: string}.
  // Back-compat: if the old {tags, confidence, notes} comes in, convert it.
  const valid = validTerms();

  const hasNewShape = "primary" in obj || "decoration" in obj;
  const hasOldShape = "tags" in obj;

  let primary: string | null = null;
  let decoration: string[] = [];
  let reasoning: string | undefined;

  if (hasNewShape) {
    if (typeof obj.primary === "string" && valid.has(obj.primary)) {
      primary = obj.primary;
    } else if (typeof obj.primary === "string") {
      return { error: `primary "${obj.primary}" is not in taxonomy` };
    }
    if (Array.isArray(obj.decoration)) {
      decoration = obj.decoration.filter(
        (t): t is string => typeof t === "string" && valid.has(t),
      );
    }
    if (typeof obj.reasoning === "string") reasoning = obj.reasoning;
  } else if (hasOldShape && Array.isArray(obj.tags)) {
    // Legacy support for any saved prompts still producing the old shape.
    decoration = obj.tags.filter(
      (t): t is string => typeof t === "string" && valid.has(t),
    );
    if (typeof obj.notes === "string") reasoning = obj.notes;
  } else {
    return {
      error: `response missing 'primary'/'decoration' (or legacy 'tags'): ${raw.slice(0, 200)}`,
    };
  }

  // Union primary + decoration, then fill in Level-2/Level-1 parents for each
  // Level-3 or Level-2 pick so the stored tag set has the full hierarchy.
  const union = new Set<string>(decoration);
  if (primary) union.add(primary);
  const expanded = expandToIncludeAncestors(Array.from(union));

  return { tags: expanded, primary, reasoning };
}

export interface TagOneInput {
  designFamily: string;
  imageUrl: string;
  systemPrompt: string; // prebuilt via buildSystemPrompt()
}

export async function tagOne(
  client: Anthropic,
  input: TagOneInput,
): Promise<
  | { ok: true; value: VisionResult; usage: Anthropic.Usage }
  | { ok: false; error: string }
> {
  try {
    const resp = await client.messages.create({
      model: VISION_MODEL,
      max_tokens: VISION_MAX_TOKENS,
      system: [
        { type: "text", text: input.systemPrompt, cache_control: { type: "ephemeral" } },
      ],
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "url", url: input.imageUrl } },
            {
              type: "text",
              text: `Tag this ${input.designFamily} garden flag. Return JSON only with Search Terms.`,
            },
          ],
        },
      ],
    });

    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    const v = parseResponse(text);
    if ("error" in v) return { ok: false, error: v.error };
    return { ok: true, value: v, usage: resp.usage };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
