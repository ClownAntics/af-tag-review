@AGENTS.md

# Workflow preferences

**Always push after a change.** When I (Claude) make any code change on this
repo, immediately commit and push to `origin/main` without waiting to be
asked. Vercel's auto-deploy depends on it, and Blake doesn't want to have to
prompt for it each time. Exception: if changes are clearly mid-flight (e.g.
I'm still iterating on a multi-file edit and haven't verified it yet),
finish the coherent unit first, then commit + push.

# TeamDesk REST API — gotchas (learned the hard way)

The FL Themes taxonomy lives in TeamDesk. Our integration burned a few
hours on these — write them down so the next session doesn't repeat:

- **Account is `clownantics`**, DB id is `27503`, FL Theme table is
  referenced by its **singular name `FL Theme`** (URL-encoded to
  `FL%20Theme`). URL host: `https://clownantics.teamdesk.net`. The
  `www.teamdesk.net` host returns 400 "Database does not exist" for our DB
  — always use the account subdomain.
- **The table segment is the singular name or alphanumeric alias** as
  returned by Describe — NOT the numeric internal id. Both `236519` and
  `t_236519` return 400 "Table does not exist". See the Select (Table)
  method docs at https://www.teamdesk.net/help/rest-api/.
- **Auth header is `Authorization: Bearer <token>`** — with the Bearer
  prefix. Bare token (`Authorization: <token>`) and query-string form
  (`?Authorization=<token>`) both return 403 "No such user".
- **The `/-/` segment in the URL means cookie-auth.** TeamDesk's in-browser
  REST Playground generates URLs like `/secure/api/v2/27503/-/FL%20Theme/...`
  because it uses the browser's logged-in session cookie. With a `/-/`
  present, TeamDesk **ignores the Bearer header and falls through to cookie
  auth**, then 403s when no session exists. The fix: drop `/-/` for token
  requests. Correct shape:
  `https://clownantics.teamdesk.net/secure/api/v2/27503/FL%20Theme/select.json`
- Token-in-URL form (`/<dbid>/<token>/<table>/select.json`) is also
  documented and works without any header. We use the Bearer header; it's
  cleaner for env-var-driven config.
- **`select.json` caps responses at `top=500`** (default and max). FL Theme
  is ~700 rows, so we paginate with `skip=` until a short page comes back.
  Skipping this silently truncates and the taxonomy diff shows phantom
  "deletions" for everything past row 500.
- Per-database scoping: tokens are bound to the database they were created
  in. To create a new token for db 27503, navigate to a page within that
  DB first (URL bar should show `/db/27503/`), then Setup → Integration
  APIs → NEW.

Env vars (in Vercel + `.env.local`):
- `TEAMDESK_API_TOKEN` — the 32-char hex token (mark Sensitive in Vercel)
- `TEAMDESK_ACCOUNT` — `clownantics`
- `TEAMDESK_DB_ID` — `27503`
- `TEAMDESK_TABLE_ID` — `FL Theme` (singular name; the code URL-encodes it.
  Numeric ids like `236519` / `t_236519` return 400 "Table does not exist".)
- `TEAMDESK_VIEW_URL` — browser URL for the "Open ↗" button

Implementation: `lib/teamdesk.ts`. Settings UI: `components/SettingsModal.tsx`.

# Tag Review — project notes

Standalone companion to `af-sales-research`. Purpose: **curate Shopify tags on
FL design products using Claude-vision suggestions + human review.**

Scope today: AF garden/house flags (what's already in the shared `designs`
table). Scope goal: any FL brand, any FL product type — the UI is deliberately
brand/product-agnostic, ingest pipelines ultimately decide what shows up.

---

## Pipeline

```
Flagged → (vision runs) → Pending → (human review) → Ready to send → (push) → Updated
```

- **Flagged** — user marked for re-review; vision hasn't run yet.
- **Pending** — vision completed; awaiting human curation.
- **Ready to send** — human approved; queued for Shopify push.
- **Updated** — Shopify push succeeded; tags are live.
- **No vision yet** — off to the side; designs never run through the pipeline.

