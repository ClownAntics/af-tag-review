# Tag Review — Handoff

Pick this up cold. This doc covers: what the app is, what's done, what's open, where the landmines are, and how to continue.

Last updated: end of the iteration cycle that shipped commit `f7e7456` — see "Recent decisions captured" near the bottom for the design choices baked into the current state.

---

## What this app is

Claude-vision–assisted Shopify tag curation for FL garden/house flag designs. Companion to [af-sales-research](https://github.com/ClownAntics/af-sales-research) — reads the same Supabase `designs` table and adds a review pipeline on top.

Pipeline:
```
No vision yet → Flagged → (Claude vision) → Pending → (human review) → Ready to send → (Shopify push) → Updated
```

Sales Research answers "which designs succeeded," Tag Review fixes the tags that feed those answers. They share one Supabase; Sales Research reads, Tag Review writes the review-pipeline columns.

---

## Repo + folder + deploy

- GitHub: `ClownAntics/af-tag-review` (repo name doesn't match folder — legacy, leave alone)
- Local: `C:\Users\gbcab\ClownAntics Dropbox\Blake Cabot\Docs\Internet Business\200904 Clown\202604 FL Tag Review\`
- Vercel: `af-tag-review.vercel.app` — auto-deploys on push to `main`

Dropbox + Next.js: `.next/` and `node_modules/` must be Dropbox-ignored (`Set-Content -Path <dir> -Stream com.dropbox.ignored -Value 1` in PowerShell) or builds fail with EPERM.

---

## Stack

- Next.js 16 App Router + Turbopack (dev)
- React 19, Tailwind v4
- Supabase (Postgres, RLS, REST)
- Anthropic SDK (Sonnet 4.6 for vision)
- Shopify Admin REST 2025-01
- TypeScript 5, tsx for Node scripts

No state library. Component-local state + URL params.

---

## Data model

### Shared with `af-sales-research` (read-only here)
| Column | Notes |
|---|---|
| `designs.design_family` (PK) | `AFSP0278`-style |
| `designs.design_name` | |
| `designs.product_types` | `['garden','house']` |
| `designs.shopify_tags` | Snapshot from last shopify-pull |
| `designs.theme_names` / `sub_themes` / `sub_sub_themes` | Hierarchical derived from shopify_tags |
| `designs.units_total` / `units_*` / `classification` / `catalog_created_date` / etc. | Sales/catalog data |
| `designs.has_monogram` / `_personalized` / `_preprint` | SKU variant flags |

### Owned by Tag Review (migrations 002 + 003 + 004)
| Column | Notes |
|---|---|
| `designs.status` | `novision \| flagged \| pending \| readytosend \| updated` |
| `designs.approved_tags` | Human-curated flat Search Terms — **source of truth for push** |
| `designs.vision_tags` | Claude's raw suggestions (flat Search Terms) |
| `designs.vision_raw` | jsonb: `{primary, reasoning, tags}` — primary feeds the ⭐ in the UI |
| `designs.vision_tagged_at` / `vision_model` | |
| `designs.last_reviewed_at` / `last_pushed_at` | |
| `designs.manufacturer` | `'AF'` today; multi-brand future (decision: stay AF-specific for now per Q23) |
| `designs.shopify_product_ids` | bigint[] of Shopify product IDs that share this design_family. Populated by `shopify-pull.ts`, consumed by `shopify-push.ts`. |
| `designs.monthly_sales` | jsonb `[{m:"YYYY-MM", u:int}]` for DetailModal chart |
| `events` | Immutable audit. Cols: id, design_family, event_type, actor, timestamp, payload jsonb |
| `vision_prompts` | Versioned prompt templates, `is_current` unique partial index |

### Key design decisions (durable)

1. **Tags are flat Search Terms from FL Themes.** Hierarchy is display-only. UI lowercases via CSS to match Shopify; storage is canonical-case.
2. **Taxonomy baked into `lib/taxonomy.json`** by `scripts/export-taxonomy.ts`. Re-run when FL Themes changes in TeamDesk.
3. **Garden + house share tags.** Both variants roll up to one `design_family`. Push preserves admin tags per-product but writes unified theme tags.
4. **Vision output schema:** `{primary, decoration, reasoning}`. Server-side `expandToIncludeAncestors` fills parent terms. Legacy `{tags, confidence, notes}` schema also supported by parser for back-compat.
5. **Label resolver fallback** — when Claude emits a label like `Welcome` instead of the canonical Search Term `Welcome-Flags`, parser maps it via case-insensitive label/name lookup.
6. **Anon Supabase writes.** Migration 002 allows anon UPDATE on designs + INSERT on events. Pre-auth MVP. Auth deferred per Q7 decision.

---

## What's shipped

### Header
- Title + tagline
- **SKU/name search** (`SkuSearch`) — accepts variant SKU, bare design_family, or name fragment. Single SKU hit opens detail modal; multiple name matches show a dropdown.
- Nav links: **Quick start** (modal) · User guide · Developer docs · **Edit vision prompt** (modal)

### Tag fixing shell
- **Paste SKUs** button (top right) — bulk-flag by pasting any-format SKU list. Accepts variant SKUs **or** bare families.
- Pipeline reminder line
- **Filter bar** — Manufacturer / Theme / Sub / Sub-sub / Tag / Type. Cascading. Counts + queues filter together.
- **5 status tiles** (clickable), counts reflect filters
- Per-tile body:
  - **Pending** → two-column review UI (`PendingReview.tsx`)
  - **Flagged** → grid + Run vision + Edit vision prompt link + Clear all
  - **Ready to send** → grid with approved-tag chips on each card; ⚑ button to re-flag; checkboxes for multi-select push
  - **Updated** → same grid; ⚑ button re-flags back through pipeline
  - **No vision yet** → grid; click card opens detail; ⚑ button flags

### Pending review UI
- Left: image (click → detail modal, hover overlay shows "View details & history"); design name; SKUs (clickable → JF Shopify admin); stats; classification band
- Right:
  - **Conflict banner** — surfaces taxonomy conflicts (`ConflictsWith` column, expanded for `All Seasons`/`All Holidays`) across **approved ∪ vision**. Each side labeled `(approved)`/`(vision)`. Click to remove from the right section.
  - **Approved tags** — green pills with × to remove; ⭐ on the primary; typeahead to add (fuzzy-ranked, 585-entry taxonomy)
  - **Vision suggestions** — purple pills with ✓ promote / × reject (× also removes from approved if present); ⭐ on primary
  - **Raw Shopify tags** — dashed read-only reference
  - **Vision reasoning** sentence below Approved
- Footer: Approve / Skip / Flag
- Keyboard: `⏎` Approve · `S` Skip · `A` Accept all vision · `←`/`→` Prev/Next · `F` Flag · `?` Help · `Esc` Close

### Detail modal
- Image, 24-month sales chart from `designs.monthly_sales` jsonb, status-aware tag heading ("Tags queued for Shopify push" / "Tags live on Shopify" / "Approved tags (draft)" / "Current Shopify tags"), ⭐ on primary, vision reasoning, full event timeline, status-conditional Flag button.

### API routes (all under `/api/review/*` + `/api/taxonomy`)
| Route | Notes |
|---|---|
| `GET /counts` | per-status, respects filters |
| `GET /queue` | paginated; **per-tile sort orders** baked in (Pending: `vision_tagged_at` desc; Ready: `last_reviewed_at` desc; Updated: `last_pushed_at` desc; No-vision: alpha by name; Flagged: catalog_created_date desc) |
| `GET /filter-options` | distinct values for dropdowns; 60s revalidate |
| `GET /lookup?q=` | SKU or name search; single-hit or up to 10 |
| `GET /design/[family]` | monthly chart + events timeline |
| `POST /design/[family]/action` | `flag` / `approve` / `accept_vision` / `reject_vision` / `update_tags` / **`unflag`** / `reset` |
| `POST /bulk/flag` | paste-SKUs flag (accepts bare family or variant SKU) |
| `POST /vision/run` | streams NDJSON per design; concurrency 3, SDK retries |
| `POST /push` | streams NDJSON per design to Shopify; idempotent on `status=readytosend` |
| `GET/POST/DELETE /vision/prompt` | load/save/reset vision prompt |
| `GET /vision/debug` | dump assembled system prompt (HMR diagnostic) |
| `GET /api/taxonomy` | serve baked `lib/taxonomy.json` |

Action notable behaviors:
- **`flag`** from readytosend/updated clears approved_tags + vision_tags (fresh restart). From novision/pending preserves them.
- **`unflag`** (NEW) from flagged → novision **without** wiping vision/approved — used by Clear All on Flagged and × on a flagged card.
- **`approve`** trusts client-supplied `tags`; clears vision_tags; stamps last_reviewed_at.
- **`reject_vision`** removes term from BOTH vision_tags AND approved_tags (assertive "I don't want this tag").

---

## Vision pipeline

Entry: `POST /api/review/vision/run` with `{design_families: string[]}`.

1. Load current prompt from `vision_prompts` (where `is_current = true`); fall back to `DEFAULT_PROMPT` in `lib/vision-prompt.ts`.
2. `buildSystemPrompt()` injects taxonomy via `{{taxonomy}}`.
3. Per design: cached system prompt (ephemeral cache_control) + image URL + tag-this user message.
4. Parse response. New schema preferred: `{primary, decoration, reasoning}`. Legacy `{tags, confidence, notes}` supported.
5. Resolve Search Terms via `resolveToTerm` (handles label-instead-of-term cases like `Welcome` → `Welcome-Flags`).
6. `expandToIncludeAncestors` fills parent terms (Roses → Spring-Flowers + Flowers).
7. Dedup against existing `approved_tags` so re-review cycles don't double-show.
8. Write `vision_tags` + `vision_raw` + status=pending. Log `vision_completed` event.
9. Emit NDJSON event per design.

**Concurrency:** 3 in API route. CLI `tag-with-vision.ts` uses 5 with SDK retries (legacy schema; web app is primary).

**UI**: progress bar + Cancel button (aborts AbortController; already-completed designs stay in pending).

**Soft cap**: confirm dialog above 100 designs with cost (~$0.006 each) + time (~3s each at concurrency 3) estimates.

**Diagnostic**: `GET /api/review/vision/debug` returns the actual assembled prompt — useful when Turbopack HMR fails to pick up `lib/vision-prompt.ts` edits.

---

## Shopify push (Phase 6)

API + UI both wired. Auth deferred (anon can call /api/review/push today — fine pre-multi-user).

`POST /api/review/push` with `{design_families?: string[]}`:
- omitted/empty → push every design with `status=readytosend` (filtered by query if invoked from selection)
- streams NDJSON: `start` / `ok` / `error` / `skipped` / `done`
- per-family: parallel updates across product variants (2-5 each for AF)
- on partial failure: marks `push_failed` event, leaves design in `readytosend`, **continues with others** (per Q28)
- on full success per family: `status → updated`, `last_pushed_at` stamped, `pushed` event logged with tag count and product IDs
- idempotent: re-running re-queries `status='readytosend'` so already-pushed designs are skipped

UI: confirm() dialog before push (Q9 — could be upgraded to a richer modal); progress bar; success/error toast on completion (`<Toast>` component; per Q20 push-only, not on per-design approve).

---

## Recent decisions captured (Q1–Q29 in chronological order)

These are the design choices the user signed off on during the latest decision pass. Don't undo without asking.

| # | Decision |
|---|---|
| ⭐ behavior | Dynamic — star follows vision's latest pick; doesn't persist if tag is removed |
| Re-flag from Pending | Preserves approved_tags (only readytosend/updated re-flag clears) |
| Auth | Deferred — open app for now |
| Undo | Deferred — leverage existing `reset` action when needed |
| Scheduled Shopify pull | Manual only |
| Drift detection | Ignore (trust Tag Review as source of truth) |
| Vision-run cap | Soft cap with cost+time confirm above 100 |
| Taxonomy resilience | Trust the human (no schema check) |
| Vision cancel | Add visible Cancel button |
| Push idempotence | Status-based (re-running is safe) |
| Push concurrency | 2 req/sec target (Shopify standard plan limit) — verify in `lib/shopify.ts` |
| Push toast | On push only, not per-approve |
| Image click in Pending | Opens detail modal (was flag); F key still flags |
| Filter bar | Stays above tiles (current placement) |
| Multi-brand | Stay AF-specific for now (no SKU parser / image-URL generalization) |
| Multi-select | Bulk-flag-selected only; persists across pagination |
| Sort orders | Per-tile most-recent (vision/reviewed/pushed); No-vision alpha by name |
| Push preview | Modal, but currently a confirm() — fine for now |
| Push mid-batch failure | Keep others in readytosend, mark failed as push_failed |
| Bulk approve | Status quo, one at a time (no bulk-approve-all action) |
| Keyboard hints | Status quo (`?` in nav row, kbd badges on primary buttons) |
| Ops monitoring | None |
| Export CSV | Defer |
| Clear All on Flagged | Preserves vision/approved (uses new `unflag` action) |
| Toast on approve | No (silent — design moves tile, that's the feedback) |
| Vendor filter | Yes, ship now (manufacturer column already added — only "AF" today) |
| Quick start modal | Shipped — header link, 4-step primer |

---

## Open items

### Phase 6 polish (not blocking)
- **Richer push preview modal** — currently a `confirm()`. Could list "N designs, K tags changing, X admin tags preserved" before committing. Q9 was answered "yes always confirm" — confirm() satisfies; modal is just nicer.
- **Verify push concurrency** in `lib/shopify.ts` — Q19 says 2 req/sec target. Whatever's there now might already be OK; needs eyeballing.

### Prompt tuning (ongoing)
- Latest 10-sample test pass turned up: USA flags getting `Stars`/`Stripes` (rule 6 fix added), plain USA getting `4th-of-july` (rule 7 fix added), `Welcome` vs `Welcome-Flags` (resolver fallback added), conflict detection across approved ∪ vision (now extended). All shipped in commit `f7e7456`.
- **Risk**: Sonnet compliance is imperfect. Prompt iteration has diminishing returns. After this round, lean on server-side post-processing for systematic errors.

### Operations
- **Scheduled Shopify pull** — Q12 answered manual-only, so no cron right now. Revisit if new products start appearing more often than weekly.
- **TeamDesk refresh automation** — still manual CSV exports every ~2 weeks. Stretch goal.

### Multi-brand (future)
- Stay AF-specific per Q23. When non-AF brands actually arrive: SKU parser, image URL pattern (`lib/product-image.ts` exists), Shopify store handle, taxonomy scope all need re-evaluation.

---

## How to run locally

```bash
cd "C:\Users\gbcab\ClownAntics Dropbox\Blake Cabot\Docs\Internet Business\200904 Clown\202604 FL Tag Review"
npm install                 # once
npm run dev                 # http://localhost:3000 (or next free port)
```

`.env.local` keys: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `SHOPIFY_STORE`, `SHOPIFY_ADMIN_TOKEN`.

Restart dev server after editing `.env.local` — Next reads env at boot only.

## Scripts

| Script | Purpose |
|---|---|
| `shopify-pull.ts` | Fetch JFF products → update shopify_tags + populate shopify_product_ids; insert new families as novision. `--apply` to write. |
| `shopify-push.ts` | CLI version of the API push. Same shape. |
| `import-monthly-sales.ts` | Aggregate invoice CSV → `designs.monthly_sales` jsonb |
| `export-taxonomy.ts` | Bake FL Themes CSV → `lib/taxonomy.json` |
| `tag-with-vision.ts` | Batch CLI vision (legacy schema; UI is primary) |
| `vision-diff.ts` | Shopify-vs-vision CSV export |

All scripts use `_supabase-admin.ts` (service-role).

## Deploy

Push to `main` → Vercel auto-deploys (~30s). Env vars set in Vercel dashboard mirror `.env.local`. Never put service-role or Anthropic key in `NEXT_PUBLIC_*`.

---

## Known gotchas

1. **Dev server reload** — restart Next when you edit `.env.local`. Boot-time env only.
2. **Turbopack HMR** sometimes misses `lib/vision-prompt.ts` edits — `GET /api/review/vision/debug` confirms what's loaded.
3. **`lib/supabase-admin.ts` is server-only** — never import from client components.
4. **Approve trusts client-side tags** — if the client has stale state, server uses what it sent. `key={...filterQs}` on TileGrid/PendingReview keeps state fresh on filter changes.
5. **Dropbox file locks** — `node_modules` and `.next` must be Dropbox-ignored.
6. **Windows Powershell `taskkill /F`** is in `.claude/settings.json` deny list as a safety rail. Use the actual PowerShell terminal directly when stale dev servers won't die.

---

## Companion docs

- [USER_GUIDE.md](./USER_GUIDE.md) — how to use the app
- [DEVELOPER.md](./DEVELOPER.md) — architecture deep-dive
- [TECH_SPEC.md](./TECH_SPEC.md) — data integration spec for Dinesh

Questions → Blake.
