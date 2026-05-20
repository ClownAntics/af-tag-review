-- Migration: store actual Shopify variant SKUs per design family.
--
-- We've been DERIVING display SKUs from a strict AF regex pattern
-- ("AFGF" + region + 4 digits). Anything that doesn't match — like the new
-- burlap line (afgfms-b-0001) — produces garbled doubled-prefix output
-- (AFGFafgfms-b-0001) and a broken image URL.
--
-- Fix: pull the actual variant SKUs from Shopify and store them. The image
-- URL gets the same treatment — designs.image_url already exists but is
-- mostly null; shopify-pull will populate it from product.image.src.
--
-- Idempotent.

alter table designs
  add column if not exists variant_skus text[] not null default '{}';
