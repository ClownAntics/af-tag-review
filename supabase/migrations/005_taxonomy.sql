-- Migration: persisted taxonomy + refresh log.
--
-- Until now the taxonomy lived only in lib/taxonomy.json (built at deploy time
-- from a CSV export). The UI can't rewrite that file at runtime on Vercel, so
-- self-serve "Refresh from TeamDesk" needs a mutable store. This migration:
--
--   1. taxonomy_entries — current canonical taxonomy keyed by TeamDesk
--      @row.id (stable across renames). Read by the diff/apply route.
--   2. taxonomy_refresh_log — one row per Apply, for audit/debug.
--   3. tag_renamed / tag_deleted events — the per-design audit trail
--      already fits in the existing `events` table; no schema change there.
--
-- Run in the Supabase SQL editor. Idempotent.

-- ── taxonomy_entries: the live taxonomy ───────────────────────────────────
-- One row per FL Theme entry pulled from TeamDesk. td_row_id is TeamDesk's
-- @row.id and is the stable join key — label / search_term can change while
-- the id stays the same, which is what makes rename detection possible.
create table if not exists taxonomy_entries (
  td_row_id          bigint primary key,
  label              text not null,
  search_term        text,
  notes              text,
  name               text not null,
  sub_theme          text,
  sub_sub_theme      text,
  level              int  not null check (level between 1 and 3),
  is_holiday         boolean not null default false,
  is_occasion        boolean not null default false,
  is_season          boolean not null default false,
  is_business_theme  boolean not null default false,
  is_spring          boolean not null default false,
  is_summer          boolean not null default false,
  is_fall            boolean not null default false,
  is_winter          boolean not null default false,
  is_xmas            boolean not null default false,
  conflicts_with     text[] not null default '{}',
  parent_ref         text,
  parent_label       text,
  updated_at         timestamptz not null default now()
);

create index if not exists idx_tax_search_term on taxonomy_entries(search_term);
create index if not exists idx_tax_level       on taxonomy_entries(level);

-- ── taxonomy_refresh_log: audit one row per apply ─────────────────────────
-- Doesn't fit into `events` because `events.design_family` is non-null and
-- this is a meta record. Kept separate for clarity.
create table if not exists taxonomy_refresh_log (
  id                       uuid primary key default gen_random_uuid(),
  ran_at                   timestamptz not null default now(),
  added_count              int  not null default 0,
  removed_count            int  not null default 0,
  renamed_count            int  not null default 0,
  designs_flagged_count    int  not null default 0,
  designs_renamed_count    int  not null default 0,
  was_bootstrap            boolean not null default false,
  actor                    text
);

create index if not exists idx_tax_refresh_log_ran_at
  on taxonomy_refresh_log(ran_at desc);

-- ── RLS ───────────────────────────────────────────────────────────────────
-- Read is public (UI shows current taxonomy). Writes are server-only via
-- the service-role key, so no insert/update/delete policies for anon.
alter table taxonomy_entries     enable row level security;
alter table taxonomy_refresh_log enable row level security;

drop policy if exists "Public read taxonomy_entries"     on taxonomy_entries;
drop policy if exists "Public read taxonomy_refresh_log" on taxonomy_refresh_log;

create policy "Public read taxonomy_entries"
  on taxonomy_entries     for select to anon, authenticated using (true);
create policy "Public read taxonomy_refresh_log"
  on taxonomy_refresh_log for select to anon, authenticated using (true);
