# Pulling product tags from Supabase

The `designs` table in our shared Supabase project carries the curated tag
data for every product in the JFF Shopify catalog. This doc tells you how
to query it from a new app.

## Connection

- **Project URL**: `https://rilhgeshkypbcckedaoh.supabase.co`
- **Anon key**: from `NEXT_PUBLIC_SUPABASE_ANON_KEY` (copy from any
  af-tag-review / af-sales-research env). Safe to ship in client code.
- **Service-role key**: from `SUPABASE_SERVICE_ROLE_KEY`. Server-side
  only — never bundle into a browser. You only need this if you're
  writing to the table; reads work with the anon key.

Drop into `.env.local`:

```
NEXT_PUBLIC_SUPABASE_URL=https://rilhgeshkypbcckedaoh.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<paste>
```

## Table: `designs`

One row per *design family* — meaning AF designs collapse their garden /
house / banner / doormat variants under a single canonical key, while
non-AF (Carson, Evergreen, etc.) products are one-row-per-product.

| Column | Type | What it is |
|---|---|---|
| `design_family` | text PK | Canonical key. AF: `AFSP0419`; non-AF: the SKU itself, e.g. `CA52602`. |
| `design_name` | text | Shopify product title. Nullable for legacy rows. |
| `manufacturer` | text | Normalized vendor — `AF`, `Carson`, `Evergreen`, `Premier`, `Demdaco`, etc. |
| `variant_skus` | text[] | All Shopify variant SKUs under this family. **Source of truth — don't fabricate.** |
| `shopify_product_ids` | bigint[] | All Shopify product IDs for this family. |
| `shopify_product_types` | text[] | Shopify's native `product_type` strings (`"Sleeved Flags: Small Flags: Sublimated (Printed)"`, etc.). |
| `image_url` | text | Real Shopify CDN URL. Prefer this over constructing one. |
| `status` | text | Pipeline state — see below. |
| `approved_tags` | text[] | **Curated** tags from the FL Themes taxonomy. Canonical kebab-case (`Easter-Eggs`, `4th-Of-July`, `Mardi-Gras`). |
| `shopify_tags` | text[] | Whatever Shopify currently has live. Lowercased (Shopify normalizes on store). |
| `theme_names` | text[] | Derived from `approved_tags` — Level-1 themes (`Birds`, `Seasonal`). |
| `sub_themes` | text[] | Derived — `"Seasonal: Christmas"`, `"Birds: Cardinals"`. |
| `sub_sub_themes` | text[] | Derived — `"Seasonal: Christmas: Wreaths"`. |
| `vision_tags` | text[] | Claude's suggestions awaiting human review. Usually empty post-curation. |
| `vision_raw` | jsonb | `{primary, decoration[], reasoning, dropped_conflicting?}`. `primary` is the single best-fit tag. |
| `units_total` | int | Lifetime units sold across all channels. |
| `first_seen_at` | timestamptz | When our DB first inserted this row. |
| `last_pushed_at` | timestamptz | When tags were last pushed to Shopify. |

### Status values

| Status | What it means |
|---|---|
| `novision` | In catalog, no review started. |
| `flagged` | Queued for vision tagging. |
| `pending` | Vision ran, human review pending. |
| `readytosend` | Reviewed, waiting for Shopify push. |
| `updated` | Pushed — `approved_tags` is live on Shopify. **This is what you want for reporting / analytics.** |
| `excluded` | Out of the review pipeline. Accessories, gift cards, Shopify-deleted products. |

## Which tag field to use

| Field | When to use |
|---|---|
| `approved_tags` | Cleanest data. Canonical FL Themes terms. Use for analytics, recommendations, search facets. |
| `shopify_tags` | Match exactly what's on the storefront. Lowercase / sometimes stale. |
| `theme_names` / `sub_themes` / `sub_sub_themes` | Pre-flattened hierarchy. Use for grouping / faceted browse. |

The three derived columns auto-update when `approved_tags` changes — they
stay in sync.

## Sample queries

**All live products + curated tags:**

```ts
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

const { data } = await sb
  .from("designs")
  .select(
    "design_family, design_name, manufacturer, variant_skus, shopify_product_ids, image_url, approved_tags, theme_names, sub_themes, sub_sub_themes, units_total"
  )
  .eq("status", "updated");
```

