"use client";

/**
 * Review filter bar. Sits above the status tiles. Filters cascade:
 *   Theme → Sub-theme → Sub-sub-theme
 * Tag / Type / Manufacturer are independent dimensions.
 *
 * Changing any filter triggers a full refresh of both counts and the active
 * tile's queue (via the externalDataVersion bump in the parent).
 */
import { useEffect, useState } from "react";
import {
  EMPTY_REVIEW_FILTERS,
  type FilterOptions,
  type ReviewFilters,
} from "@/lib/types";

interface Props {
  filters: ReviewFilters;
  onChange: (next: ReviewFilters) => void;
}

export function FilterBar({ filters, onChange }: Props) {
  const [options, setOptions] = useState<FilterOptions | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/review/filter-options")
      .then((r) => (r.ok ? r.json() : Promise.reject(r.statusText)))
      .then((d: FilterOptions) => {
        if (!cancelled) setOptions(d);
      })
      .catch(() => {
        // Non-fatal; dropdowns stay empty with just "All …" entries.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const dirty =
    filters.themeName !== "all" ||
    filters.subTheme !== "all" ||
    filters.subSubTheme !== "all" ||
    filters.tag !== "all" ||
    filters.productType !== "all" ||
    filters.manufacturer !== "all";

  // Cascade: sub-theme dropdown is filtered by active theme; sub-sub by sub/theme.
  // The API sorts by full hierarchical string ("Birds: Cardinals"), but the
  // dropdown shows only the trailing segment, so we re-sort here by the
  // visible label to keep the alphabetical order users see consistent across
  // parent groups (otherwise "Beach, Lighthouses, Bluebirds, Cardinals" looks
  // scrambled when no theme is selected).
  const subThemes = options?.subThemes || [];
  const subSubs = options?.subSubThemes || [];
  const subLabel = (s: string) => s.replace(/^[^:]+:\s*/, "");
  const subSubLabel = (s: string) => s.split(": ").slice(-1)[0];
  const filteredSubs = (
    filters.themeName === "all"
      ? subThemes
      : subThemes.filter((s) => s.startsWith(`${filters.themeName}: `))
  )
    .slice()
    .sort((a, b) => subLabel(a).localeCompare(subLabel(b)));
  const filteredSubSubs = (
    filters.subTheme !== "all"
      ? subSubs.filter((s) => s.startsWith(`${filters.subTheme}: `))
      : filters.themeName !== "all"
        ? subSubs.filter((s) => s.startsWith(`${filters.themeName}: `))
        : subSubs
  )
    .slice()
    .sort((a, b) => subSubLabel(a).localeCompare(subSubLabel(b)));

  const update = (next: Partial<ReviewFilters>) =>
    onChange({ ...filters, ...next });

  return (
    <div className="flex flex-wrap gap-2 items-center text-xs text-muted">
      <Select
        label="Manufacturer"
        value={filters.manufacturer}
        onChange={(v) => update({ manufacturer: v })}
        options={[
          { value: "all", label: "All manufacturers" },
          ...(options?.manufacturers || []).map((m) => ({ value: m, label: m })),
        ]}
      />
      <Select
        label="Theme"
        value={filters.themeName}
        onChange={(v) =>
          update({ themeName: v, subTheme: "all", subSubTheme: "all" })
        }
        options={[
          { value: "all", label: "All themes" },
          ...(options?.themeNames || []).map((t) => ({ value: t, label: t })),
        ]}
      />
      <Select
        label="Sub"
        value={filters.subTheme}
        onChange={(v) => update({ subTheme: v, subSubTheme: "all" })}
        options={[
          { value: "all", label: "All sub-themes" },
          ...filteredSubs.map((t) => ({
            value: t,
            label: subLabel(t),
          })),
        ]}
      />
      <Select
        label="Sub-sub"
        value={filters.subSubTheme}
        onChange={(v) => update({ subSubTheme: v })}
        options={[
          { value: "all", label: "All sub-sub-themes" },
          ...filteredSubSubs.map((t) => ({
            value: t,
            label: subSubLabel(t),
          })),
        ]}
      />
      <Select
        label="Tag"
        value={filters.tag}
        onChange={(v) => update({ tag: v })}
        options={[
          { value: "all", label: "All tags" },
          ...(options?.tags || []).map((t) => ({ value: t, label: t })),
        ]}
      />
      <Select
        label="Type"
        value={filters.productType}
        onChange={(v) => update({ productType: v })}
        options={[
          { value: "all", label: "All types" },
          ...(options?.productTypes || []).map((p) => ({ value: p, label: p })),
        ]}
      />
      {dirty && (
        <button
          type="button"
          onClick={() => onChange(EMPTY_REVIEW_FILTERS)}
          className="text-xs text-muted hover:text-foreground px-2 underline decoration-dotted underline-offset-2"
        >
          Clear
        </button>
      )}
    </div>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="flex items-center gap-1.5">
      <span>{label}:</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-card border border-border rounded px-2 py-1 text-xs text-foreground focus:outline-none focus:border-foreground max-w-[200px]"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
