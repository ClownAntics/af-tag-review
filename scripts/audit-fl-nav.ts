/**
 * Read-only: FL collections (smart + custom) with live product counts and
 * Online Store visibility, plus every collection link in the live
 * storefront's header/footer navigation (scraped from the public homepage —
 * the app token has no read_online_store_navigation scope; the Admin menus
 * query is tried first and used when allowed). Feeds the manual cleanup sheet (hide empty collections, fix
 * menu links to hidden/empty collections).
 *
 * Writes fl_nav_audit.json. Writes nothing to Shopify.
 *
 * Usage: npx tsx scripts/audit-fl-nav.ts
 */
import { writeFileSync } from "node:fs";
import { config } from "dotenv";

config({ path: ".env.local", quiet: true });

const API = "2025-01";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function env() {
  const store = process.env.SHOPIFY_FL_STORE;
  const token = process.env.SHOPIFY_FL_ADMIN_TOKEN;
  if (!store || !token) throw new Error("SHOPIFY_FL_STORE / SHOPIFY_FL_ADMIN_TOKEN not set");
  return { store, token };
}

async function rest<T>(path: string, key: string): Promise<T[]> {
  const { store, token } = env();
  const out: T[] = [];
  let url: string | null = `https://${store}.myshopify.com/admin/api/${API}/${path}`;
  while (url) {
    const res: Response = await fetch(url, { headers: { "X-Shopify-Access-Token": token } });
    if (res.status === 429) {
      await sleep(2000);
      continue;
    }
    if (!res.ok) throw new Error(`${path} ${res.status}: ${(await res.text()).slice(0, 300)}`);
    out.push(...((await res.json()) as Record<string, T[]>)[key]);
    const m = (res.headers.get("Link") ?? "").match(/<([^>]+)>;\s*rel="next"/);
    url = m ? m[1] : null;
    await sleep(400);
  }
  return out;
}

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const { store, token } = env();
  for (;;) {
    const res = await fetch(`https://${store}.myshopify.com/admin/api/${API}/graphql.json`, {
      method: "POST",
      headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status === 429) {
      await sleep(2000);
      continue;
    }
    const body = (await res.json()) as { data?: T; errors?: unknown };
    if (body.errors) {
      const msg = JSON.stringify(body.errors).slice(0, 400);
      if (msg.includes("THROTTLED")) {
        await sleep(2000);
        continue;
      }
      if (!body.data) throw new Error(`graphql: ${msg}`);
    }
    return body.data as T;
  }
}

async function productCounts(): Promise<Map<number, number>> {
  const counts = new Map<number, number>();
  let after: string | null = null;
  for (;;) {
    const d: {
      collections: {
        nodes: Array<{ legacyResourceId: string; productsCount: { count: number } | null }>;
        pageInfo: { hasNextPage: boolean; endCursor: string };
      };
    } = await gql(
      `query($after: String) { collections(first: 100, after: $after) {
         nodes { legacyResourceId productsCount { count } }
         pageInfo { hasNextPage endCursor } } }`,
      { after },
    );
    for (const n of d.collections.nodes) counts.set(Number(n.legacyResourceId), n.productsCount?.count ?? 0);
    if (!d.collections.pageInfo.hasNextPage) break;
    after = d.collections.pageInfo.endCursor;
    await sleep(500);
  }
  return counts;
}

interface MenuItem {
  title: string;
  type: string;
  url: string | null;
  resourceId: string | null;
  items?: MenuItem[];
}

async function menus() {
  const ITEM = "title type url resourceId";
  const d: { menus: { nodes: Array<{ id: string; title: string; handle: string; items: MenuItem[] }> } } = await gql(
    `{ menus(first: 250) { nodes { id title handle items { ${ITEM} items { ${ITEM} items { ${ITEM} } } } } } }`,
  );
  const flat: Array<{ menu: string; menu_handle: string; menu_id: number; path: string; title: string; type: string; url: string | null; collection_id: number | null }> = [];
  const walk = (menu: { id: string; title: string; handle: string }, items: MenuItem[], trail: string[]) => {
    for (const it of items) {
      const path = [...trail, it.title];
      const m = (it.resourceId ?? "").match(/Collection\/(\d+)$/);
      flat.push({
        menu: menu.title,
        menu_handle: menu.handle,
        menu_id: Number(menu.id.split("/").pop()),
        path: path.join(" > "),
        title: it.title,
        type: it.type,
        url: it.url,
        collection_id: m ? Number(m[1]) : null,
      });
      if (it.items?.length) walk(menu, it.items, path);
    }
  };
  for (const m of d.menus.nodes) walk(m, m.items, []);
  return flat;
}

/** Collection links customers see: parse the public homepage's <header>/<footer>/nav HTML. */
async function storefrontNav(domain: string) {
  const res = await fetch(`https://${domain}/`, { headers: { "User-Agent": "Mozilla/5.0 (FL nav audit)" } });
  if (!res.ok) throw new Error(`storefront ${res.status}`);
  const html = await res.text();
  const out: Array<{ menu: string; menu_handle: string; path: string; title: string; type: string; url: string | null; collection_id: number | null; handle: string }> = [];
  const re = /<a[^>]*href="([^"]*\/collections\/([a-z0-9\-]+))[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  const seen = new Set<string>();
  for (const m of html.matchAll(re)) {
    const handle = m[2];
    const text = m[3].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const key = `${handle}|${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ menu: "Storefront nav (homepage)", menu_handle: "storefront", path: text, title: text, type: "COLLECTION", url: m[1], collection_id: null, handle });
  }
  return out;
}

async function main() {
  type Coll = { id: number; title: string; handle: string; published_at: string | null };
  const [smart, custom, counts, navAdmin] = await Promise.all([
    rest<Coll>("smart_collections.json?limit=250&fields=id,title,handle,published_at", "smart_collections"),
    rest<Coll>("custom_collections.json?limit=250&fields=id,title,handle,published_at", "custom_collections"),
    productCounts(),
    menus().catch((e) => {
      console.warn(`[nav] admin menus unavailable (${(e as Error).message.slice(0, 80)}…) — using storefront`);
      return null;
    }),
  ]);
  const nav = navAdmin ?? (await storefrontNav(process.env.FL_STOREFRONT_DOMAIN ?? "www.flagsrus.org"));
  const collections = [
    ...smart.map((c) => ({ ...c, kind: "smart" })),
    ...custom.map((c) => ({ ...c, kind: "manual" })),
  ].map((c) => ({
    id: c.id,
    title: c.title,
    handle: c.handle,
    kind: c.kind,
    published: !!c.published_at,
    products: counts.get(c.id) ?? null,
  }));
  writeFileSync("fl_nav_audit.json", JSON.stringify({ collections, nav }, null, 1), "utf8");
  const byHandle = new Map(collections.map((c) => [c.handle, c]));
  const linked = nav.filter((n) => n.collection_id || (n.url ?? "").includes("/collections/"));
  console.log(
    `[nav] ${collections.length} collections (${smart.length} smart, ${custom.length} manual) · ` +
      `${nav.length} menu items in ${new Set(nav.map((n) => n.menu_handle)).size} menus · ${linked.length} link to collections · ` +
      `${byHandle.size} handles`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
