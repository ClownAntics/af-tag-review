# Tag Review — Developer Guide

Companion docs to [CLAUDE.md](../CLAUDE.md). This file covers the stack, data model, API surface, component layout, and how to extend the app.

See also: [CHANGELOG.md](./CHANGELOG.md) for what's changed and when, and [TAGS_FROM_SUPABASE.md](./TAGS_FROM_SUPABASE.md) for the schema reference if you're building a consumer app that just wants to read tags.

---

## Stack

- **Next.js 16** (App Router, Turbopack in dev, Turbopack or default in prod)
- **React 19**
- **Tailwind v4**
- **Supabase** (Postgres + RLS + auto REST) — **shared** with `af-sales-research`
- **Anthropic SDK** for Claude vision (Sonnet 4.6)
- **TypeScript 5**, ESLint 9 (flat config), `tsx` for Node scripts
- **Vercel** — hosting, env vars, nightly cron job

No state-management library — component-local state + URL/query-param driven.

---

## Data model

Sits on top of the `designs` table seeded by `af-sales-research`. That app's import scripts own the full refresh; this app never writes the core `designs` columns, only the review-pipeline columns added here.

### Shared `designs` columns (from af-sales-research, read-only here)

| column | type | notes |
|---|---|---|
| `design_family` | text PK | `AFSP0001` etc. For AF this is the collapsed canonical key (the real SKUs are in `variant_skus`); for non-AF it usually IS the SKU. |
| `design_name` | text | |
| `product_types` | text[] | `['garden', 'house']` — legacy SKU-pattern-derived. Use `shopify_product_types` instead for the Type filter. |
| `theme_names` / `sub_themes` / `sub_sub_themes` | text[] | Derived from `approved_tags` via `mapTagsToThemes()`. Auto-recomputed in lockstep with any approved_tags mutation. |
| `units_total`, `classification`, `catalog_created_date`, …  | | Sales research fields |
| `has_monogram` / `has_personalized` / `has_preprint` | bool | SKU variant flags |

### Review-pipeline columns (migration 002)

| column | type | notes |
|---|---|---|
| `status` | text (enum) | `novision \| flagged \| pending \| readytosend \| updated \| excluded` (excluded added by 007) |
| `approved_tags` | text[] | Human-curated FL Themes Search Terms. **Canonical kebab-title-case.** |
| `shopify_tags` | text[] | Whatever Shopify currently has live. Lowercased (Shopify normalizes on store). |
| `vision_tags` | text[] | Claude's raw suggestions (flat Search Terms) |
| `vision_tagged_at` / `vision_model` / `vision_raw` | timestamptz / text / jsonb | Vision-run metadata. `vision_raw` = `{primary, decoration[], reasoning, dropped_conflicting?}`. |
| `last_reviewed_at` / `last_pushed_at` | timestamptz | |

### Multi-brand column (migration 003)

| column | type | notes |
|---|---|---|
| `manufacturer` | text | `'AF'`, `'Carson'`, `'Evergreen'`, etc. Auto-discovered from Shopify vendor + normalized in `productToFamily`. |

### Shopify pull columns (migrations 004, 006, 008)

| column | type | notes |
|---|---|---|
| `shopify_product_ids` | bigint[] | Shopify product ids the family aggregates. Used by push to know which products to PUT. Mig 004. |
| `shopify_product_types` | text[] | Shopify's native `product_type` field, aggregated across the family's products. **Source for the Type filter.** Mig 006. |
| `variant_skus` | text[] | Actual SKU strings of every variant across every product. **Source of truth — don't fabricate SKUs from `design_family`.** Mig 008. |
| `image_url` | text | Primary product image URL (Shopify CDN). Preferred over deriving from SKU. Mig 008. |

### Excluded status (migration 007)

Sixth value added to the `designs.status` CHECK constraint: `'excluded'`. Designs in this state sit outside the main review pipeline. Used for accessories (poles, brackets, stakes), gift cards, products with no artwork, and Shopify-deleted orphans. Reversible via the `include` action (back to `novision`).

