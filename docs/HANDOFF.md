# Tag Review — Handoff

Pick this up cold. This doc covers: what the app is, what's done, what's open, where the landmines are, and how to continue.

---

## What this app is

Claude-vision–assisted Shopify tag curation for FL garden/house flag designs. Companion to [af-sales-research](https://github.com/ClownAntics/af-sales-research) — reads the same Supabase `designs` table and adds a review pipeline on top. Live: (user's Vercel deploy).

Pipeline:
```
No vision yet → Flagged → (Claude vision) → Pending → (human review) → Ready to send → (Shopify push) → Updated
```

The product split is intentional: Sales Research answers "which designs succeeded," Tag Review fixes the tags that feed those answers. They share one Supabase; Sales Research reads, Tag Review writes the review-pipeline columns.

---

## Repo + folder

- GitHub: `ClownAntics/af-tag-review` (repo name doesn't match folder — legacy, leave alone)
- Local: `C:\Users\gbcab\ClownAntics Dropbox\Blake Cabot\Docs\Internet Business\200904 Clown\202604 FL Tag Review\`
- Vercel: auto-deploys on push to `main`

Dropbox + Next.js: `.next/` and `node_modules/` must be Dropbox-ignored (`Set-Content -Path <dir> -Stream com.dropbox.ignored -Value 1`) or builds fail with EPERM.

---

## Stack

- Next.js 16 App Router + Turbopack (dev)
- React 19, Tailwind v4
- Supabase (Postgres, RLS, REST)
- Anthropic SDK (Sonnet 4.6 for vision)
- TypeScript 5, tsx for Node scripts

No state library. Component-local state + URL params.

---

## Data model

### Shared with `af-sales-research`
| table.column | notes |
|---|---|
| `designs` (PK `design_family`) | Core row; AF imports own this |
| `designs.shopify_tags` | Raw Shopify tags (messy reference) |
| `designs.theme_names` / `sub_themes` / `sub_sub_themes` | Derived hierarchical from shopify_tags |
| `designs.product_types`, `units_total`, `classification`, … | Sales Research fields, read-only here |

### Owned by Tag Review (migrations 002 + 003)
| table.column | notes |
|---|---|
| `designs.status` | `novision \| flagged \| pending \| readytosend \| updated` |
| `designs.approved_tags` | Human-curated flat Search Terms |
| `designs.vision_tags` | Claude's raw suggestions (flat Search Terms) |
| `designs.vision_raw` | jsonb: `{primary, reasoning, tags}` from last vision run |
| `designs.last_reviewed_at`, `last_pushed_at` | |
| `designs.manufacturer` | `'AF'` today; migration 003 added it for multi-brand |
| `designs.shopify_product_ids` | `bigint[]` of Shopify product IDs owned by this family. Populated by shopify-pull; consumed by push. Migration 004. |
| `events` | Immutable audit: one row per flag/approve/tag-edit/push |
| `vision_prompts` | Versioned prompt templates (`is_current` flag) |
| `design_monthly_sales` | `(design_family, YYYY-MM) → units` for DetailModal chart |

### Key design decisions

1. **Tags are flat Search Terms from FL Themes** (e.g. `Cardinals`, `Spring-Flowers`, `Halloween-Pumpkins`). The 3-level hierarchy (Name → Sub → Sub-Sub) is display-only. Search Terms are stored case-sensitive; the UI lowercases via CSS to match Shopify's convention.
2. **The taxonomy is baked into `lib/taxonomy.json`** by `scripts/export-taxonomy.ts`. Ships with the app — Vercel doesn't read CSVs at runtime. Re-bake when FL Themes changes in TeamDesk.
3. **Garden + house share tags.** Both variants roll up to one `design_family`. Import union's tags across variants. Phase 6 push preserves admin tags per-product but pushes unified theme tags.
4. **Vision output has structured schema** — `{primary, decoration, reasoning}`. Server-side `expandToIncludeAncestors` fills in parent Search Terms so the stored tag list has the full hierarchy.
5. **Anon Supabase writes.** Migration 002 allows anon UPDATE on designs + INSERT on events. Pre-auth MVP. Tighten when auth lands.

---

## Current functionality (what's shipped)

### Header (top of every page)
- App title + tagline
- **SKU/name search** — accepts variant SKU, bare design_family, or name fragment. Single hit opens detail modal; multiple matches show a dropdown
- Links: Quick start (modal) · User guide · Developer docs · Edit vision prompt

### Tag fixing shell
- **Paste SKUs button** (top right) — bulk-flag by pasting any-format SKU list. Accepts variant SKUs or bare families
- **Pipeline reminder line**
- **Filter bar** — Manufacturer / Theme / Sub / Sub-sub / Tag / Type. Cascading. Filters apply to all tiles and their queues
- **5 status tiles** (clickable), counts reflect filters
- Active tile body:
  - **Pending** → two-column review UI (PendingReview.tsx)
  - **Flagged** → grid + Run vision button + Edit vision prompt link
  - **Ready to send** → grid with approved-tag chips on each card; ⚑ button to re-flag
  - **Updated** → same as Ready to send; ⚑ button to re-flag back through pipeline
  - **No vision yet** → grid; hover to flag; bulk-flag-visible action

### Pending review UI
- Left: flag image (click to flag), design name, SKUs (clickable → JF Shopify admin), stats, classification band, view-full-details link
- Right:
  - **Conflict banner** — surfaces taxonomy-defined conflicts (ConflictsWith column) across approved ∪ vision. Shows `(approved)`/`(vision)` next to each term; click to remove from the right side
  - **Approved tags** section — green pills with × to remove, typeahead to add (fuzzy-ranked against 585-entry taxonomy)
  - **Vision suggestions** — purple pills with ✓ (promote) / × (reject). ⭐ marks Claude's primary pick
  - **Raw Shopify tags** — dashed read-only reference
  - **Vision reasoning** — one-line explanation below the Approved pills (in DetailModal too)
- Footer: Approve / Skip / Flag buttons
- Keyboard: `⏎` Approve, `S` Skip, `A` Accept all vision, `←`/`→` Prev/Next, `F` Flag, `?` Help, `Esc` Close modal

### Detail modal
- Image, 24-month units chart, status-aware tag section ("Tags queued for Shopify push" / "Tags live on Shopify" / "Current Shopify tags"), vision reasoning, full event timeline, Flag button (hidden for flagged/pending to avoid dead action)

### API routes (all under `/api/review/*` + `/api/taxonomy`)
| Route | Purpose |
|---|---|
| `GET /counts` | Count per status, respects filter params |
| `GET /queue` | Paginated designs per status, respects filters |
| `GET /filter-options` | Distinct values for all filter dropdowns (60s revalidate) |
| `GET /lookup?q=` | SKU or name search; 1 match or up to 10 |
| `GET /design/[family]` | Monthly sales + events timeline |
| `POST /design/[family]/action` | flag / approve / accept_vision / reject_vision / update_tags / reset |
| `POST /bulk/flag` | Paste-SKUs bulk flag (accepts bare family or variant SKU) |
| `POST /vision/run` | Stream NDJSON per design as Sonnet tags it |
| `GET/POST/DELETE /vision/prompt` | Load/save/reset prompt template |
| `GET /vision/debug` | Dump current built system prompt (for HMR troubleshooting) |
| `GET /api/taxonomy` | Serve baked `lib/taxonomy.json` |

Each POST writes an events row. Action flow lives in `app/api/review/design/[design_family]/action/route.ts` — notable behaviors:
- `flag` from readytosend/updated clears `approved_tags` (fresh restart)
- `reject_vision` removes from both `vision_tags` AND `approved_tags` (assertive "I don't want this tag")
- `approve` trusts client tags, clears `vision_tags`, stamps `last_reviewed_at`

---

## Vision pipeline

Entry: `POST /api/review/vision/run` with `{design_families: string[]}`. Streams NDJSON events.

1. Load current prompt from `vision_prompts` (or `DEFAULT_PROMPT` in `lib/vision-prompt.ts`). Inject taxonomy via `{{taxonomy}}`.
2. For each design, call Sonnet (4.6). Cached system prompt with ephemeral cache_control.
3. Parse response. Current schema: `{primary, decoration, reasoning}`. Legacy schema `{tags, confidence, notes}` still supported for backward compat.
4. Resolve Search Terms — if Claude emits a label (e.g. `Welcome`) instead of the canonical term (`Welcome-Flags`), the `resolveToTerm` fallback maps it.
5. `expandToIncludeAncestors` fills in Level-2/Level-1 parent terms.
6. Dedup against existing `approved_tags` (so re-review cycles don't show tags already curated).
7. Write `vision_tags` + `vision_raw` + status=pending; log `vision_completed` event.
8. Emit NDJSON progress event per design.

Concurrency: 3 in the API route (Sonnet rate limits). Model in `VISION_MODEL` constant in `lib/vision.ts`.

Debugging: `GET /api/review/vision/debug` returns the actual assembled prompt. Useful when Turbopack HMR fails to pick up `vision-prompt.ts` edits.

---

## Open items

### Prompt tuning (ongoing)
Recent test pass on 10 diverse samples turned up:
1. **Patriotic flags** getting `Stars`/`Stripes`/`Patterns` tags — the flag's iconography IS the flag, not decoration on top of it. Rule 6 added to prompt; verify on re-test.
2. **Plain USA flags** getting `4th-Of-July` — no explicit holiday context in the image. Rule 7 added.
3. **Labels vs Search Terms confusion** — `Welcome` vs `Welcome-Flags`. Fallback resolver added in parser.
4. **Conflict detection** now runs across approved ∪ vision (was approved-only); surfaces in a banner with section labels.

Ongoing risk: prompt compliance with Sonnet is imperfect. Don't fight prompt wording forever — when model errors become rare and predictable, server-side post-processing is the better lever.

### Phase 6 — Shopify push (DONE)

Implemented as a **full-replace** push: every product's tags are overwritten
with its design_family's `approved_tags`. Admin tags like `in-stock`,
`flag-type-garden`, `IncludeInPromotions` are intentionally NOT preserved —
rationale: the FL Themes taxonomy is the source of truth for every Shopify
tag we care about, and preserving an allowlist would fragment that source of
truth. Dry-run CSVs gate first-time runs.

Shipping pieces:
- `lib/shopify.ts` — admin REST wrapper (list products, update tags, retry on 429)
- `scripts/shopify-pull.ts` — populates `shopify_product_ids` + refreshes `shopify_tags`
- `scripts/shopify-push.ts` — CLI dry-run + `--apply`, writes `shopify_push_diff.csv`
- `app/api/review/push/route.ts` — streaming NDJSON push, optional `{design_families: string[]}` body
- Ready-to-send UI: per-card checkbox + "Select all visible" button; Push button label flips to "Push N selected" when anything is checked, else "Push all N"
- `supabase/migrations/004_shopify_product_ids.sql` — adds `bigint[] shopify_product_ids`
- Requires `SHOPIFY_STORE` + `SHOPIFY_ADMIN_TOKEN` (custom-app token w/ `write_products`) in `.env.local` + Vercel

On per-family success: status → updated, `last_pushed_at` stamped, `pushed`
event row logged. On partial failure: status stays readytosend, `push_failed`
event logged with the failed product IDs.

### Other pending UX decisions (not urgent)
- Primary theme always shown ⭐ even when the pill's been demoted? Currently only shows when the exact term matches vision_raw.primary
- Re-flag semantics when user is mid-review in Pending (currently preserves approved_tags; could argue for a choice)

---

## How to run locally

```bash
cd "C:\Users\gbcab\ClownAntics Dropbox\Blake Cabot\Docs\Internet Business\200904 Clown\202604 FL Tag Review"
npm install                 # once
npm run dev                 # http://localhost:3000 (or next free port)
```

`.env.local` must have: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `SHOPIFY_STORE`, `SHOPIFY_ADMIN_TOKEN`.

> **Heads-up** — if you launch `npm run dev` from a shell that has `ANTHROPIC_API_KEY` already exported (empty or otherwise), Next.js will NOT override it from `.env.local`. The vision route will fail with "Missing ANTHROPIC_API_KEY" even though the value is in the file. Fix: `unset ANTHROPIC_API_KEY` in that shell, or start dev from a vanilla terminal.

Restart dev server after editing `.env.local` — Next reads env at boot only.

## Scripts

| Script | Purpose |
|---|---|
| `scripts/export-taxonomy.ts` | Bake FL Themes CSV → lib/taxonomy.json. Re-run when FL Themes changes. |
| `scripts/import-monthly-sales.ts` | Populate design_monthly_sales from TeamDesk invoice CSV. |
| `scripts/shopify-pull.ts` | Pull JFF products, backfill `shopify_product_ids`, refresh `shopify_tags`. Dry-run by default; `--apply` to write. |
| `scripts/shopify-push.ts` | Push `approved_tags` to JFF products for every readytosend family. Dry-run by default; `--apply` to write. |
| `scripts/tag-with-vision.ts` | Batch CLI vision run (uses legacy schema; web app is primary) |
| `scripts/vision-diff.ts` | Shopify-vs-vision CSV export for bulk eyeballing |

All scripts use `_supabase-admin.ts` (service-role, bypasses RLS). CSV paths are hardcoded to `…/202604 AF Research App/`.

## Deploy

Push to `main` → Vercel auto-deploys (~30s). Env vars set in Vercel dashboard mirror `.env.local`. Never put service-role or Anthropic key in a `NEXT_PUBLIC_*` variable.

---

## Known gotchas

1. **Next dev env reload:** restart dev server when you edit `.env.local`.
2. **Turbopack HMR edge cases:** `lib/vision-prompt.ts` edits sometimes don't propagate cleanly. `GET /api/review/vision/debug` confirms what the server actually has loaded.
3. **Supabase service-role client (`lib/supabase-admin.ts`) is server-only** — never import from client components.
4. **Task-wide status transitions** — when `approve` runs, client-side and server-side both trust the client's final `tags` array. If the client has stale state, server uses what was sent. Add cache-busting if you see drift.
5. **Dropbox file locks** — `node_modules` / `.next` must be Dropbox-ignored, otherwise `rmdir` / `find -delete` operations fail intermittently with `Device or resource busy`.

---

## Contact

Questions → Blake Cabot. GitHub issues on `ClownAntics/af-tag-review` work too.
