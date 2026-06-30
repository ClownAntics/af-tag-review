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
import { getTaxonomy, type TaxonomyEntry as SourceEntry } from "@/lib/taxonomy-source";
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

type TaxEntry = SourceEntry;

// Index caches keyed off the entries-array identity returned by getTaxonomy.
// getTaxonomy itself memoizes, so reference equality is a cheap "did the
// taxonomy change?" check that avoids rebuilding maps on every request.
let _entriesRef: readonly TaxEntry[] | null = null;
let _byTerm: Map<string, TaxEntry> | null = null;
let _l2ParentTerm: Map<string, string> | null = null; // "Name|Sub" → level-2 Search Term
let _l1ParentTerm: Map<string, string> | null = null; // "Name"     → level-1 Search Term

async function ensureIndexes(): Promise<void> {
  const { entries } = await getTaxonomy();
  if (entries === _entriesRef && _byTerm) return;
  _entriesRef = entries;
  _byTerm = new Map(entries.map((e) => [e.term, e]));
  _l2ParentTerm = new Map();
  _l1ParentTerm = new Map();
  for (const e of entries) {
    if (e.level === 1) _l1ParentTerm.set(e.name, e.term);
    else if (e.level === 2 && e.sub) _l2ParentTerm.set(`${e.name}|${e.sub}`, e.term);
  }
  // Reset derived caches that depend on the entries set.
  _taxBlock = null;
  _validTerms = null;
  _labelToTerm = null;
}

export async function expandToIncludeAncestors(tags: string[]): Promise<string[]> {
  await ensureIndexes();
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

/**
 * Strip decoration tags that conflict with the primary's level-2 occasion.
 *
 * The vision model sometimes emits decoration terms whose taxonomy lineage
 * sits under a sibling occasion of the primary — e.g. on a Mardi Gras flag
 * with sparkles + masks it might emit `Fireworks` (under `Seasonal: 4th of
 * July`) and `Masks` (under `Seasonal: Halloween`). The ancestor expander
 * then dragged in the sibling level-2 parents (`4th-Of-July`, `Halloween`),
 * cross-tagging the design with unrelated occasions. Filtering before
 * expansion is the cleanest place to enforce "one occasion per design".
 *
 * Rules:
 *   - Primary not in taxonomy → no-op (defensive).
 *   - Primary is level-1 (e.g. "Seasonal" itself) → keep everything; the
 *     primary is the whole umbrella, sibling sub-themes can coexist.
 *   - Decoration's `name` differs from primary's `name` → different level-1
 *     theme entirely (e.g. `Birds: Cardinals` on a `Seasonal: Christmas` flag).
 *     Keep.
 *   - Same `name`, different `sub` → competing occasion, drop.
 *   - Same `name`, same `sub` → descendant or peer-leaf of primary, keep.
 */
export async function filterConflictingDecoration(
  primary: string | null,
  decoration: string[],
): Promise<{ kept: string[]; dropped: string[] }> {
  if (!primary) return { kept: decoration, dropped: [] };
  await ensureIndexes();
  const primaryEntry = _byTerm!.get(primary);
  if (!primaryEntry || primaryEntry.level === 1) {
    return { kept: decoration, dropped: [] };
  }
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const term of decoration) {
    const e = _byTerm!.get(term);
    if (!e) {
      kept.push(term);
      continue;
    }
    if (e.name !== primaryEntry.name) {
      kept.push(term);
    } else if (e.sub === primaryEntry.sub) {
      kept.push(term);
    } else {
      dropped.push(term);
    }
  }
  return { kept, dropped };
}

/**
 * Map a flat list of Search-Term tags into the hierarchical columns used for
 * filtering (`theme_names`, `sub_themes`, `sub_sub_themes`). Unknown tags are
 * skipped — this is safe to call on raw Shopify tag sets that may contain
 * noise (sizes, brand tokens, etc.).
 *
 * Used by the "Mark as fine" fast-path, which trusts the existing Shopify
 * tags and needs to keep the derived theme columns in sync so the filters
 * still surface the design after it moves to Ready-to-send.
 *
 *   theme_names     → unique `name` values                (e.g. "Birds")
 *   sub_themes      → unique "name: sub" strings          (e.g. "Birds: Cardinals")
 *   sub_sub_themes  → unique "name: sub: subSub" strings  (e.g. "Flowers: Spring Flowers: Roses")
 */
export async function mapTagsToThemes(tags: string[]): Promise<{
  theme_names: string[];
  sub_themes: string[];
  sub_sub_themes: string[];
}> {
  await ensureIndexes();
  const names = new Set<string>();
  const subs = new Set<string>();
  const subSubs = new Set<string>();
  for (const t of tags) {
    const e = _byTerm!.get(t);
    if (!e) continue;
    names.add(e.name);
    if (e.sub) subs.add(`${e.name}: ${e.sub}`);
    if (e.subSub && e.sub) subSubs.add(`${e.name}: ${e.sub}: ${e.subSub}`);
  }
  return {
    theme_names: Array.from(names).sort(),
    sub_themes: Array.from(subs).sort(),
    sub_sub_themes: Array.from(subSubs).sort(),
  };
}

