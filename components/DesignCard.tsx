"use client";

import Image from "next/image";
import type { Design } from "@/lib/types";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatMonthYear(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// Build every variant SKU we know exists for a design family. Garden first,
// then house, then banner — that's the natural reading order on the tile.
// Each entry has the SKU, a short label ("" for garden = default), and the
// full-res image URL (constructed from the SKU using the same pattern
// TeamDesk's `imgLocationFTP500` column uses).
interface VariantSku {
  sku: string;
  label: string;
  imageUrl: string;
}
function variantSkus(design: Design): VariantSku[] {
  const body = design.design_family.replace(/^AF/, "");
  const types = design.product_types || [];
  // Some designs don't have a bare SKU — only suffix variants exist:
  //   monogram      → per-letter SKUs (use "A" as canonical)
  //   personalized  → "-CF" suffix
  //   preprint      → "WH" suffix
  // Pick the most specific suffix in priority order.
  const suffix = design.has_monogram
    ? "A"
    : design.has_personalized
      ? "-CF"
      : design.has_preprint
        ? "WH"
        : "";
  const mk = (sku: string, label: string): VariantSku => ({
    sku,
    label,
    imageUrl: `https://images.clownantics.com/CA_resize_500_500/${sku.toLowerCase()}.jpg`,
  });
  // Always show garden + house — both variants exist in the catalog for the
  // vast majority of designs, even when only one has recorded sales. Broken
  // images on the rare exception are an acceptable trade for completeness.
  // Banner only when product_types explicitly includes it (rare).
  const out: VariantSku[] = [mk(`AFGF${body}${suffix}`, ""), mk(`AFHF${body}${suffix}`, "house")];
  if (types.includes("garden-banner")) out.push(mk(`AFGB${body}${suffix}`, "banner"));
  return out;
}

const JF_ADMIN_SEARCH = "https://admin.shopify.com/store/justforfunflags/products?query=";

// Compute units sold per year of catalog age.
// Start clock = catalog_created_date (preferred) or first_sale_date.
// Floor at 30 days so newly-added designs don't divide by ~zero and explode.
function unitsPerYear(design: Design): number | null {
  if (design.units_total === 0) return 0;
  const start = design.catalog_created_date || design.first_sale_date;
  if (!start) return null;
  const days = Math.max(30, (Date.now() - Date.parse(start)) / 86400000);
  return design.units_total / (days / 365.25);
}

function formatRate(rate: number | null): string {
  if (rate === null) return "";
  if (rate < 1) return `${rate.toFixed(1)}/yr`;
  if (rate < 10) return `${rate.toFixed(1)}/yr`;
  return `${Math.round(rate)}/yr`;
}

export interface DesignCardProps {
  design: Design;
  onOpenDetail?: (design: Design) => void;
  // Optional: override the image click behavior (defaults to onOpenDetail).
  // Used by Tag fixing's No-vision tile where "click to flag" is primary.
  onImageClick?: (design: Design) => void;
  // Optional: className applied to the outer container. Lets callers add
  // status-color borders or rings (e.g. review pipeline states).
  containerClassName?: string;
  // Optional: absolute-positioned elements layered over the image
  // (status badges, × remove button, ⚑ flag button).
  imageOverlay?: React.ReactNode;
  // Optional: hover overlay that covers the image area (e.g. "Flag for tag review").
  hoverOverlay?: React.ReactNode;
  // Optional: content rendered inside the body, between SKU row and stats row
  // (e.g. small tag chips on Ready-to-send cards).
  bodyExtra?: React.ReactNode;
}

export function DesignCard({
  design,
  onOpenDetail,
  onImageClick,
  containerClassName,
  imageOverlay,
  hoverOverlay,
  bodyExtra,
}: DesignCardProps) {
  // Always show catalog Date Created — the design's actual creation date.
  // First-sale date is misleading (it's clamped to the start of our 3-year
  // sales export window for any design that was already selling pre-2023).
  const displayDate = design.catalog_created_date;
  const rate = unitsPerYear(design);

  const variants = variantSkus(design);
  const gardenVariant = variants.find((v) => v.sku.startsWith("AFGF")) || variants[0];

  // Image click: explicit onImageClick wins, else onOpenDetail, else open the
  // full-res file in a new tab (the pre-review-shell fallback).
  const primaryClick = onImageClick ?? onOpenDetail;
  const ImageWrapper: React.ElementType = primaryClick ? "button" : "a";
  const wrapperProps: Record<string, unknown> = primaryClick
    ? {
        type: "button",
        onClick: () => primaryClick(design),
        title: onImageClick
          ? `Click to act on ${design.design_family}`
          : `View ${design.design_family} details & history`,
      }
    : {
        href: gardenVariant.imageUrl,
        target: "_blank",
        rel: "noopener noreferrer",
        title: `Open ${gardenVariant.sku} image`,
      };

  return (
    <div
      className={[
        "bg-card border border-border rounded-lg overflow-hidden",
        containerClassName || "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="relative group">
        <ImageWrapper
          {...wrapperProps}
          className="block aspect-square relative bg-zinc-50 w-full text-left p-0 border-0 cursor-pointer"
        >
          <Image
            src={gardenVariant.imageUrl}
            alt={design.design_name || design.design_family}
            fill
            sizes="(max-width: 768px) 50vw, (max-width: 1200px) 25vw, 200px"
            className="object-cover group-hover:opacity-90 transition-opacity"
            unoptimized
          />
        </ImageWrapper>
        {imageOverlay}
        {hoverOverlay && (
          <div className="absolute inset-0 flex opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
            <div className="m-auto pointer-events-auto">{hoverOverlay}</div>
          </div>
        )}
      </div>
      <div className="p-3 space-y-0.5">
        <div className="text-sm leading-snug line-clamp-2 min-h-[2.5em]">
          {design.design_name || design.design_family}
        </div>
        <div className="text-[11px] font-mono text-muted-2">
          {variants.map((v, i) => (
            <span key={v.sku}>
              {i > 0 && <span className="mx-1 text-muted-2">/</span>}
              <a
                href={`${JF_ADMIN_SEARCH}${v.sku}`}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-foreground hover:underline"
                title={`Open ${v.sku} in JF Shopify admin`}
              >
                {v.sku}
              </a>
            </span>
          ))}
        </div>
        {bodyExtra}
        <div className="flex justify-between text-xs text-muted">
          <span>
            {design.units_total.toLocaleString()} units
            {rate !== null && rate > 0 && (
              <span className="text-muted-2"> · {formatRate(rate)}</span>
            )}
          </span>
          <span title="Catalog Date Created">
            {formatMonthYear(displayDate)}
          </span>
        </div>
      </div>
    </div>
  );
}
