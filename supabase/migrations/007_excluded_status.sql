-- Migration: add `excluded` to the designs.status enum.
--
-- New lifecycle state for designs that are intentionally NOT being reviewed:
-- accessories (poles, brackets, stakes, finials), gift cards, items with
-- broken Shopify product_type values, etc.
--
-- The original CHECK constraint hardcoded the five-status whitelist; Postgres
-- doesn't support modifying a CHECK in place, so we drop and recreate.
--
-- Idempotent: if the constraint already includes `excluded`, the drop is a
-- no-op and the recreate succeeds.

-- The constraint is auto-named by Postgres; find and drop whatever's there.
do $$
declare
  conname text;
begin
  select c.conname
    into conname
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
   where t.relname = 'designs'
     and c.contype = 'c'
     and pg_get_constraintdef(c.oid) ilike '%status%novision%'
   limit 1;
  if conname is not null then
    execute format('alter table designs drop constraint %I', conname);
  end if;
end$$;

alter table designs
  add constraint designs_status_check
  check (status in (
    'novision',
    'flagged',
    'pending',
    'readytosend',
    'updated',
    'excluded'
  ));
