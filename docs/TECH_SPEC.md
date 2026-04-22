# Tag Review — Tech Spec (for Dinesh)

Scope: the data integration layer. What flows in, what flows out, what you own, where the bodies are buried. Read [HANDOFF.md](./HANDOFF.md) first for the product overview.

---

## System diagram

```
                  ┌─────────────────────────┐
                  │       TeamDesk          │
                  │  (source of truth for   │
                  │   catalog + invoices    │
                  │   + FL Themes)          │
                  └─────────────┬───────────┘
                                │ manual CSV export
                                ▼
       ┌────────────── 4 CSV files (.../202604 AF Research App/) ──────────────┐
       │  Products_AF Image Review Export.csv   ← catalog                      │
       │  Invoice Line Items_AF ….csv           ← sales                        │
       │  JF Tag Export.csv                     ← Shopify tags snapshot        │
       │  FL Themes_zz Export View.csv          ← taxonomy                     │
       └───────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   │ npx tsx scripts/*.ts
                                   ▼
                  ┌─────────────────────────────────────┐
                  │        Supabase (Postgres)          │
                  │   designs, events,                  │
                  │   vision_prompts                    │
                  └──┬────────────────────────────┬─────┘
                     │                            │
                     │ read                       │ read/write
                     │                            ▼
                     │              ┌─────────────────────────────┐
                     │              │  Tag Review web app         │
                     │              │  (Next.js on Vercel)        │
                     │              │  + Claude Sonnet 4.6        │
                     │              └────────┬────────────────────┘
                     │                       │
                     ▼                       │ shopify-push.ts
       ┌──────────────────────┐              │ (Admin API)
       │  af-sales-research   │              ▼
       │  (read-only on       │    ┌─────────────────────┐
       │   designs + sales)   │    │  JustForFun         │
       └──────────────────────┘    │  Shopify admin      │
                                   │  (product tags live)│
                                   └─────────────────────┘
```

Two separate Vercel deploys, one Supabase project, one Anthropic key. Sales research reads; Tag Review writes review-pipeline columns + eventually syncs tags back to Shopify.

---

## Supabase schema

Single project shared with `af-sales-research`. All migrations live in `supabase/migrations/` and are idempotent — run in order. Current head is migration 004.

### `designs` (PK `design_family`)

| Column | Type | Owner | Notes |
|---|---|---|---|
| `design_family` | text PK | AF Research | `AFSP0278`-style code |
| `design_name` | text | AF Research | |
| `product_types` | text[] | AF Research | `['garden','house']` |
| `shopify_tags` | text[] | Tag Review (via shopify-pull) | Live Shopify tags snapshot |
| `theme_names`/`sub_themes`/`sub_sub_themes` | text[] | AF Research | Derived hierarchical from shopify_tags |
| `units_total`, `units_*`, `first_sale_date`, `last_sale_date`, `classification` | | AF Research | Sales data |
| `catalog_created_date`, `is_active`, `theme_code`, `sku_number` | | AF Research | |
| `has_monogram`/`has_personalized`/`has_preprint` | bool | AF Research | |
| `monthly_sales` | jsonb | Tag Review (import-monthly-sales) | `[{m:"YYYY-MM", u:int}]` — powers DetailModal chart |
| `status` | text | Tag Review | `novision \| flagged \| pending \| readytosend \| updated` |
| `approved_tags` | text[] | Tag Review | Human-curated Search Terms — SOURCE OF TRUTH for push |
| `vision_tags` | text[] | Tag Review | Claude's raw suggestions |
| `vision_raw` | jsonb | Tag Review | `{primary, reasoning, tags}` from last run |
| `vision_tagged_at`, `vision_model` | | Tag Review | |
| `last_reviewed_at`, `last_pushed_at` | timestamptz | Tag Review | |
| `manufacturer` | text | Tag Review (migration 003) | `'AF'` today; multi-brand future |
| `shopify_product_ids` | bigint[] | Tag Review (migration 004) | Product IDs that share this design_family; populated by `shopify-pull.ts`, read by `shopify-push.ts` |

### Other tables owned by Tag Review

- **`events`** — immutable audit log. One row per flag/approve/tag-edit/vision-completion/push. Columns: `id`, `design_family`, `event_type`, `actor`, `timestamp`, `payload` (jsonb).
- **`vision_prompts`** — versioned Claude prompt templates. `is_current` boolean (unique partial index enforces one current row).
- **`sku_variants`** — AF Research's per-SKU detail (variant_type, product_type). Tag Review reads, never writes.

