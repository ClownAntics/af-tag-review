# Tag Review — Developer Guide

Companion docs to [CLAUDE.md](../CLAUDE.md). This file covers the stack, data model, API surface, component layout, and how to extend the app.

See also: [CHANGELOG.md](./CHANGELOG.md) for what's changed and when.

---

## Stack

- **Next.js 16** (App Router, Turbopack in dev, Turbopack or default in prod)
- **React 19**
- **Tailwind v4**
- **Supabase** (Postgres + RLS + auto REST) — **shared** with `af-sales-research`
- **Anthropic SDK** for Claude vision
- **TypeScript 5**, ESLint 9 (flat config), `tsx` for Node scripts

No state-management library — component-local state + URL/query-param driven.

---

## Data model

Sits on top of the `designs` table seeded by `af-sales-research`. That app's import scripts own the full refresh; this app never writes the core `designs` columns, only the review-pipeline columns added here.

### Shared `designs` columns (from af-sales-research, read-only here)

| column | type | notes |
|---|---|---|
| `design_family` | text PK | `AFSP0001` etc. |
| `design_name` | text | |
| `product_types` | text[] | `['garden', 'house']` |
| `shopify_tags` | text[] | Raw Shopify tags (messy, reference only) |
| `theme_names` / `sub_themes` / `sub_sub_themes` | text[] | Derived from shopify_tags via FL Themes |
| `units_total`, `classification`, `catalog_created_date`, …  | | Sales research fields |
| `has_monogram` / `has_personalized` / `has_preprint` | bool | SKU variant flags |

### Review-pipeline columns (migration 002)

| column | type | notes |
|---|---|---|
| `status` | text (enum) | `novision \| flagged \| pending \| readytosend \| updated \| excluded` (excluded added by 007) |
| `approved_tags` | text[] | Human-curated Search Terms |
| `vision_tags` | text[] | Claude's raw suggestions (flat Search Terms) |
| `vision_theme_names` / `_sub_themes` / `_sub_sub_themes` | text[] | Legacy hierarchical vision output — kept for historical diff |
| `vision_tagged_at` / `vision_model` / `vision_raw` | timestamptz / text / jsonb | Vision-run metadata |
| `last_reviewed_at` / `last_pushed_at` | timestamptz | |

### Multi-brand column (migration 003)

| column | type | notes |
|---|---|---|
| `manufacturer` | text | `'AF'` for the initial AF designs; `'Carson'`, `'Evergreen'`, etc. for other brands. Auto-discovered from Shopify vendor + normalized in `productToFamily`. |

### Shopify pull columns (migrations 004, 006, 008)

| column | type | notes |
|---|---|---|
| `shopify_product_ids` | bigint[] | Shopify product ids the family aggregates. Used by push to know which products to PUT. Mig 004. |
| `shopify_product_types` | text[] | Shopify's native `product_type` field, aggregated across the family's products. **Source for the Type filter.** Mig 006. |
| `variant_skus` | text[] | Actual SKU strings of every variant across every product. Display source of truth — preferred over deriving SKUs from a regex. Mig 008. |
| `image_url` | text | Primary product image URL (Shopify CDN). Preferred over deriving from SKU. Mig 008 backfills via `shopify-pull.ts`. |

### Excluded status (migration 007)

Sixth value added to the `designs.status` CHECK constraint: `'excluded'`. Designs in this state sit outside the main review pipeline. Used for accessories (poles, brackets, stakes), gift cards, and products with no artwork. Reversible via the `include` action (back to `novision`).

### Taxonomy storage (migration 005)

The taxonomy used to live solely in `lib/taxonomy.json`. Now it can also be persisted in Supabase so a Settings → Refresh from TeamDesk can rewrite it at runtime:

| table | purpose |
|---|---|
| `taxonomy_entries` | One row per FL Theme entry. Keyed on `td_row_id` (TeamDesk `@row.id`, stable across renames). Holds label / search_term / name / sub_theme / sub_sub_theme / level / season-and-holiday booleans / conflicts_with / parent_ref. |
| `taxonomy_refresh_log` | One row per Apply. `ran_at`, added/removed/renamed counts, designs_flagged_count, designs_renamed_count, was_bootstrap, actor. |