### First-seen timestamp (migration 009)

| column | type | notes |
|---|---|---|
| `first_seen_at` | timestamptz | When our DB first inserted this row. Distinct from `catalog_created_date` (Shopify's product creation date, which may be years old when shopify-pull first discovers it). Backfilled to `coalesce(catalog_created_date, now())`. Default `now()` on insert. Powers the No-vision tile's "✨ N new in the last 7 days" banner. Index: `idx_designs_first_seen_at`. |

### Sync log table (migration 010)

`shopify_sync_log` — one row per `/api/cron/shopify-sync` run (cron or manual). Best-effort insert (try/catch in the route) so the cron still works if the table doesn't exist yet.

| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `finished_at` | timestamptz | |
| `trigger` | text | `'cron'` (vercel-cron UA) or `'manual'` |
| `products_seen` / `products_matched` / `families` | int | |
| `inserted` / `updated` / `excluded` / `orphans_found` | int | |
| `orphans_skipped_safety` | text | non-null if the 5%/1000-family safety rail tripped |
| `duration_ms` | int | |

Public SELECT via RLS — `/api/sync/last` reads it for the Settings "Last synced X ago" line.

### Taxonomy storage (migration 005)

The taxonomy used to live solely in `lib/taxonomy.json`. Now it's persisted in Supabase so a Settings → Refresh from TeamDesk can rewrite it at runtime:

| table | purpose |
|---|---|
| `taxonomy_entries` | One row per FL Theme entry. Keyed on `td_row_id` (TeamDesk `@row.id`, stable across renames). Holds label / search_term / name / sub_theme / sub_sub_theme / level / season-and-holiday booleans / conflicts_with / parent_ref. |
| `taxonomy_refresh_log` | One row per Apply. `ran_at`, added/removed/renamed counts, designs_flagged_count, designs_renamed_count, was_bootstrap, actor. |

The runtime taxonomy loader is `lib/taxonomy-source.ts#getTaxonomy()` — reads from `taxonomy_entries` if populated, falls back to the baked JSON otherwise. 60s in-memory cache; `invalidateTaxonomyCache()` is called by the apply route.

### Supporting tables

**`events`** — immutable audit log. One row per review action (flag, approve, tag edit, vision completion, push, star, etc). Columns: `id`, `design_family`, `event_type`, `actor`, `timestamp`, `payload` (jsonb). Cascade-deletes when the design row is deleted.

**`vision_prompts`** — versioned prompt templates. `version`, `prompt`, `is_current` (unique where true), `created_at`, `created_by`.

**`design_monthly_sales`** — `design_family × year_month → units`. Populated by `scripts/import-monthly-sales.ts` from the TeamDesk invoice CSV. Feeds the detail-modal bar chart.

### Tag storage convention

All user-facing tags are **flat Search Terms** from FL Themes (e.g. `Cardinals`, `Spring-Flowers`, `Halloween-Pumpkins`). The hierarchy (Name → Sub Theme → Sub Sub Theme) is display-only — the UI lowercases via CSS to match Shopify's convention without mutating storage.

The taxonomy is **baked into `lib/taxonomy.json`** by `scripts/export-taxonomy.ts` (fallback). Live source is `taxonomy_entries` in Supabase, synced from TeamDesk.

**Canonicalization.** `approved_tags` must always be exact-case canonical Search Terms. The Tag filter dropdown's source (`/api/review/filter-options`) maps every observed tag through a case-insensitive / spaces↔hyphens / label-form normalizer against the taxonomy. Anything that doesn't resolve to a canonical term is dropped from the dropdown. `scripts/canonicalize-approved-tags.ts` is the one-off for fixing drift across the whole catalog.

---

## API routes

All under `/api/*`. Grouped by purpose:

### Review pipeline

| Route | Method | Purpose |
|---|---|---|
| `/api/review/counts` | GET | Count per status, filtered by query params |
| `/api/review/queue` | GET | Paginated design list per status, filtered. Special `?sample=N` returns N random rows (keys → shuffle → hydrate; no `ORDER BY random()` in PostgREST). |
| `/api/review/lookup` | GET | SKU or name lookup for the header search box. Name matches return up to 200 (post-200 limit raised for the global-search-as-grid view). |
| `/api/review/filter-options` | GET | Distinct values for all filter dropdowns (60s revalidate). Tag dropdown is canonicalized through the FL Themes taxonomy (case + spaces variants collapse, non-taxonomy noise filtered out). |
| `/api/review/design/[family]` | GET | Monthly sales + events timeline for one design |
| `/api/review/design/[family]/action` | POST | Single mutation endpoint — see Action body shapes below |
| `/api/review/bulk/flag` | POST | Bulk flag by SKU list (`{ skus: string[] }`) |
| `/api/review/bulk-exclude` | GET / POST | GET returns `{count, sample[]}` of designs matching the accessory rule. POST applies (body `{"confirm":"EXCLUDE"}`), writes `bulk_excluded` audit events. |
| `/api/review/new-designs` | GET / POST | GET returns `{count, sample, families}` of `novision` designs added in the last N days (default 7). POST with `{"confirm":"FLAG"}` bulk-flags them (event reason `new_from_shopify_sync`). |
| `/api/review/push` | POST | Push approved_tags to Shopify for `readytosend` designs. Streams NDJSON. Respects URL filter params when no `design_families` array is provided. **Survives client disconnect** — the loop continues server-side even if the browser closes. |
| `/api/review/mistag-audit` | GET | Re-runs vision on N random Updated designs, streams NDJSON comparing each design's fresh primary against its stored `vision_raw.primary`. Read-only — flagging is up to the caller. |
| `/api/review/reset-all` | POST | Nuclear reset: every design → `novision`, then re-pull Shopify. Streams NDJSON. Body must be `{"confirm":"RESET"}`. |

### Vision

| Route | Method | Purpose |
|---|---|---|
| `/api/review/vision/run` | POST | Stream NDJSON per design as Sonnet tags it. Also survives client disconnect. |
| `/api/review/vision/prompt` | GET / POST / DELETE | Load / save / reset the vision prompt |
| `/api/review/vision/debug` | GET | Dump the currently-built system prompt (for HMR debugging) |

### Taxonomy

| Route | Method | Purpose |
|---|---|---|
| `/api/taxonomy` | GET | Serve baked `lib/taxonomy.json` (legacy / unauthenticated reads) |
| `/api/taxonomy/status` | GET | Connection status + entry counts + last_synced_at |
| `/api/taxonomy/refresh?phase=plan\|apply` | POST | Pull current FL Themes from TeamDesk and diff against persisted state |

### Shopify sync (cron + manual)

| Route | Method | Purpose |
|---|---|---|
| `/api/cron/shopify-sync` | GET / POST | The nightly sync. Auth: `Authorization: Bearer $CRON_SECRET`. Mirrors the apply-path of `scripts/shopify-pull.ts`: insert new families, refresh drift, auto-exclude orphans with safety rails (5%/1000-family). Best-effort writes a row to `shopify_sync_log`. |
| `/api/sync/shopify` | POST | Browser-facing proxy for the manual Sync-now button. Adds the `CRON_SECRET` server-side and forwards to the cron route. Browser never plumbs the secret. |
| `/api/sync/last` | GET | Latest `shopify_sync_log` row. Powers the Settings "Last synced X ago" line. Returns `{last: null}` if the table is empty or missing. |

### Filter query params (shared by counts + queue + push)

```
?themeName=<Name>
&subTheme=<Name: Sub>
&subSubTheme=<Name: Sub: SubSub>
&tag=<canonical Search Term>
&productType=<Shopify product_type value, e.g. "Garden Flags">
&manufacturer=<AF|Carson|Evergreen|…>
```

All default to `all` if omitted. Implemented in `lib/review-filters.ts` and applied via `applyReviewFilters(query, filters)`.

The `tag` filter does an OR across three storage forms: `approved_tags` contains the canonical, `shopify_tags` contains the canonical, OR `shopify_tags` contains the Shopify-lowercased form. Designs are findable regardless of where the tag lives.

The push route also reads these params from the URL — `POST /api/review/push?themeName=…&tag=…` scopes the push to the filtered subset when no explicit `design_families` array is in the body.

### Action body shapes

```ts
{ action: "flag" }                              // → flagged. From ready/updated also wipes approved_tags + theme cols.
{ action: "approve", tags?: string[] }          // → readytosend. Trusts client tags; clears vision_tags.
{ action: "update_tags", tags: string[] }       // Stays put, overwrites approved_tags.
{ action: "accept_vision", term: string }       // Promotes one term vision → approved.
{ action: "reject_vision", term: string }       // Removes from BOTH vision_tags AND approved_tags.
{ action: "unflag" }                            // Flagged → novision (preserves prior approved/vision tags).
{ action: "mark_fine" }                         // Novision → readytosend, copies current shopify_tags into approved (refuses if no shopify_product_ids).
{ action: "exclude", reason?: string }          // Any status → excluded. Reversible.
{ action: "include" }                           // Excluded → novision.
{ action: "star" }                              // Add Staff-Pick to approved_tags, → readytosend. Idempotent.
{ action: "unstar" }                            // Remove Staff-Pick from approved_tags, → readytosend.
{ action: "reset" }                             // Any status → novision; wipes approved_tags.
```

**Theme-column lockstep.** Every action that mutates `approved_tags` (approve / update_tags / accept_vision / reject_vision / flag-with-wipe / mark_fine / star / unstar / reset) also recomputes `theme_names` / `sub_themes` / `sub_sub_themes` via `mapTagsToThemes()` in the same patch.

**Streaming routes survive client disconnect.** Push, vision-run, mistag-audit, and reset-all all wrap their `controller.enqueue` calls in try/catch and flip a `clientConnected` flag on `req.signal.abort`. When the browser closes, the loop keeps doing Shopify/Anthropic/Supabase work; the stream just stops emitting. Reload later to see results.

Every action writes an `events` row. Side effects per action are in `app/api/review/design/[design_family]/action/route.ts`.

---

## Component layout

```
app/
  page.tsx                         Single-view client app. Owns detail, prompt-modal, search state.
  layout.tsx                       Metadata, fonts.
  api/cron/shopify-sync/route.ts   Nightly sync. CRON_SECRET-protected.
  api/sync/shopify/route.ts        Manual proxy → cron route.
  api/sync/last/route.ts           Latest sync log row.
  api/review/new-designs/route.ts  "N new since X days" + bulk-flag.
  api/review/mistag-audit/route.ts Re-vision a random Updated sample.

components/
  DesignCard.tsx                   Reused card (image + SKUs + stats). Optional overlay/body-extra slots.
  DetailModal.tsx                  Modal: image, chart, tags, history, flag button.
  SkuSearch.tsx                    Header search. Single-match → modal; multi-match → page-level search-mode.
  SettingsModal.tsx                Taxonomy refresh, Bulk exclude, Sync from Shopify (+ last-synced line), Mistag audit, Reset.
  TagFixing/
    TagFixing.tsx                  Shell — owns tile + filter + counts + searchState. Renders SearchResultsGrid when search active.
    StatusTiles.tsx                6 tile buttons (incl. Excluded).
    FilterBar.tsx                  Cascading filters. Search-as-you-type Combobox replaces native <select>.
    PendingReview.tsx              Two-column review UI. Keyboard shortcuts. Conflict banner.
    TileGrid.tsx                   Flagged / Ready / Updated / Novision / Excluded grid. Bulk-actions menu, Export menu, Random-N sample mode. Per-card Star toggle on Updated.
    CardImageOverlay.tsx           Shared per-card overlay (✓ mark-fine, ⚑ flag, × exclude, ↩ include, ★ star). Imported by TileGrid + SearchResultsGrid.
    TaxonomyTypeahead.tsx          Fuzzy-search 585 Search Terms, keyboard nav, loads /api/taxonomy.
    PasteSkusPanel.tsx             Parse pasted SKU blob → /api/review/bulk/flag.
    VisionPromptModal.tsx          Edit/save/reset the vision prompt.
    KeyboardHelpModal.tsx          `?` shortcut legend.
```

---

## Vision pipeline

Entry point: `/api/review/vision/run` (POST, streams NDJSON).

1. Load current prompt from `vision_prompts` (where `is_current = true`); fall back to `DEFAULT_PROMPT` in `lib/vision-prompt.ts`.
2. `buildSystemPrompt()` (in `lib/vision.ts`) injects the full taxonomy text into `{{taxonomy}}`.
3. Per design, call Sonnet with: cached system prompt + user message (image URL + "tag this").
4. Parse the JSON response, validate terms against the taxonomy, run `filterConflictingDecoration` (drops decoration tags whose level-2 ancestor is a sibling of the primary's level-2 — see below), dedup against existing `approved_tags`, run `expandToIncludeAncestors` to fill in Level-2/Level-1 parents.
5. Write `vision_tags` + metadata, move design to `pending`, log `vision_completed` event.
6. Emit NDJSON progress event per design.

### Cross-occasion guard

`lib/vision.ts#filterConflictingDecoration` runs before ancestor expansion. Drops any decoration term whose level-2 sub differs from the primary's level-2 sub under the same level-1 theme. E.g., on a `Mardi-Gras` design (`Seasonal: Mardi Gras`), decoration `Fireworks` (`Seasonal: 4th of July: Fireworks`) gets dropped — different sub under the same `Seasonal` umbrella. Decorations under a different level-1 entirely (`Birds: Cardinals` on a Christmas flag) still pass through. Dropped terms are surfaced in `vision_raw.dropped_conflicting` for audit.

### Concurrency

3 in the API route (Sonnet rate limits). The CLI script `scripts/tag-with-vision.ts` defaults to 5 with SDK retries.

### Debugging prompts

Hit `/api/review/vision/debug` — returns the actual assembled system prompt. Useful when Turbopack HMR fails to pick up `lib/vision-prompt.ts` edits.

---

## Shopify integration

### Pull (`scripts/shopify-pull.ts` + `/api/cron/shopify-sync`)

The CLI script and the cron route share the apply-path logic (currently duplicated; a `lib/shopify-sync.ts` extraction is on the TODO list). Steps:

1. Stream products from Shopify Admin REST (`status=active,archived`, paginated via Link header)
2. Group variants by `design_family` via `productToFamily()` in `lib/shopify.ts`
3. Diff against current DB state
4. INSERT new families as `novision` (first_seen_at defaults to NOW())
5. UPDATE existing families whose `shopify_tags` / `shopify_product_ids` / `shopify_product_types` / `variant_skus` / `image_url` drifted
6. **Orphan detection.** Designs whose `shopify_product_ids` no longer overlap with any current Shopify product get auto-moved to `excluded` with `reason: shopify_deleted`. Safety rails: skip the orphan check entirely if the pull saw < 1000 families (likely pagination failure), and cap auto-exclusions at max(50, 5% of catalog) to prevent runaway mass-exclusion.

### Push (`/api/review/push` + `scripts/shopify-push.ts`)

For each design in `readytosend` (filtered by URL params if provided):

1. Read `approved_tags` and `shopify_product_ids`
2. Skip if no product_ids (no-op event written)
3. Skip if approved_tags empty (no-op event written)
4. For each product_id, PUT `/products/{id}.json` with `tags: approved_tags.join(", ")` (parallel within a family)
5. On success: status → `updated`, `last_pushed_at` set, `shopify_tags` updated to match approved_tags, `pushed` event
6. On failure: `push_failed` event with the failed product_ids and Shopify's error message

Rate limit: ~2 req/sec on REST. Big batches hit Vercel's 5-min function cap around 300+ designs.

### AF SKU collapse

`lib/shopify.ts#skuToAfDesignFamily` maps AF variant SKUs like `AFGFSP0419` (garden), `AFHFSP0419` (house), `AFDRSP0419` (doormat), `AFMC SP0419` (mailbox cover), etc. to a single canonical key `AFSP0419`. The regex accepts a permissive suffix grammar to catch personalization variants:

```
/^AF(?:GF|HF|GB|DR|MC)([A-Z]{2}\d{4})(?:-[A-Z]{1,3}|[A-Z]{1,2})?$/
```

Matches `-CF` (custom field), `-CG` (custom greeting), `-CD` (custom doormat), `WH` (preprint), single monogram letters A-Z, and any future variant marker without a code change. Case-insensitive on the SKU (handles `AFhFSP0677` lowercase-h variants).

Non-AF manufacturers (Carson, Evergreen, etc.) are one-row-per-product — `design_family` IS the variant SKU.

### No SKU fabrication

`lib/product-image.ts` reads `variant_skus` + `image_url` verbatim. Empty `variant_skus` falls back to `design_family`, never to a constructed `AFGF{body}` string. Old code synthesized SKUs from `design_family` and produced bogus values like `AFGFCA52602` for Carson rows and `AFGFafgfwr-b-0004` for the burlap line. Don't bring it back.

---

## Running locally

```bash
npm install
cp .env.example .env.local       # fill in values (Supabase URL/keys + ANTHROPIC_API_KEY)
npm run dev                      # http://localhost:3000
```

Restart the dev server after editing `.env.local` — Next.js loads env at boot only.

## Running scripts

```bash
# Taxonomy + sales
npx tsx scripts/export-taxonomy.ts            # rebake lib/taxonomy.json from FL Themes CSV
npx tsx scripts/import-monthly-sales.ts       # populate design_monthly_sales from TeamDesk invoice CSV

# Vision
npx tsx scripts/tag-with-vision.ts            # batch vision-tag every design (CLI, bypasses UI)
npx tsx scripts/vision-diff.ts                # export Shopify vs vision CSV for eyeball diff
npx tsx scripts/backfill-conflicting-decoration.ts          # dry-run
npx tsx scripts/backfill-conflicting-decoration.ts --apply  # apply filterConflictingDecoration to existing vision_tags

# Shopify sync
npx tsx scripts/shopify-pull.ts               # dry-run diff
npx tsx scripts/shopify-pull.ts --apply       # insert/update/auto-exclude-orphans
npx tsx scripts/shopify-push.ts               # push approved_tags to Shopify (CLI alternative to the UI button)

# Curation cleanup (one-offs)
npx tsx scripts/canonicalize-approved-tags.ts             # dry-run
npx tsx scripts/canonicalize-approved-tags.ts --apply     # canonicalize case/format mismatches in approved_tags
npx tsx scripts/consolidate-design-families.ts            # dry-run
npx tsx scripts/consolidate-design-families.ts --apply    # merge duplicate AF design rows from case-sensitive parser bugs
npx tsx scripts/backfill-theme-columns.ts --apply         # repair theme_names/sub_themes drift on existing rows
npx tsx scripts/reset-readytosend.ts --apply              # move every ready-to-send back to novision
npx tsx scripts/export-ev-product-types.ts                # CSV of products with misconfigured Shopify product_type
npx tsx scripts/audit-non-taxonomy-tags.ts                # find shopify_tags that aren't in FL Themes
npx tsx scripts/audit-not-on-jf.ts                        # find designs without shopify_product_ids
npx tsx scripts/export-non-taxonomy-tags.ts               # CSV of non-taxonomy tags for cleanup
npx tsx scripts/strip-blacklist-tags.ts                   # remove blacklisted tags from all designs
```

All scripts use `_supabase-admin.ts` (service-role key, bypasses RLS). `shopify-pull.ts` retries transient errors up to 4 times with exponential backoff before failing. Re-runs are idempotent — drift detection at the top of the update loop skips rows already in sync.

## Deploy (Vercel)

- Vercel project is linked to `ClownAntics/af-tag-review`. Auto-deploys on push to `main`.
- Live URL: `https://af-tag-review.vercel.app`
- Nightly cron at `0 7 * * *` (3am ET) runs `/api/cron/shopify-sync` — configured in `vercel.json`.

### Env vars

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL (public, OK to ship to client) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Anon key (public, RLS-scoped) |
| `SUPABASE_SERVICE_ROLE_KEY` | **Server-only.** Bypasses RLS — never put in `NEXT_PUBLIC_*` |
| `ANTHROPIC_API_KEY` | Claude vision (`claude-sonnet-4-6`) |
| `SHOPIFY_STORE` | The shop subdomain, e.g. `justforfunflags` |
| `SHOPIFY_ADMIN_TOKEN` | `shpat_*` admin-API token. Used by push + pull. |
| `TEAMDESK_API_TOKEN` | Read-only token for FL Themes table. **Use a dedicated token, not Blake's personal one.** |
| `TEAMDESK_ACCOUNT` | Subdomain, e.g. `clownantics` for `clownantics.teamdesk.net` |
| `TEAMDESK_DB_ID` | Numeric database id (`27503` for ClownAntics) |
| `TEAMDESK_TABLE_ID` | FL Themes table alias (`t_236519`) or numeric id |
| `TEAMDESK_VIEW_URL` | Browser URL for the FL Themes view — powers the "Source" link and "Open ↗" button in Settings |
| `CRON_SECRET` | Random string. Vercel cron sends this in `Authorization: Bearer …`; `/api/sync/shopify` proxies it server-side so the browser doesn't need it. |

Mirror everything into `.env.local` for local dev. `.env*` is gitignored.

---

## Extending

### Adding another brand / product type
1. Run `supabase/migrations/003_manufacturer.sql` (already done — establishes the column).
2. Extend your catalog ingestion to set `manufacturer` explicitly on each row.
3. Manufacturer values auto-appear in the filter dropdown via `/api/review/filter-options`.

### Adding a new review action
1. Add a new entry to the `Body` union at the top of `app/api/review/design/[design_family]/action/route.ts`.
2. Add a new case in the switch with the patch + event_type.
3. Add a label for it in `components/DetailModal.tsx`'s `eventLabel()`.
4. Wire UI button/interaction from `CardImageOverlay.tsx` (if it needs a per-card affordance) or wherever.
5. If it's bulk-able, add an entry to `BULK_ACTIONS` in `TileGrid.tsx`.

### Adding a new filter dimension
1. Add the field to `ReviewFilters` in `lib/types.ts` and to `EMPTY_REVIEW_FILTERS`.
2. Update `parseFiltersFromSearch` + `applyReviewFilters` + `toQueryString` in `lib/review-filters.ts`.
3. Add the dropdown to `components/TagFixing/FilterBar.tsx` (the `Combobox` component will handle it — same shape as the others).
4. Update `/api/review/filter-options` to surface distinct values.

### Changing the vision model / prompt
- **Model:** `VISION_MODEL` constant in `lib/vision.ts`.
- **Default prompt:** `DEFAULT_PROMPT` in `lib/vision-prompt.ts`.
- **Live prompt:** stored in `vision_prompts`, edited via the Edit-vision-prompt modal.

### Sharing logic between cron + CLI
The Shopify-sync apply path currently lives in both `scripts/shopify-pull.ts` (CLI) and `app/api/cron/shopify-sync/route.ts` (cron). Refactoring into a single `lib/shopify-sync.ts` is on the TODO list. Inline duplication is acceptable for now but bug fixes need to land in both places.

---

## Supabase RLS

Migration 002 + 010 allows:
- Public SELECT on `designs`, `events`, `vision_prompts`, `design_monthly_sales`, `taxonomy_entries`, `shopify_sync_log`
- Anon INSERT on `events`
- Anon UPDATE on `designs` (for the review UI's direct writes)

This is pre-auth MVP territory — tighten before going multi-user. When auth lands, replace `actor = 'blake'` in the action route with the real user identity.

---

## Known gotchas

- **`variant_skus` is the source of truth for SKUs.** Don't reconstruct them from `design_family` (`AFGF` + body, etc.). For non-AF rows and non-standard AF SKUs (burlap line `afgfwr-b-0004`), the construction is wrong and 404s the image CDN. See `lib/product-image.ts` — the fabrication path is gone for a reason.
- **`approved_tags` is case-sensitive canonical.** The Tag filter dropdown source canonicalizes case + spaces/hyphens variants on read, but stored `approved_tags` must be exact-case Search Terms (`Easter-Eggs`, not `easter-eggs`). Curation enforces this via the typeahead; bulk scripts must too.
- **`shopify_tags` is Shopify-lowercased.** When you push `Easter-Eggs`, Shopify stores `easter-eggs`. The tag filter's OR clause handles both forms.
- **Streaming routes ignore client disconnect by design.** Push/vision-run/mistag-audit/reset-all all set `clientConnected = false` on `req.signal.abort` but keep the loop running. If you add a new streaming route, mirror the pattern in `app/api/review/push/route.ts` (try/catch around `controller.enqueue`, listen for the abort signal, swallow the "already closed" on `controller.close()`).
- **Tags are case-sensitive at storage but lowercase in display.** Storage uses the FL Themes CSV's canonical Search Term (often TitleCase or hyphenated); the UI CSS-lowercases on render. Approve-time merge preserves storage case.
- **Dev server needs a restart to pick up `.env.local` changes.** Next.js loads env at boot.
- **Dropbox + Next.js:** `.next/` and `node_modules/` should be marked Dropbox-ignored (`Set-Content -Path <dir> -Stream com.dropbox.ignored -Value 1` in PowerShell) to prevent EPERM errors mid-build.
- **Windows taskkill /F is in the `.claude/settings.json` deny list** as a safety rail. If dev server won't die on Ctrl+C, you can kill from within PowerShell directly.
- **TeamDesk REST: `/-/` in the URL means cookie auth.** The in-browser Playground generates URLs like `/secure/api/v2/<dbid>/-/<table>/select.json` because it uses the user's session cookie. With a `/-/` present, TeamDesk **ignores the Bearer header** and falls through to cookie auth, then 403s when no session exists. URL form for token auth is `…/secure/api/v2/<dbid>/<table>/select.json` (no `/-/`). Auth header: `Authorization: Bearer <token>` (Bearer prefix required).
- **TeamDesk tokens are database-scoped.** Generate the API token while you're inside the ClownAntics DB (URL bar shows `/db/27503/`), otherwise it auths against a different DB and you get 403.
- **SSR hydration mismatch (React #418) from `localStorage` reads.** Don't read `localStorage` in `useState` initializers — the server-side prerender returns the fallback and the client returns the stored value, producing different initial HTML. Use a stable initial value + `useEffect` to hydrate after mount.
- **Type filter dropdown previously listed the SKU-pattern column** (`product_types` with values "garden"/"house"). It now uses `shopify_product_types` (Shopify's real categories). Both columns still exist; the SKU-pattern one is retained for `lib/product-image.ts`'s `garden-banner` check.
- **`shopify-pull.ts` is the source of truth for `variant_skus` + `image_url`.** Don't try to derive these from SKU patterns. The legacy derivation in `lib/product-image.ts` is a last-resort fallback for pre-migration rows.
- **PostgREST has no `ORDER BY random()`.** The `?sample=N` queue endpoint does keys-only → JS Fisher-Yates → hydrate-by-`in()`. If you need true server-side random for larger samples, add an RPC.
- **The CRON_SECRET must be set in Vercel env vars before the cron fires** for the first time. `/api/sync/shopify` will return a 500 ("CRON_SECRET not set") if the proxy can't auth to the cron route. Set it in Vercel → Settings → Environment Variables, then redeploy.