// Derived caches — invalidated by ensureIndexes when the entries set changes.
let _taxBlock: string | null = null;
function taxonomyBlock(): string {
  if (_taxBlock) return _taxBlock;
  _taxBlock = (_entriesRef ?? []).map((e) => `${e.term} — ${e.label}`).join("\n");
  return _taxBlock;
}

let _validTerms: Set<string> | null = null;
function validTerms(): Set<string> {
  if (_validTerms) return _validTerms;
  _validTerms = new Set((_entriesRef ?? []).map((e) => e.term));
  return _validTerms;
}

// Fallback resolver: when Claude emits a display label / name / "name: sub"
// string instead of the canonical Search Term (e.g. "Welcome" when the
// Search Term is "Welcome-Flags"), try to resolve it. Case-insensitive.
let _labelToTerm: Map<string, string> | null = null;
function resolveToTerm(raw: string): string | null {
  const valid = validTerms();
  if (valid.has(raw)) return raw;
  if (!_labelToTerm) {
    _labelToTerm = new Map();
    const entries = _entriesRef ?? [];
    for (const e of entries) {
      // Register lowercase label, lowercase name, lowercase "name: sub", and
      // the lowercased Search Term (+ hyphens-as-spaces) so case/spacing
      // variants and name-only / parent-only emissions resolve.
      _labelToTerm.set(e.label.toLowerCase(), e.term);
      _labelToTerm.set(e.name.toLowerCase(), e.term);
      if (e.sub) _labelToTerm.set(`${e.name}: ${e.sub}`.toLowerCase(), e.term);
      _labelToTerm.set(e.term.toLowerCase(), e.term);
      _labelToTerm.set(e.term.toLowerCase().replace(/-/g, " "), e.term);
    }
    // Also map each entry's bare LEAF (last ":" segment of the label) when it's
    // unambiguous, so Claude emitting just the leaf concept — e.g. "Welcome"
    // for the term "Welcome-Flags" (label "Love & Happiness: Welcome") —
    // resolves instead of failing validation. Skip leaves shared by multiple
    // entries to avoid mis-resolving; don't clobber a more specific mapping.
    const leafCount = new Map<string, number>();
    for (const e of entries) {
      const leaf = e.label.split(":").pop()?.trim().toLowerCase();
      if (leaf) leafCount.set(leaf, (leafCount.get(leaf) ?? 0) + 1);
    }
    for (const e of entries) {
      const leaf = e.label.split(":").pop()?.trim().toLowerCase();
      if (leaf && leafCount.get(leaf) === 1 && !_labelToTerm.has(leaf)) {
        _labelToTerm.set(leaf, e.term);
      }
    }
  }
  const byLabel = _labelToTerm.get(raw.toLowerCase());
  return byLabel || null;
}

export async function buildSystemPrompt(template?: string): Promise<string> {
  await ensureIndexes();
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
  /** Decoration terms stripped by the occasion-conflict filter, recorded
   *  inside `vision_raw` for auditability. Empty array if nothing was
   *  filtered. Not promoted into the stored tag set. */
  dropped_conflicting?: string[];
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

async function parseResponse(raw: string): Promise<VisionResult | { error: string }> {
  await ensureIndexes();
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

  const hasNewShape = "primary" in obj || "decoration" in obj;
  const hasOldShape = "tags" in obj;

  let primary: string | null = null;
  let decoration: string[] = [];
  let reasoning: string | undefined;

  const toTerm = (raw: unknown): string | null => {
    if (typeof raw !== "string") return null;
    return resolveToTerm(raw);
  };

  if (hasNewShape) {
    if (typeof obj.primary === "string") {
      primary = toTerm(obj.primary);
      if (!primary) {
        return { error: `primary "${obj.primary}" is not in taxonomy` };
      }
    }
    if (Array.isArray(obj.decoration)) {
      decoration = obj.decoration
        .map((t) => toTerm(t))
        .filter((t): t is string => t !== null);
    }
    if (typeof obj.reasoning === "string") reasoning = obj.reasoning;
  } else if (hasOldShape && Array.isArray(obj.tags)) {
    // Legacy support for any saved prompts still producing the old shape.
    decoration = obj.tags
      .map((t) => toTerm(t))
      .filter((t): t is string => t !== null);
    if (typeof obj.notes === "string") reasoning = obj.notes;
  } else {
    return {
      error: `response missing 'primary'/'decoration' (or legacy 'tags'): ${raw.slice(0, 200)}`,
    };
  }

  // Drop decoration tags whose lineage points to a competing occasion under
  // the same level-1 theme (e.g. `Fireworks` under `Seasonal: 4th of July`
  // on a `Mardi-Gras` flag). Without this the ancestor expander below would
  // pull the conflicting level-2 parent into the stored tag set.
  const { kept: filteredDecoration, dropped: droppedConflicting } =
    await filterConflictingDecoration(primary, decoration);

  // Union primary + decoration, then fill in Level-2/Level-1 parents for each
  // Level-3 or Level-2 pick so the stored tag set has the full hierarchy.
  const union = new Set<string>(filteredDecoration);
  if (primary) union.add(primary);
  const expanded = await expandToIncludeAncestors(Array.from(union));

  return { tags: expanded, primary, reasoning, dropped_conflicting: droppedConflicting };
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
    const v = await parseResponse(text);
    if ("error" in v) return { ok: false, error: v.error };
    return { ok: true, value: v, usage: resp.usage };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
