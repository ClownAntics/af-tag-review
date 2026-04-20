# Tag Review — Developer Guide

Companion docs to [CLAUDE.md](../CLAUDE.md). This file covers the stack, data model, API surface, component layout, and how to extend the app.

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
| `status` | text (enum) | `novision \| flagged \| pending \| readytosend \| updated` |
| `approved_tags` | text[] | Human-curated Search Terms |
| `vision_tags` | text[] | Claude's raw suggestions (flat Search Terms) |
| `vision_theme_names` / `_sub_themes` / `_sub_sub_themes` | text[] | Legacy hierarchical vision output — kept for historical diff |
| `vision_tagged_at` / `vision_model` / `vision_raw` | timestamptz / text / jsonb | Vision-run metadata |
| `last_reviewed_at` / `last_pushed_at` | timestamptz | |

### Multi-brand column (migration 003)

| column | type | notes |
|---|---|---|
| `manufacturer` | text | `'AF'` for all existing rows; other brands set on import |

### Supporting tables

**`events`** — immutable audit log. One row per review action (flag, approve, tag edit, vision completion, push, etc). Columns: `id`, `design_family`, `event_type`, `actor`, `timestamp`, `payload` (jsonb).

**`vision_prompts`** — versioned prompt templates. `version`, `prompt`, `is_current` (unique where true), `created_at`, `created_by`.

**`design_monthly_sales`** — `design_family × year_month → units`. Populated by `scripts/import-monthly-sales.ts` from the TeamDesk invoice CSV. Feeds the detail-modal bar chart.

### Tag storage convention

All user-facing tags are **flat Search Terms** from FL Themes (e.g. `Cardinals`, `Spring-Flowers`, `Halloween-Pumpkins`). The hierarchy (Name → Sub Theme → Sub Sub Theme) is display-only — the UI lowercases via CSS to match Shopify's convention without mutating storage.

The taxonomy is **baked into `lib/taxonomy.json`** by `scripts/export-taxonomy.ts`. Ships with the app so Vercel has no file dependency. Re-run the script when FL Themes changes in TeamDesk.

---

## API routes

All under `/api/review/*` plus `/api/taxonomy`.

| Route | Method | Purpose |
|---|---|---|
| `/api/review/counts` | GET | Count per status, filtered by query params |
| `/api/review/queue` | GET | Paginated design list per status, filtered |
| `/api/review/filter-options` | GET | Distinct values for all filter dropdowns (60s revalidate) |
| `/api/review/design/[family]` | GET | Monthly sales + events timeline for one design |
| `/api/review/design/[family]/action` | POST | Single mutation endpoint — flag / approve / accept-vision / reject-vision / update-tags / reset |
| `/api/review/bulk/flag` | POST | Bulk flag by SKU list (`{ skus: string[] }`) |
| `/api/review/vision/run` | POST | Stream NDJSON per design as Sonnet tags it |
| `/api/review/vision/prompt` | GET / POST / DELETE | Load / save / reset the vision prompt |
| `/api/review/vision/debug` | GET | Dump the currently-built system prompt (for HMR debugging) |
| `/api/taxonomy` | GET | Serve baked `lib/taxonomy.json` |

### Filter query params (shared by counts + queue)

```
?themeName=<Name>
&subTheme=<Name: Sub>
&subSubTheme=<Name: Sub: SubSub>
&tag=<shopify-tag>
&productType=<garden|house|garden-banner>
&manufacturer=<AF|…>
```

All default to `all` if omitted. Implemented in `lib/review-filters.ts` and applied via `applyReviewFilters(query, filters)`.

### Action body shapes

```ts
{ action: "flag" }
{ action: "approve", tags?: string[] }          // tags override stored approved_tags
{ action: "update_tags", tags: string[] }
{ action: "accept_vision", term: string }
{ action: "reject_vision", term: string }        // removes from BOTH vision_tags AND approved_tags
{ action: "reset" }
```

Every action writes an `events` row. Side effects per action are in `app/api/review/design/[design_family]/action/route.ts`. Notable: `flag` from `readytosend` or `updated` clears `approved_tags` (fresh restart); `approve` trusts the client-supplied tags and clears `vision_tags`.

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
npx tsx scripts/export-taxonomy.ts          # rebake lib/taxonomy.json from FL Themes CSV
npx tsx scripts/import-monthly-sales.ts     # populate design_monthly_sales from TeamDesk invoice CSV
npx tsx scripts/tag-with-vision.ts          # batch vision-tag every design (CLI, bypasses UI)
npx tsx scripts/vision-diff.ts              # export Shopify vs vision CSV for eyeball diff
```

All scripts use `_supabase-admin.ts` (service-role key, bypasses RLS). Paths to CSVs are hardcoded to the `…/202604 AF Research App/` folder — update those constants if your CSVs move.

## Deploy (Vercel)

- Vercel project is linked to `ClownAntics/af-tag-review`. Auto-deploys on push to `main`.
- Env vars in the Vercel dashboard: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`.
- **IMPORTANT:** never ship the service-role key in a `NEXT_PUBLIC_*` variable — it bypasses RLS. It's used only by server-side API routes via `lib/supabase-admin.ts`.

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
- **Dropbox + Next.js:** `.next/` and `node_modules/` should be marked Dropbox-ignored (`Set-Content -Path <dir> -Stream com.dropbox.ignored -Value 1` in PowerShell) to prevent EPERM errors mid-build.
- **Windows taskkill /F is in the `.claude/settings.json` deny list** as a safety rail. If dev server won't die on Ctrl+C, you can kill from within PowerShell directly.
