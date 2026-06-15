-- 011_double_sided.sql
-- "Double Sided" product feature for the storefront Features filter.
-- Distinct from the TeamDesk `isFlag_Reversible?` flag — this one is
-- maintained in Supabase and driven by a derived rule (all AF flags are
-- double-sided by construction: sublimated print reads through both sides).
--
-- Defaulted false so the storefront can filter `is_double_sided = true`.
-- Populated by scripts/set-double-sided.ts after this migration applies.
--
-- Safe to re-run.

alter table designs
  add column if not exists is_double_sided boolean not null default false;

-- Partial index — we only ever query the `true` side for the filter.
create index if not exists idx_designs_double_sided
  on designs(is_double_sided) where is_double_sided = true;
