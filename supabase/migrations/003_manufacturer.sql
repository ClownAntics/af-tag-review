-- Migration: add manufacturer column for multi-brand support.
-- Run in Supabase SQL editor. Idempotent.

alter table designs
  add column if not exists manufacturer text;

-- Backfill: every existing design is America Forever. New imports from other
-- manufacturers should set this field explicitly.
update designs set manufacturer = 'AF' where manufacturer is null;

create index if not exists idx_manufacturer on designs(manufacturer);
