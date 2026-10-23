/**
 * Read-only: how would the FL tag push change FL smart collections?
 *
 * 1. Loads every FL smart collection, its rules (REST) and product count
 *    (GraphQL productsCount).
 * 2. Runs the FL push as a DRY RUN twice (lib/fl-push) — once ADD-ONLY (what
 *    FL actually does) and once with the JF FULL-MERGE rule (owned taxonomy +
 *    facet tags replaced) — to get each product's added / removed tags.
 * 3. For every collection, evaluates ALL its rules (tag / type / vendor /
 *    title; price & inventory rules assumed to hold — tags don't affect them)
 *    on each changed product before vs after, giving exact join / leave
 *    counts per mode. Flags rule tags that are taxonomy terms (the push owns
 *    those under full merge).
 *
 * Writes fl_collections_audit.json (fed to the cleanup spreadsheet). Writes
 * nothing to Shopify or Supabase.
 *
 * Usage: npx tsx scripts/audit-fl-collections.ts
 */
import { writeFileSync } from "node:fs";
import { getAdminClient } from "./_supabase-admin";
import { runFlPush } from "../lib/fl-push";
import { normalizeTagKey } from "../lib/shopify";
import { getTaxonomy } from "../lib/taxonomy-source";
import { OWNED_FACET_KEYS } from "../lib/facet-tags";

interface Rule {
  column: string;
  relation: string;
  condition: string;
}
interface SmartCollection {
  id: number;
  title: string;
  handle: string;
  disjunctive: boolean;
  published_at: string | null;
  rules: Rule[];
}
interface Change {
  family: string;
  product_id: number;
  title: string;
  product_type: string;
  vendor: string;
  before: string[];
  added: string[];
  removed: string[];
}

const API = "2025-01";

