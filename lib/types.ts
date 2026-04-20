export type Classification = "hit" | "solid" | "ok" | "weak" | "dead";

export type ReviewStatus =
  | "novision"
  | "flagged"
  | "pending"
  | "readytosend"
  | "updated";

export interface Design {
  design_family: string;
  design_name: string | null;
  product_types: string[] | null;
  image_url: string | null;
  first_sale_date: string | null;
  last_sale_date: string | null;
  catalog_created_date: string | null;
  date_is_estimated: boolean;
  is_active: boolean;
  theme_code: string | null;
  sku_number: number | null;
  units_total: number;
  units_fl: number;
  units_jf: number;
  units_flamz: number;
  units_fl_fba: number;
  units_fl_walmart: number;
  units_af_etsy: number;
  shopify_tags: string[] | null;
  theme_names: string[] | null;
  sub_themes: string[] | null;
  sub_sub_themes: string[] | null;
  has_preprint: boolean;
  has_personalized: boolean;
  has_monogram: boolean;
  classification: Classification | null;
  // Review pipeline (migration 002)
  status?: ReviewStatus;
  approved_tags?: string[] | null;
  vision_tags?: string[] | null;
  last_reviewed_at?: string | null;
  last_pushed_at?: string | null;
  // Multi-brand support (migration 003)
  manufacturer?: string | null;
}

/** Filters applied on top of the status-tile scope. */
export interface ReviewFilters {
  themeName: string;    // 'all' | <Name>
  subTheme: string;     // 'all' | 'Name: Sub'
  subSubTheme: string;  // 'all' | 'Name: Sub: SubSub'
  tag: string;          // 'all' | <tag>
  productType: string;  // 'all' | <product type>
  manufacturer: string; // 'all' | <manufacturer>
}

export const EMPTY_REVIEW_FILTERS: ReviewFilters = {
  themeName: "all",
  subTheme: "all",
  subSubTheme: "all",
  tag: "all",
  productType: "all",
  manufacturer: "all",
};

export interface FilterOptions {
  themeNames: string[];
  subThemes: string[];
  subSubThemes: string[];
  tags: string[];
  productTypes: string[];
  manufacturers: string[];
}

export interface ReviewCounts {
  flagged: number;
  pending: number;
  readytosend: number;
  updated: number;
  novision: number;
}

export interface ReviewEvent {
  id: string;
  design_family: string;
  event_type: string;
  actor: string | null;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface SkuVariant {
  sku: string;
  design_family: string;
  variant_type: "none" | "preprint" | "personalized" | "monogram";
  product_type: "garden" | "house" | "garden-banner" | "unknown";
}

export interface SummaryCounts {
  total: number;
  hit: number;
  solid: number;
  ok: number;
  weak: number;
  dead: number;
}

export type ViewFilter =
  | "all"
  | "hit"
  | "solid"
  | "ok"
  | "weak"
  | "dead"
  | "patterns"
  | "theme-summary"
  | "planning";

export interface DesignFilters {
  year: string;         // 'all' | '2023' | '2024' | '2025' | '2026'
  tag: string;          // 'all' | <tag>
  productType: string;  // 'all' | 'garden' | 'house' | 'garden-banner'
  themeName: string;    // 'all' | <Name>
  subTheme: string;     // 'all' | 'Name: Sub'
  subSubTheme: string;  // 'all' | 'Name: Sub: SubSub'
  search: string;       // free-text: SKU, design_family, or design_name substring
  view: ViewFilter;
}

export interface DesignsResponse {
  designs: Design[];
  summary: SummaryCounts;
  tags: string[];          // distinct tags for filter dropdown
  productTypes: string[];
  themeNames: string[];
  subThemes: string[];
  subSubThemes: string[];
}