**Everything except excluded:**

```ts
const { data } = await sb
  .from("designs")
  .select("design_family, approved_tags, shopify_tags")
  .neq("status", "excluded");
```

**Designs tagged with a specific term (case-sensitive):**

```ts
const { data } = await sb
  .from("designs")
  .select("design_family, design_name, approved_tags")
  .contains("approved_tags", ["Kentucky"]);
```

**Designs in a theme hierarchy:**

```ts
const { data } = await sb
  .from("designs")
  .select("design_family, design_name")
  .contains("sub_themes", ["Seasonal: Christmas"]);
```

**Pagination** (PostgREST caps at 1000 rows per request):

```ts
const PAGE = 1000;
const out = [];
for (let offset = 0; ; offset += PAGE) {
  const { data } = await sb
    .from("designs")
    .select("design_family, approved_tags")
    .eq("status", "updated")
    .range(offset, offset + PAGE - 1);
  if (!data?.length) break;
  out.push(...data);
  if (data.length < PAGE) break;
}
```

**PostgREST REST (no client lib):**

```bash
curl "https://rilhgeshkypbcckedaoh.supabase.co/rest/v1/designs?status=eq.updated&select=design_family,approved_tags,shopify_tags&limit=100" \
  -H "apikey: $NEXT_PUBLIC_SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer $NEXT_PUBLIC_SUPABASE_ANON_KEY"
```

## Companion tables

You usually only need `designs`, but two others are queryable with the
same anon key:

- **`taxonomy_entries`** — the FL Themes taxonomy itself.
  - Columns: `search_term`, `name`, `sub_theme`, `sub_sub_theme`,
    `level`, `label` (e.g. `"Seasonal: Christmas"`), `conflicts_with`.
  - Use if you need to build a hierarchical browser / typeahead /
    validate that a tag is canonical.
- **`events`** — append-only audit log of every change.
  - Columns: `design_family`, `event_type`, `actor`, `timestamp`,
    `payload` jsonb.
  - Useful for "what changed since X" queries or audit trails.

## Gotchas

1. **Tag case matters.** `approved_tags` is canonical kebab-title-case
   (`Easter-Eggs`). `shopify_tags` is lowercase (`easter-eggs`). A naive
   case-sensitive match against `shopify_tags` will miss things — either
   query `approved_tags` (canonical) or lowercase your filter value.

2. **`variant_skus` is the only valid SKU source.** Don't construct SKUs
   from `design_family` (`AFGF` + body, etc.). We learned this the hard
   way; for non-AF rows and the burlap line, the construction is wrong.
   If `variant_skus` is empty, the row has no Shopify variant data at
   all — most likely an `excluded` orphan you should skip.

3. **`image_url` over reconstruction.** Use the stored Shopify CDN URL.
   The legacy `images.clownantics.com` pattern only works for canonical
   AF SKUs and 404s for everything else.

4. **Empty arrays vs null.** Postgres distinguishes `[]` from `null` on
   these columns. Use `?? []` on the client to handle both.

5. **`design_family` is not necessarily a SKU.** For AF rows it's the
   collapsed canonical key (`AFSP0419`) — the real Shopify SKUs are in
   `variant_skus`. For non-AF rows it usually IS the SKU.

6. **RLS allows public SELECT on `designs`, `taxonomy_entries`, and
   `events`** (and a few others). Inserts/updates require the
   service-role key. Don't try to write from a browser context.

7. **Don't write `excluded` → other status without coordinating.**
   Excluded designs have generally been marked out for a reason
   (accessory, gift card, Shopify-deleted). The af-tag-review UI has
   a per-card ↩ Include button for the legitimate undo case.

## What lives where (mental model)

- **TeamDesk** — source of truth for the FL Themes taxonomy.
  `taxonomy_entries` is a copy synced via a manual refresh button.
- **Shopify** — source of truth for products, variant SKUs, images,
  and live storefront tags. `designs.shopify_*` columns are copies
  synced by a nightly cron + manual button.
- **Supabase** — source of truth for our curation (`approved_tags`,
  `vision_*`, `status`). The push pipeline writes
  `approved_tags` → Shopify on demand.

If you want curated data, query `approved_tags` (it's what we actually
believe). If you want storefront-truth, query `shopify_tags`.