function env() {
  const store = process.env.SHOPIFY_FL_STORE;
  const token = process.env.SHOPIFY_FL_ADMIN_TOKEN;
  if (!store || !token) throw new Error("SHOPIFY_FL_STORE / SHOPIFY_FL_ADMIN_TOKEN not set");
  return { store, token };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function listSmartCollections(): Promise<SmartCollection[]> {
  const { store, token } = env();
  const out: SmartCollection[] = [];
  let url: string | null =
    `https://${store}.myshopify.com/admin/api/${API}/smart_collections.json?limit=250&fields=id,title,handle,disjunctive,published_at,rules`;
  while (url) {
    const res: Response = await fetch(url, { headers: { "X-Shopify-Access-Token": token } });
    if (res.status === 429) {
      await sleep(2000);
      continue;
    }
    if (!res.ok) throw new Error(`smart_collections ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as { smart_collections: SmartCollection[] };
    out.push(...data.smart_collections);
    const m = (res.headers.get("Link") ?? "").match(/<([^>]+)>;\s*rel="next"/);
    url = m ? m[1] : null;
    await sleep(400);
  }
  return out;
}

/** Collection id → product count, via GraphQL (REST has no count field). */
async function productCounts(): Promise<Map<number, number>> {
  const { store, token } = env();
  const counts = new Map<number, number>();
  let after: string | null = null;
  for (;;) {
    const res: Response = await fetch(`https://${store}.myshopify.com/admin/api/${API}/graphql.json`, {
      method: "POST",
      headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `query($after: String) {
          collections(first: 100, after: $after, query: "collection_type:smart") {
            nodes { legacyResourceId productsCount { count } }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        variables: { after },
      }),
    });
    if (res.status === 429) {
      await sleep(2000);
      continue;
    }
    const body = (await res.json()) as {
      data?: {
        collections: {
          nodes: Array<{ legacyResourceId: string; productsCount: { count: number } | null }>;
          pageInfo: { hasNextPage: boolean; endCursor: string };
        };
      };
      errors?: unknown;
    };
    if (body.errors && !body.data) {
      const msg = JSON.stringify(body.errors).slice(0, 300);
      if (msg.includes("THROTTLED")) {
        await sleep(2000);
        continue;
      }
      throw new Error(`graphql: ${msg}`);
    }
    const c = body.data!.collections;
    for (const n of c.nodes) counts.set(Number(n.legacyResourceId), n.productsCount?.count ?? 0);
    if (!c.pageInfo.hasNextPage) break;
    after = c.pageInfo.endCursor;
    await sleep(500);
  }
  return counts;
}

function strMatch(relation: string, value: string, condition: string): boolean | null {
  const v = value.trim().toLowerCase();
  const c = condition.trim().toLowerCase();
  switch (relation) {
    case "equals":
      return v === c;
    case "not_equals":
      return v !== c;
    case "starts_with":
      return v.startsWith(c);
    case "ends_with":
      return v.endsWith(c);
    case "contains":
      return v.includes(c);
    case "not_contains":
      return !v.includes(c);
    default:
      return null;
  }
}

/** Does one rule hold for a product with these tags? null = can't tell
 *  (price / inventory rules) — those don't change with tags, so treated as
 *  holding. */
function ruleHolds(rule: Rule, ch: Change, tags: string[]): boolean {
  if (rule.column === "tag") {
    const neg = rule.relation.startsWith("not_");
    const pos = neg ? rule.relation.slice(4) : rule.relation;
    const any = tags.some((t) => strMatch(pos, t, rule.condition) === true);
    return neg ? !any : any;
  }
  const field =
    rule.column === "type" ? ch.product_type : rule.column === "vendor" ? ch.vendor : rule.column === "title" ? ch.title : null;
  if (field === null) return true;
  return strMatch(rule.relation, field, rule.condition) ?? true;
}

function inCollection(c: SmartCollection, ch: Change, tags: string[]): boolean {
  if (c.rules.length === 0) return false;
  return c.disjunctive ? c.rules.some((r) => ruleHolds(r, ch, tags)) : c.rules.every((r) => ruleHolds(r, ch, tags));
}

/** Exact membership change for one collection across the changed products. */
function impact(c: SmartCollection, changes: Change[]) {
  let join = 0;
  let leave = 0;
  const leaveExamples: string[] = [];
  const joinExamples: string[] = [];
  for (const ch of changes) {
    const removed = new Set(ch.removed.map((t) => t.toLowerCase()));
    const after = [...ch.before.filter((t) => !removed.has(t.toLowerCase())), ...ch.added];
    const was = inCollection(c, ch, ch.before);
    const now = inCollection(c, ch, after);
    if (!was && now) {
      join++;
      if (joinExamples.length < 3) joinExamples.push(`${ch.family} ${ch.title}`);
    } else if (was && !now) {
      leave++;
      if (leaveExamples.length < 3) leaveExamples.push(`${ch.family} ${ch.title}`);
    }
  }
  return { join, leave, leaveExamples, joinExamples };
}

async function dryRun(label: string, ownedKeysOverride?: ReadonlySet<string>): Promise<Change[]> {
  const changes: Change[] = [];
  for await (const ev of runFlPush(getAdminClient(), { apply: false, ownedKeysOverride })) {
    if (ev.type === "change") changes.push(ev);
    else if (ev.type === "done") console.log(`[audit] ${label}: ${ev.changed} of ${ev.matched} matched FL products would change`);
  }
  return changes;
}

async function main() {
  const [collections, counts] = await Promise.all([listSmartCollections(), productCounts()]);
  console.log(`[audit] ${collections.length} FL smart collections, ${counts.size} counts`);

  const { entries } = await getTaxonomy();
  const taxByKey = new Map<string, { term: string; label: string; business: boolean }>();
  for (const e of entries) {
    taxByKey.set(normalizeTagKey(e.term), {
      term: e.term,
      label: e.label,
      business: !!(e.business || e.name === "Business"),
    });
  }
  const mergeKeys: ReadonlySet<string> = new Set([
    ...entries.filter((e) => !(e.business || e.name === "Business")).map((e) => normalizeTagKey(e.term)),
    ...OWNED_FACET_KEYS,
  ]);

  const addOnly = await dryRun("add-only");
  const fullMerge = await dryRun("full merge", mergeKeys);

  const out = collections.map((c) => ({
    id: c.id,
    title: c.title,
    handle: c.handle,
    disjunctive: c.disjunctive,
    published: !!c.published_at,
    products: counts.get(c.id) ?? null,
    add_only: impact(c, addOnly),
    full_merge: impact(c, fullMerge),
    rules: c.rules.map((r) => {
      const key = normalizeTagKey(r.condition);
      const tax = r.column === "tag" ? taxByKey.get(key) : undefined;
      return {
        ...r,
        taxonomy_term: tax?.term ?? null,
        taxonomy_label: tax?.label ?? null,
        owned_by_push: r.column === "tag" && mergeKeys.has(key),
      };
    }),
  }));
  writeFileSync("fl_collections_audit.json", JSON.stringify(out, null, 1), "utf8");
  console.log("[audit] wrote fl_collections_audit.json");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
