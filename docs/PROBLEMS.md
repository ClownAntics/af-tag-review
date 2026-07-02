# Known problems / cleanup backlog

Running list of data + pipeline issues found during review. Newest concerns at
the top. Status: 🔴 open · 🟡 partial · 🟢 fixed.

---

## 🟡 P1 — SKU collapse merges unrelated designs (banner/doormat) ⭐ high impact
**Update (2026-07):** `parseSku` now splits GB→`AFGB…` and DR→`AFDR…` into
their own families (GF+HF still merge). Migration
`scripts/migrate-split-banner-doormat.ts` ran: 111 flag families trimmed to
GF/HF, 49 banner + 104 doormat families created, **264 designs flagged for
Blake's review**. Remaining: review the flagged set → re-vision the new
banner/doormat + clean any residual pollution on the flags → re-push.

`lib/sku-parser.ts` keys `design_family` as `"AF" + <theme+number>`, **ignoring
the product-type code** (`GF`/`HF`/`GB`/`DR`). Garden + House flags are the same
art (correct to merge), but **Garden-Banner (`GB`) and Doormat (`DR`) with the
same number are frequently a *different* design** — the manufacturer reuses the
number across product lines. Their tags merge into the family and then get
pushed to every variant.

**Confirmed examples:**
- `AFSP0023` "Realistic Easter Bunny" — but `AFGBSP0023` = **"Busy Chipmunks in
  Bloom"** → injects `Squirrels`.
- `AFSP0016` "Patriotic Easter Egg" — but `AFGBSP0016` = **"Easter Cross & Spring
  Flowers"** → injects `Crosses` / `Religious` / `Lilies`. `AFDRSP0016` =
  "Spring Easter Doormat" (also different art).

**Effect:** wrong tags on the flags, and the merged set was already pushed to
Shopify (all variants share the polluted tags).

**Fix (needs sign-off — large):** stop collapsing `GB` and `DR` into the flag
family (give them their own `design_family`), then re-pull → re-tag the newly
separated banner/doormat designs → re-push corrected tags to all products.

---

## 🔴 P3 — Shopify `product_type` inconsistencies vs TeamDesk
Some products carry a singular/typo `product_type` in Shopify that doesn't match
the authoritative TeamDesk Type. Confirmed: `AFMCUS0001WH` = `Mailbox Cover`
(should be `Mailbox Covers: Regular`); ~16 doormats = `Door Mat` (should be
`Doormats: Regular`). Can't auto-resolve from Supabase — the
`td_product."Related Type (ref)"` → `td_type` join key is missing in the mirror
(ref `20140922` has no matching `td_type` row). Fix path: resolve via TeamDesk
API, or add the joinable id to the `td_type` mirror. Safe subset (obvious
singular/plural) can be corrected in Shopify directly.

---

## 🟡 P2 — Cross-occasion decoration pollution in theme filters
Decorations filed under a specific occasion in the taxonomy (`Stars`,
`Fireworks` under `Seasonal: 4th of July`) dragged that occasion's sub-theme
onto unrelated designs (New Year, Christmas). Fixed same-level-1 cases via the
conflict-aware theme recompute (`scripts/recompute-themes-conflict.ts`, 8
designs cleared). **Remaining:** cross-top-level cases (e.g. `Stars` on a
nautical flag) persist because the conflict rule allows cross-theme
decorations — real fix is to move `Stars` out from under `4th of July` in
TeamDesk.

---

## 🔴 P4 — Storefront facets don't reflect our tags
The storefront's Size / Material / Features filters don't populate from the tags
we push (e.g. `Double-Sided` is on ~3,846 live products yet absent from the
Features facet). They're driven by Shopify metafields / a filter-app config we
don't write. Needs storefront-side investigation (metafield namespace vs tag
allowlist).

---

## 🔴 P5 — Catalog reduced to AF-only
Non-excluded catalog is currently ~2,930 (AF only); the non-AF lines
(Evergreen/Carson/etc.) and the material/feature tags applied earlier
(Burlap/Applique/Suede/Eco/…) are no longer in the data. Looks like a reset or
re-pull. Needs confirmation whether intentional.