The runtime taxonomy loader is `lib/taxonomy-source.ts#getTaxonomy()` — reads from `taxonomy_entries` if populated, falls back to the baked JSON otherwise. 60s in-memory cache; `invalidateTaxonomyCache()` is called by the apply route.

### Supporting tables

**`events`** — immutable audit log. One row per review action (flag, approve, tag edit, vision completion, push, etc). Columns: `id`, `design_family`, `event_type`, `actor`, `timestamp`, `payload` (jsonb).

**`vision_prompts`** — versioned prompt templates. `version`, `prompt`, `is_current` (unique where true), `created_at`, `created_by`.

**`design_monthly_sales`** — `design_family × year_month → units`. Populated by `scripts/import-monthly-sales.ts` from the TeamDesk invoice CSV. Feeds the detail-modal bar chart.

### Tag storage convention

All user-facing tags are **flat Search Terms** from FL Themes (e.g. `Cardinals`, `Spring-Flowers`, `Halloween-Pumpkins`). The hierarchy (Name → Sub Theme → Sub Sub Theme) is display-only — the UI lowercases via CSS to match Shopify's convention without mutating storage.

The taxonomy is **baked into `lib/taxonomy.json`** by `scripts/export-taxonomy.ts`. Ships with the app so Vercel has no file dependency. Re-run the script when FL Themes changes in TeamDesk.

---

## API routes

All under `/api/review/*` plus `/api/taxonomy/*`.

| Route | Method | Purpose |
|---|---|---|
| `/api/review/counts` | GET | Count per status, filtered by query params |
| `/api/review/queue` | GET | Paginated design list per status, filtered |
| `/api/review/lookup` | GET | SKU or name lookup for the header search box |
| `/api/review/filter-options` | GET | Distinct values for all filter dropdowns (60s revalidate). Strips `^EV\d+$` garbage from `shopify_product_types`. |
| `/api/review/design/[family]` | GET | Monthly sales + events timeline for one design |
| `/api/review/design/[family]/action` | POST | Single mutation endpoint — see Action body shapes below |
| `/api/review/bulk/flag` | POST | Bulk flag by SKU list (`{ skus: string[] }`) |
| `/api/review/vision/run` | POST | Stream NDJSON per design as Sonnet tags it |
| `/api/review/vision/prompt` | GET / POST / DELETE | Load / save / reset the vision prompt |
| `/api/review/vision/debug` | GET | Dump the currently-built system prompt (for HMR debugging) |
| `/api/review/push` | POST | Push approved_tags to Shopify for `readytosend` designs. Streams NDJSON. Respects URL filter params when no `design_families` array is provided. |
| `/api/review/reset-all` | POST | Nuclear reset: every design → `novision`, then re-pull Shopify. Streams NDJSON. Body must be `{"confirm":"RESET"}`. |
| `/api/review/bulk-exclude` | GET / POST | GET returns `{count, sample[]}` of designs matching the accessory rule. POST applies (body `{"confirm":"EXCLUDE"}`), writes `bulk_excluded` audit events per design. |
| `/api/taxonomy` | GET | Serve baked `lib/taxonomy.json` (legacy / unauthenticated reads) |
| `/api/taxonomy/status` | GET | Connection status + entry counts + last_synced_at. Powers the Settings → Taxonomy info panel. |
| `/api/taxonomy/refresh?phase=plan\|apply` | POST | Pull current FL Themes from TeamDesk and diff against persisted state. Plan returns the diff; apply (when wired) writes to `taxonomy_entries` and migrates affected designs. |

### Filter query params (shared by counts + queue + push)

```
?themeName=<Name>
&subTheme=<Name: Sub>
&subSubTheme=<Name: Sub: SubSub>
&tag=<shopify-tag>
&productType=<Shopify product_type value, e.g. "Garden Flags">
&manufacturer=<AF|Carson|Evergreen|…>
```

All default to `all` if omitted. Implemented in `lib/review-filters.ts` and applied via `applyReviewFilters(query, filters)`.

