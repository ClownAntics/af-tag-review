-- Migration: review pipeline for Tag fixing tab.
-- Adds status + approved_tags to designs, an immutable events table,
-- a vision_prompts table, and a monthly-sales table for the detail modal.
--
-- Run in the Supabase SQL editor. Safe to re-run (idempotent).
--
-- Tag model: every tag is a single string matching a `Search Term` from the
-- FL Themes CSV (e.g. "Cardinals", "Halloween-Pumpkins", "Beaches-Nautical").
-- The hierarchical Name / Sub / Sub-sub is display-only — lookups back to
-- Search Terms are done via the CSV, which remains the source of truth.
--
-- Status default is 'novision'. No blanket backfill — the user flags what they
-- want reviewed.

-- ── designs: status + approved tags + last-* timestamps ───────────────────
alter table designs
  add column if not exists status text not null default 'novision'
    check (status in ('novision','flagged','pending','readytosend','updated')),
  add column if not exists approved_tags text[],
  add column if not exists last_reviewed_at timestamptz,
  add column if not exists last_pushed_at   timestamptz;

create index if not exists idx_designs_status on designs(status);

-- ── vision_tags (flat Search-Term form of vision output) ──────────────────
-- The previous vision run stored hierarchical strings in vision_theme_names /
-- vision_sub_themes / vision_sub_sub_themes. Going forward we store flat
-- Search Terms in vision_tags; the hierarchical columns remain as a
-- compatibility layer for the older diff CSV and will be deprecated.
alter table designs
  add column if not exists vision_tags text[];

create index if not exists idx_vision_tags on designs using gin(vision_tags);

-- ── events: immutable audit log ───────────────────────────────────────────
create table if not exists events (
  id              uuid primary key default gen_random_uuid(),
  design_family   text not null references designs(design_family) on delete cascade,
  event_type      text not null,
    -- flagged | vision_started | vision_completed | vision_failed
    -- | approved | pushed | push_failed
    -- | tag_added | tag_removed | tag_promoted | reset
  actor           text,                        -- 'blake' (hardcoded pre-auth) or 'system'
  timestamp       timestamptz not null default now(),
  payload         jsonb not null default '{}'::jsonb
);

create index if not exists idx_events_design on events(design_family, timestamp desc);
create index if not exists idx_events_type   on events(event_type, timestamp desc);

-- ── vision_prompts: editable prompt template, versioned ───────────────────
create table if not exists vision_prompts (
  id              uuid primary key default gen_random_uuid(),
  version         int  not null,
  prompt          text not null,
  created_at      timestamptz not null default now(),
  created_by      text,
  is_current      boolean not null default false
);

create unique index if not exists idx_vision_prompts_version on vision_prompts(version);
create unique index if not exists idx_vision_prompts_current on vision_prompts(is_current) where is_current = true;

-- ── design_monthly_sales: feeds the detail-modal bar chart ────────────────
-- Populated by an import script from the TeamDesk invoice CSV; empty for now.
create table if not exists design_monthly_sales (
  design_family text not null references designs(design_family) on delete cascade,
  year_month    text not null,               -- 'YYYY-MM'
  units         int  not null default 0,
  primary key (design_family, year_month)
);

create index if not exists idx_dms_design on design_monthly_sales(design_family, year_month);

-- ── RLS ───────────────────────────────────────────────────────────────────
alter table events               enable row level security;
alter table vision_prompts       enable row level security;
alter table design_monthly_sales enable row level security;

drop policy if exists "Public read events"               on events;
drop policy if exists "Public read vision_prompts"       on vision_prompts;
drop policy if exists "Public read design_monthly_sales" on design_monthly_sales;

create policy "Public read events"               on events               for select to anon, authenticated using (true);
create policy "Public read vision_prompts"       on vision_prompts       for select to anon, authenticated using (true);
create policy "Public read design_monthly_sales" on design_monthly_sales for select to anon, authenticated using (true);

-- Browser-based review UI needs to update designs + insert events via the
-- anon key. Pre-auth MVP choice; tighten when auth lands.
drop policy if exists "Anon update review fields" on designs;
create policy "Anon update review fields"
  on designs for update
  to anon, authenticated
  using (true)
  with check (true);

drop policy if exists "Anon insert events" on events;
create policy "Anon insert events"
  on events for insert
  to anon, authenticated
  with check (true);