### RLS (migration 002)

- SELECT on everything: anon + authenticated
- UPDATE on `designs`: anon + authenticated (pre-auth MVP — tighten later)
- INSERT on `events`: anon + authenticated
- Service-role key bypasses all policies — use via `lib/supabase-admin.ts` / `scripts/_supabase-admin.ts` for server-side bulk work

---

## Source systems

### TeamDesk (CSV exports, manual cadence)

The 4 CSVs live at `…/202604 AF Research App/` on Blake's Dropbox. Exported by hand from TeamDesk ~every 2 weeks. Column headers are SOURCE OF TRUTH for the importers — if TeamDesk renames a column, importers silently skip those rows.

| CSV | Consumer | Trigger |
|---|---|---|
| `Products_AF Image Review Export.csv` | `af-sales-research/scripts/import-catalog.ts` | New SKUs added to TeamDesk |
| `Invoice Line Items_AF Image Review Export.csv` | `af-sales-research/scripts/import-teamdesk.ts` + `import-monthly-sales.ts` | New sales since last run |
| `JF Tag Export.csv` | `af-sales-research/scripts/import-jf-tags.ts` | Legacy; being replaced by live `shopify-pull.ts` |
| `FL Themes_zz Export View.csv` | `af-sales-research/scripts/import-themes.ts` + `scripts/export-taxonomy.ts` | FL Themes taxonomy edits in TeamDesk |

### Shopify (JustForFun store, live API)

- Auth: custom app Admin API access token, `shpat_*` format, stored as `SHOPIFY_ADMIN_TOKEN`
- Scope required: `read_products`, `write_products`
- Store handle: `SHOPIFY_STORE=justforfunflags`
- API version: `2025-01` (in `lib/shopify.ts`)
- Headers: `X-Shopify-Access-Token: <token>`

Read path: `scripts/shopify-pull.ts` → `lib/shopify.ts#listProducts` (cursor pagination, all active + archived).

Write path: `scripts/shopify-push.ts` → `lib/shopify.ts` (per-product tag PATCH). **Not yet wired to the UI push button** — today it's CLI-only.

### Anthropic (Claude vision)

- Model: `claude-sonnet-4-6` (constant in `lib/vision.ts`)
- Auth: `ANTHROPIC_API_KEY`
- Entry from UI: `POST /api/review/vision/run` — streams NDJSON, concurrency 3
- Entry from CLI: `scripts/tag-with-vision.ts` — concurrency 5, SDK retries on 429
- Cost: ~$0.006/design at Sonnet rates (was $0.002 on Haiku 4.5; switched up for quality)

---

## Script inventory

All scripts under `scripts/`. Run via `npx tsx scripts/<name>.ts` from the Tag Review folder. All use `_supabase-admin.ts` (service role, bypasses RLS).

| Script | Purpose | Cadence | Destructive? |
|---|---|---|---|
| `shopify-pull.ts` | Fetch all JFF products, populate `shopify_product_ids` + update `shopify_tags`; insert new families as novision | Weekly or on demand. Dry-run default, `--apply` writes | Touches `shopify_tags`, `shopify_product_ids`; never approved_tags or review-pipeline fields |
| `shopify-push.ts` | Read readytosend designs, push `approved_tags` → Shopify (preserving admin tags per-product) | Triggered by UI button (not yet wired) or CLI on demand | Writes to Shopify; status → updated on success |
| `import-monthly-sales.ts` | Aggregate invoice CSV → `designs.monthly_sales` jsonb | After every TeamDesk refresh | Overwrites `monthly_sales` column |
| `export-taxonomy.ts` | Bake FL Themes CSV → `lib/taxonomy.json` | After FL Themes edits in TeamDesk | File-system only (JSON ships with app) |
| `tag-with-vision.ts` | Batch Claude vision run (legacy; CLI-only, produces old hierarchical schema) | On demand for bulk | Writes `vision_theme_names`/`vision_sub_themes`/`vision_sub_sub_themes` (legacy) |
| `vision-diff.ts` | Export CSV of Shopify-vs-vision tags for bulk eyeballing | Ad-hoc QA | Read-only |

---

## What Dinesh owns

### 1. Scheduled Shopify pull
Today `shopify-pull.ts` is a manual CLI run. Needs to run on a schedule so new products added in Shopify auto-appear in Tag Review as `novision` and existing products' `shopify_tags` stays fresh.