The `productType` clause `.contains("shopify_product_types", [filters.productType])` — uses the Shopify-pulled `shopify_product_types` text[] column, not the legacy `product_types`. The Type filter dropdown shows values from `shopify_product_types` (post `EV\d+` filtering).

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
{ action: "reset" }                             // Any status → novision; wipes approved_tags.
```

**Theme-column lockstep.** Every action that mutates `approved_tags` (approve / update_tags / accept_vision / reject_vision / flag-with-wipe / mark_fine / reset) also recomputes `theme_names` / `sub_themes` / `sub_sub_themes` via `mapTagsToThemes()` in the same patch. This eliminates the bug where the slow-path Approve flow left derived theme columns stale and the Theme filter under-reported.

Every action writes an `events` row. Side effects per action are in `app/api/review/design/[design_family]/action/route.ts`.

---

## Component layout

```
app/
  page.tsx                         Single-view client app. Owns detail + prompt-modal state.
  layout.tsx                       Metadata, fonts.

components/
  DesignCard.tsx                   Reused card (image + SKUs + stats). Optional slots for overlays + body extras.
  DetailModal.tsx                  Modal: image, chart, tags, history, flag button.
  TagFixing/
    TagFixing.tsx                  Shell — owns tile + filter + counts state.
    StatusTiles.tsx                5 tile buttons.
    FilterBar.tsx                  Cascading filters (fetches /api/review/filter-options).
    PendingReview.tsx              Two-column review UI. Keyboard shortcuts. Conflict banner.
    TileGrid.tsx                   Flagged / Ready / Updated / Novision grid. Vision-run progress streaming.
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
4. Parse the JSON response, validate terms against the taxonomy, dedup against existing `approved_tags`, run `expandToIncludeAncestors` to fill in Level-2/Level-1 parents.
5. Write `vision_tags` + metadata, move design to `pending`, log `vision_completed` event.
6. Emit NDJSON progress event per design.

**Concurrency:** 3 in the API route (Sonnet rate limits). The CLI script `scripts/tag-with-vision.ts` defaults to 5 with SDK retries.

**Debugging prompts:** hit `/api/review/vision/debug` — returns the actual assembled system prompt. Useful when Turbopack HMR fails to pick up `lib/vision-prompt.ts` edits.

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

# Shopify sync (the new push of truth)
npx tsx scripts/shopify-pull.ts               # dry-run diff
npx tsx scripts/shopify-pull.ts --apply       # actually write the new shopify_*  / variant_skus / image_url columns
npx tsx scripts/shopify-push.ts               # push approved_tags to Shopify (CLI alternative to the UI button)

# One-offs / cleanup
npx tsx scripts/backfill-theme-columns.ts --apply   # repair theme_names/sub_themes drift on existing rows
npx tsx scripts/reset-readytosend.ts --apply        # move every ready-to-send back to novision
npx tsx scripts/export-ev-product-types.ts          # CSV of products with misconfigured Shopify product_type
npx tsx scripts/audit-non-taxonomy-tags.ts          # find shopify_tags that aren't in FL Themes
npx tsx scripts/audit-not-on-jf.ts                  # find designs without shopify_product_ids
npx tsx scripts/export-non-taxonomy-tags.ts         # CSV of non-taxonomy tags for cleanup
npx tsx scripts/strip-blacklist-tags.ts             # remove blacklisted tags from all designs
```

All scripts use `_supabase-admin.ts` (service-role key, bypasses RLS). `shopify-pull.ts` retries transient errors up to 4 times with exponential backoff before failing. Re-runs are idempotent — drift detection at the top of the update loop skips rows already in sync.

## Deploy (Vercel)

- Vercel project is linked to `ClownAntics/af-tag-review`. Auto-deploys on push to `main`.
- Live URL: `https://af-tag-review.vercel.app`

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

Mirror everything into `.env.local` for local dev. `.env*` is gitignored.

---

## Extending

### Adding another brand / product type
1. Run `supabase/migrations/003_manufacturer.sql` (already done — establishes the column).
2. Extend your catalog ingestion (from af-sales-research or a new import script) to set `manufacturer` explicitly on each row.
3. Manufacturer values auto-appear in the filter dropdown via `/api/review/filter-options`.