Status is a single `designs.status` column driven by `/api/review/design/[family]/action`.

---

## Data model (shared with af-sales-research)

The `designs` table is shared. Tag Review adds columns + tables (see
`supabase/migrations/002_review_pipeline.sql`):

- `designs.status` — enum (novision / flagged / pending / readytosend / updated)
- `designs.approved_tags text[]` — the human-curated set
- `designs.vision_tags text[]` — Claude's raw suggestions, flat Search Terms
- `designs.last_reviewed_at`, `designs.last_pushed_at`
- `events` — immutable audit log (one row per flag / approve / tag edit / etc.)
- `vision_prompts` — versioned Claude-prompt templates
- `design_monthly_sales` — populated by `scripts/import-monthly-sales.ts`, feeds
  the detail-modal bar chart

Sales research is read-only against `designs`, doesn't know these columns exist.

---

## Tag storage convention

**Flat Search Terms from the FL Themes CSV** — e.g. `Cardinals`, `Spring-Flowers`,
`Halloween-Pumpkins`. The hierarchy (Name → Sub Theme → Sub Sub Theme) is
display-only, not a storage format. The CSV's `Search Term` column is authoritative.

Display: all tag pills use `text-transform: lowercase` so the UI matches
Shopify's lowercase convention without having to mutate data on write.

Taxonomy is baked into `lib/taxonomy.json` by `scripts/export-taxonomy.ts` —
re-run that any time FL Themes changes in TeamDesk. That JSON ships with the app
(Vercel has no file access).

---

## Review actions (POST /api/review/design/[family]/action)

Body shapes:
- `{ action: "flag" }` — novision/ready/updated → flagged. Flagging from
  ready/updated also clears approved_tags (fresh start).
- `{ action: "approve", tags: string[] }` — pending → readytosend. Tags must be
  the final set the client wants saved.
- `{ action: "update_tags", tags: string[] }` — edit approved_tags without
  status change.
- `{ action: "accept_vision", term: string }` — move one term from vision → approved.
- `{ action: "reject_vision", term: string }` — remove from BOTH vision_tags
  and approved_tags (assertive "I don't want this tag").
- `{ action: "reset" }` — back to novision (testing/debug).

Every action writes an `events` row.

---

## Vision

- Model: **Claude Sonnet 4.6** (see `lib/vision.ts` `VISION_MODEL`)
- Default prompt: `lib/vision-prompt.ts` — edit there for UI-editable prompt
  fallback; in-DB custom prompts live in `vision_prompts` and win when present.
- Hierarchy expansion (`lib/vision.ts` `expandToIncludeAncestors`) adds Level-2
  and Level-1 parents when Claude returns a Level-3 Search Term.
- Dedup: vision-run filters out tags already in `approved_tags` so the UI
  doesn't show overlap between sections on re-review cycles.
- Rate limits: default concurrency 3 in the API route, CLI script defaults to 5
  with SDK retries for 429s.

Diagnostic: `GET /api/review/vision/debug` returns the currently-built system
prompt so HMR issues can be verified.

---

## Conflict detection

`scripts/export-taxonomy.ts` parses the FL Themes `ConflictsWith` column and
expands `All Seasons` / `All Holidays` meta-tokens. The taxonomy JSON ships with
`conflicts: string[]` per entry. `findConflicts()` in
`components/TagFixing/TaxonomyTypeahead.tsx` surfaces pairs, shown as an amber
banner above Approved tags, and also blocks Approve with a confirm() if any
conflict survives into the merged approved set.

---

## Supabase pattern

- Browser + API route use the **anon key**. RLS policies (see
  `supabase/migrations/002_review_pipeline.sql`) allow public SELECT + anon
  INSERT/UPDATE for the review pipeline. Tighten when auth lands.
- `scripts/_supabase-admin.ts` — service-role client for Node scripts.
- `lib/supabase-admin.ts` — service-role client for server-side API routes
  (needed for vision-run to bypass RLS when writing events for many designs).

---

## Visual target

Inherits from af-sales-research: `#fafafa` background, white cards, 1px borders,
`rounded-lg`, muted greys, no shadows, no gradients. Flat.