Options:
- **GitHub Actions cron** on the repo — simplest, free, runs on schedule with the repo's env var secrets
- **Vercel cron** — separate endpoint `/api/cron/shopify-pull` protected by a shared secret
- **Supabase edge function** with scheduled trigger — Postgres-adjacent, but we'd need to reimplement the logic in Deno

Recommendation: GitHub Actions weekly.

### 2. Shopify push wiring
The `↑ Push N to Shopify →` button in Ready-to-send tile is currently disabled. Needs to:
1. POST to a new `/api/review/shopify/push` route with the list of design_families
2. That route streams NDJSON per design (same shape as vision/run) so the UI can show progress
3. Server-side calls `lib/shopify.ts` to update tags per product
4. Preserves non-theme tags per product (admin tags like `in-stock`, `IncludeInPromotions`, `flag-type-garden` vs `flag-type-house`)
5. On success: `status → updated`, `last_pushed_at` stamped, event logged

The logic in `scripts/shopify-push.ts` is the reference implementation. Need to refactor the reusable bits into a server-side lib function so both the CLI and API share it.

### 3. TeamDesk refresh automation (stretch)
Today Blake manually exports 4 CSVs from TeamDesk every ~2 weeks. TeamDesk has an API (or at least scheduled exports). Ideal: daily auto-refresh of the 4 CSVs, triggered import. Out of scope for the MVP but worth scoping once the manual cadence becomes painful.

### 4. Taxonomy resilience
FL Themes CSV format has specific column expectations (Search Term, Name, Sub Theme, Sub Sub Theme, Level, ConflictsWith). If TeamDesk renames a column the scripts silently skip rows. Either:
- Add a schema-check at the top of `export-taxonomy.ts` that fails loud if required columns missing
- Or ship an in-app health check that counts loaded taxonomy entries and alerts if it drops below threshold

### 5. Operational monitoring
- Rate-limit handling during vision runs (current: SDK retries + concurrency 3)
- Shopify API error handling (their 429 is real — backoff + retry with jitter)
- Event-log querying for "what happened?" forensics — consider a small admin UI or a Supabase SQL snippet library

---

## Env vars (recap)

```
# Supabase (shared with af-sales-research)
NEXT_PUBLIC_SUPABASE_URL=https://<project>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_...
SUPABASE_SERVICE_ROLE_KEY=sb_secret_...     # server-side only

# Claude vision
ANTHROPIC_API_KEY=sk-ant-...

# Shopify (for pull/push)
SHOPIFY_STORE=justforfunflags
SHOPIFY_ADMIN_TOKEN=shpat_...                # write_products + read_products scope
```

Same four vars on Vercel dashboard for the deployed app. Never put service-role or Anthropic key in a `NEXT_PUBLIC_*` variable.

---

## Open decisions / questions for Dinesh

1. **Push authorization** — today anon can hit `/api/review/design/*/action` which includes `approve`. After Phase 6 lands, `/api/review/shopify/push` will be anon-writable too unless we gate it. Plan for even a simple shared secret before the button goes live in production.
2. **Shopify product ID mapping** — garden and house variants of the same AF design are currently separate Shopify products sharing the same `design_family` via the SKU pattern. `shopify_product_ids` stores all of them. What happens when a non-AF brand has 1 product per design_family? Currently the array just has 1 entry — that's fine. Worth documenting when the multi-brand work lands.
3. **Archived products** — `shopify-pull.ts` includes archived products. Push should probably skip them (don't rewrite tags on products that aren't live). Worth a flag.
4. **Concurrency during push** — Shopify Admin API rate limit is 2 requests/sec on standard plans, 40/sec on Plus. Check JFF's plan and set concurrency accordingly in the push script.
5. **Failure recovery** — if `shopify-push.ts` fails mid-batch, some designs went `readytosend → updated` and some didn't. Script needs to be idempotent: re-running should pick up where it left off by reading status.

---

## Quick-start for Dinesh

```bash
cd "C:\Users\gbcab\ClownAntics Dropbox\Blake Cabot\Docs\Internet Business\200904 Clown\202604 FL Tag Review"
npm install
cp .env.example .env.local       # fill in values from Blake
npm run dev                       # http://localhost:3000

# Then exercise the data scripts:
npx tsx scripts/shopify-pull.ts --limit 20   # smoke test, dry-run
npx tsx scripts/export-taxonomy.ts
npx tsx scripts/import-monthly-sales.ts
```

Read [HANDOFF.md](./HANDOFF.md) for product context. Read [DEVELOPER.md](./DEVELOPER.md) for deeper code-level architecture.

Questions → Blake.