### Adding a new review action
1. Add a new case in `app/api/review/design/[design_family]/action/route.ts`'s switch.
2. Log an event with an appropriate `event_type`.
3. Add a label for it in `components/DetailModal.tsx`'s `eventLabel()`.
4. Wire UI button/interaction from `PendingReview.tsx` or wherever.

### Adding a new filter dimension
1. Add the field to `ReviewFilters` in `lib/types.ts` and to `EMPTY_REVIEW_FILTERS`.
2. Update `parseFiltersFromSearch` + `applyReviewFilters` + `toQueryString` in `lib/review-filters.ts`.
3. Add the dropdown to `components/TagFixing/FilterBar.tsx`.
4. Update `/api/review/filter-options` to surface distinct values.

### Changing the vision model / prompt
- **Model:** `VISION_MODEL` constant in `lib/vision.ts`.
- **Default prompt:** `DEFAULT_PROMPT` in `lib/vision-prompt.ts`.
- **Live prompt:** stored in `vision_prompts`, edited via the Edit-vision-prompt modal.

---

## Supabase RLS

Migration 002 allows:
- Public SELECT on `designs`, `sku_variants`, `events`, `vision_prompts`, `design_monthly_sales`
- Anon INSERT on `events`
- Anon UPDATE on `designs` (for the review UI's direct writes)

This is pre-auth MVP territory — tighten before going multi-user. When auth lands, replace `actor = 'blake'` in the action route with the real user identity.

---

## Known gotchas

- **Tags are case-sensitive at storage but lowercase in display.** Storage uses the FL Themes CSV's canonical Search Term (often TitleCase or hyphenated); the UI CSS-lowercases on render. Approve-time merge preserves storage case.
- **Dev server needs a restart to pick up `.env.local` changes.** Next.js loads env at boot.
- **Dropbox + Next.js:** `.next/` and `node_modules/` should be marked Dropbox-ignored (`Set-Content -Path <dir> -Stream com.dropbox.ignored -Value 1` in PowerShell) to prevent EPERM errors mid-build. There are two clones of this repo on Blake's machine (`Dropbox\…\202604 FL Tag Review` and `Projects\af-tag-review\af-tag-review`); the Projects clone is non-Dropbox and safer for `npm run dev`.
- **Windows taskkill /F is in the `.claude/settings.json` deny list** as a safety rail. If dev server won't die on Ctrl+C, you can kill from within PowerShell directly.
- **TeamDesk REST: `/-/` in the URL means cookie auth.** The in-browser Playground generates URLs like `/secure/api/v2/<dbid>/-/<table>/select.json` because it uses the user's session cookie. With a `/-/` present, TeamDesk **ignores the Bearer header** and falls through to cookie auth, then 403s when no session exists. URL form for token auth is `…/secure/api/v2/<dbid>/<table>/select.json` (no `/-/`). Auth header: `Authorization: Bearer <token>` (Bearer prefix required; raw token gets 403 "No such user"). See `CLAUDE.md` for the full debugging story.
- **TeamDesk tokens are database-scoped.** Generate the API token while you're inside the ClownAntics DB (URL bar shows `/db/27503/`), otherwise it auths against a different DB and you get 403.
- **SSR hydration mismatch (React #418) from `localStorage` reads.** Don't read `localStorage` in `useState` initializers — the server-side prerender returns the fallback and the client returns the stored value, producing different initial HTML. Use a stable initial value + `useEffect` to hydrate after mount.
- **Type filter dropdown previously listed the SKU-pattern column** (`product_types` with values "garden"/"house"). It now uses `shopify_product_types` (Shopify's real categories). Both columns still exist; the SKU-pattern one is retained for `lib/product-image.ts`'s `garden-banner` check.
- **`shopify-pull.ts` is the source of truth for `variant_skus` + `image_url`.** Don't try to derive these from SKU patterns. The legacy derivation in `lib/product-image.ts` is a last-resort fallback for pre-migration rows.
