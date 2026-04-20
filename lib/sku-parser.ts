/**
 * SKU parsing for AF (America Forever) brand.
 *
 * Examples:
 *   AFGFSU0419     → garden,        AFSU0419, none
 *   AFHFSU0430     → house,         AFSU0430, none
 *   AFGBSP0004     → garden-banner, AFSP0004, none
 *   AFGFMS0509WH   → garden,        AFMS0509, preprint
 *   AFGFMS0447-CF  → garden,        AFMS0447, personalized
 *   AFGFMS0136M    → garden,        AFMS0136, monogram
 *
 * Returns null for excluded/unrecognised SKUs.
 */

export type ProductType = "garden" | "house" | "garden-banner" | "unknown";
export type Variant = "none" | "preprint" | "personalized" | "monogram";

export interface ParsedSku {
  designFamily: string;
  productType: ProductType;
  variant: Variant;
  themeCode: string;       // 2-letter code after 'AF' in design_family (SP, SU, FA, WR, MS, US, UK, …)
  skuNumber: number;       // numeric tail (e.g. 662 from AFSP0662)
}

const PRODUCT_TYPE_MAP: Record<string, ProductType> = {
  GF: "garden",
  HF: "house",
  GB: "garden-banner",
};

const EXCLUDED_SKUS = new Set(["CUSTOMGARDENSKU", "CUSTOMHOUSESKU"]);

export function parseSku(rawSku: string): ParsedSku | null {
  if (!rawSku) return null;
  const sku = rawSku.trim().toUpperCase();
  if (!sku) return null;
  if (EXCLUDED_SKUS.has(sku)) return null;
  if (!sku.startsWith("AF")) return null;
  if (sku.length < 4) return null;

  // Detect variant suffix and strip it from the working string.
  let body = sku;
  let variant: Variant = "none";

  if (body.endsWith("-CF")) {
    variant = "personalized";
    body = body.slice(0, -3);
  } else if (body.endsWith("WH")) {
    variant = "preprint";
    body = body.slice(0, -2);
  } else if (
    body.length >= 5 &&
    /[A-Z]$/.test(body.slice(-1)) &&
    /[0-9]/.test(body.slice(-2, -1))
  ) {
    // single trailing letter preceded by a digit → monogram
    variant = "monogram";
    body = body.slice(0, -1);
  }

  // body is now AF + 2-char product code + design body
  if (body.length < 4) return null;
  const productCode = body.slice(2, 4);
  const designBody = body.slice(4);

  // Sanity: design body must start with letters then digits.
  const m = /^([A-Z]+)(\d+)$/.exec(designBody);
  if (!m) return null;

  const productType: ProductType = PRODUCT_TYPE_MAP[productCode] ?? "unknown";

  return {
    designFamily: `AF${designBody}`,
    productType,
    variant,
    themeCode: m[1],
    skuNumber: parseInt(m[2], 10),
  };
}
